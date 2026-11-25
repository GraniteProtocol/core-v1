// repay used to sync only the debt bucket. The repayment still raises state-v1's balance, so the
// next LP withdrawal sized its ceiling from the post-repay liquidity and could spend up to 20% of
// the repaid amount above the intended window cap. repay now syncs the LP bucket before the caller
// credits state-v1, mirroring lp-deposit.

import { Cl, ClarityValue, contractPrincipalCV } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  build_price_update,
  getSimnetBlockTime,
  init_pyth,
  set_initial_price,
  set_pyth_time_delta,
} from "./pyth";
import {
  MINIMUM_INITIAL_DEPOSIT,
  add_collateral,
  borrow,
  deposit,
  initialize_ir,
  initialize_lp,
  initialize_staking_reward,
  mint_token,
  set_allowed_contracts,
  set_asset_cap,
  update_supported_collateral,
} from "./utils";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const attacker = accounts.get("wallet_2")!; // both LP and borrower
const depositor = accounts.get("wallet_1")!; // LP and liquidator
const borrower = accounts.get("wallet_2")!;

const SCALING = 100_000_000n;
// Live USDCx values.
const LP_CAP_FACTOR = 20_000_000n; // 20%
const DEBT_CAP_FACTOR = 20_000_000n; // 20%
const REFILL_WINDOW = 36_000n; // seconds
const DECAY_WINDOW = 10_800n; // seconds

const USDC = 100_000_000n; // simnet mock-usdc is 8 decimals
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
const repay = () =>
  simnet.callPublicFn(
    "borrower-v1",
    "repay",
    [Cl.uint(BORROW), Cl.none()],
    attacker
  );
const setCap = (fn: string, value: bigint) =>
  ok(simnet.callPublicFn("withdrawal-caps-v1", fn, [Cl.uint(value)], deployer));
const setWindows = () => {
  setCap("set-refill-time-window", REFILL_WINDOW);
  setCap("set-decay-time-window", DECAY_WINDOW);
};
const findPrint = (res: any, action: string) =>
  res.events
    .map((e: any) => e.data?.value?.value)
    .find((v: any) => v?.["action"]?.value === action);

// Shared setup: live caps, a 2,000 USDC LP position that is also a 200 USDC
// borrower, and (where the LP cap is enabled) a full refill window since the
// last LP bucket sync.
const setupAttacker = async (lpCapFactor: bigint, debtCapFactor: bigint) => {
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

  // Caps are set before the attacker's deposit so lp-deposit's syncs use the
  // pre-deposit balance.
  setCap("set-lp-cap", lpCapFactor);
  setCap("set-debt-cap", debtCapFactor);
  setWindows();

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

  // Past a full refill window, so the debt bucket refills and, where the LP cap
  // is enabled, the refill window since lp-deposit's LP sync has elapsed.
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

// Liquidation setup: a large LP position plus a 1,000 USDC borrower whose
// position is dropped below its liquidation LTV.
const setupLiquidation = async () => {
  init_pyth(deployer);
  set_pyth_time_delta(7200, deployer);
  set_allowed_contracts(deployer);
  set_asset_cap(deployer, 2n ** 128n - 1n);
  initialize_ir(deployer);
  initialize_staking_reward(deployer);
  initialize_lp(deployer);
  await set_initial_price("mock-usdc", 1n, deployer);
  await set_initial_price("mock-btc", 1n, deployer);

  setCap("set-lp-cap", LP_CAP_FACTOR);
  setCap("set-debt-cap", DEBT_CAP_FACTOR);
  setWindows();
  ok(
    simnet.callPublicFn(
      "state-v1",
      "set-protocol-reserve-percentage",
      [Cl.uint(25_000_000)],
      deployer
    )
  );

  mint_token("mock-usdc", Number(100_000n * USDC), depositor);
  deposit(Number(100_000n * USDC), depositor);

  // lp-deposit syncs the debt bucket against the pre-deposit balance, so let
  // its ceiling refill before borrowing.
  simnet.mineEmptyBlocks(3_600);

  update_supported_collateral(
    "mock-btc",
    70_000_000,
    80_000_000,
    10_000_000,
    8,
    deployer
  );
  mint_token("mock-btc", Number(2_000n * USDC), borrower);
  add_collateral("mock-btc", Number(2_000n * USDC), deployer, borrower);
  borrow(Number(1_000n * USDC), borrower);

  // Lower the liquidation LTV below the debt ratio so the position is liquidatable.
  update_supported_collateral(
    "mock-btc",
    20_000_000,
    30_000_000,
    10_000_000,
    8,
    deployer
  );

  // Past the decay window since the LP bucket's last sync.
  simnet.mineEmptyBlocks(8_000);
  mint_token("mock-usdc", Number(100n * USDC), depositor);
};

describe("repay syncs the LP withdrawal bucket", () => {
  beforeEach(async () => {
    await setupAttacker(LP_CAP_FACTOR, DEBT_CAP_FACTOR);
  });

  it("control: without the repay, a 20% x (L + D) withdrawal reverts on the LP cap", () => {
    // 2,000 USDC deposited, 200 USDC borrowed out, so state-v1 holds L = 1,800.00001 USDC.
    const liquidity = usdcBalance(stateV1());
    expect(liquidity).toBe(DEPOSIT + MINIMUM_INITIAL_DEPOSIT - BORROW);

    const intendedCap = (liquidity * LP_CAP_FACTOR) / SCALING;
    const attackAmount = ((liquidity + BORROW) * LP_CAP_FACTOR) / SCALING;
    expect(attackAmount).toBeGreaterThan(intendedCap);

    const res = withdraw(attackAmount);
    expect(res.result).toBeErr(Cl.uint(120002)); // ERR-WITHDRAWAL-LP-CAP-EXCEEDED
  });

  it("repay syncs the LP bucket against the pre-repay liquidity", () => {
    const liquidityBeforeRepay = usdcBalance(stateV1());
    expect(liquidityBeforeRepay).toBe(DEPOSIT + MINIMUM_INITIAL_DEPOSIT - BORROW);

    const lpUpdateBeforeRepay = capRead("get-last-lp-bucket-update");
    const lpBucketBeforeRepay = capRead("get-lp-bucket");
    expect(lpBucketBeforeRepay).toBeGreaterThan(0n);

    const repayRes = repay();
    ok(repayRes);

    // The LP bucket was resynced as part of the repay, before state-v1 credited the
    // repayment, so its ceiling is 20% of the pre-repay liquidity. More than the decay
    // window has elapsed since the last LP sync, so the bucket decays exactly onto it.
    const intendedCap = (liquidityBeforeRepay * LP_CAP_FACTOR) / SCALING;
    expect(getSimnetBlockTime() - lpUpdateBeforeRepay).toBeGreaterThanOrEqual(
      DECAY_WINDOW
    );
    expect(capRead("get-last-lp-bucket-update")).toBeGreaterThan(
      lpUpdateBeforeRepay
    );
    expect(capRead("get-lp-bucket")).toBe(intendedCap);

    const lpSync = findPrint(repayRes, "sync-lp-bucket");
    expect(lpSync).toBeDefined();
    expect(lpSync["old-lp-bucket-value"].value).toBe(lpBucketBeforeRepay);
    expect(lpSync["new-lp-bucket-value"].value).toBe(intendedCap);

    // The repayment still credits the debt bucket as before.
    expect(findPrint(repayRes, "sync-debt-bucket")).toBeDefined();

    const liquidityAfterRepay = usdcBalance(stateV1());
    expect(liquidityAfterRepay).toBe(liquidityBeforeRepay + BORROW);

    // 20% x (L + D) is rejected: the ceiling did not jump by 0.2D.
    const overCapAmount = (liquidityAfterRepay * LP_CAP_FACTOR) / SCALING;
    expect(overCapAmount).toBe(intendedCap + (BORROW * LP_CAP_FACTOR) / SCALING);
    expect(withdraw(overCapAmount).result).toBeErr(Cl.uint(120002));

    // The intended window cap is still withdrawable.
    ok(withdraw(intendedCap));
  });
});

describe("repay with the debt cap disabled", () => {
  beforeEach(async () => {
    await setupAttacker(LP_CAP_FACTOR, 0n);
  });

  it("still syncs the LP bucket before the repayment lands", () => {
    const liquidityBeforeRepay = usdcBalance(stateV1());
    expect(liquidityBeforeRepay).toBe(DEPOSIT + MINIMUM_INITIAL_DEPOSIT - BORROW);

    const lpUpdateBeforeRepay = capRead("get-last-lp-bucket-update");

    const repayRes = repay();
    ok(repayRes);

    const intendedCap = (liquidityBeforeRepay * LP_CAP_FACTOR) / SCALING;
    expect(capRead("get-last-lp-bucket-update")).toBeGreaterThan(
      lpUpdateBeforeRepay
    );
    expect(capRead("get-lp-bucket")).toBe(intendedCap);
    expect(findPrint(repayRes, "sync-lp-bucket")).toBeDefined();
    // The debt cap is off, so there is no debt bucket to sync.
    expect(findPrint(repayRes, "sync-debt-bucket")).toBeUndefined();

    const liquidityAfterRepay = usdcBalance(stateV1());
    expect(liquidityAfterRepay).toBe(liquidityBeforeRepay + BORROW);
    expect(
      withdraw((liquidityAfterRepay * LP_CAP_FACTOR) / SCALING).result
    ).toBeErr(Cl.uint(120002));
  });
});

describe("repay with the LP cap disabled", () => {
  beforeEach(async () => {
    await setupAttacker(0n, DEBT_CAP_FACTOR);
  });

  it("repays without syncing the LP bucket and still syncs the debt bucket", () => {
    expect(capRead("get-last-lp-bucket-update")).toBe(0n);
    expect(capRead("get-lp-bucket")).toBe(0n);
    const liquidityBeforeRepay = usdcBalance(stateV1());

    const repayRes = repay();
    ok(repayRes);

    expect(findPrint(repayRes, "sync-lp-bucket")).toBeUndefined();
    expect(findPrint(repayRes, "sync-debt-bucket")).toBeDefined();
    expect(capRead("get-last-lp-bucket-update")).toBe(0n);
    expect(capRead("get-lp-bucket")).toBe(0n);
    expect(usdcBalance(stateV1())).toBe(liquidityBeforeRepay + BORROW);
  });
});

describe("the liquidation path syncs the LP bucket", () => {
  beforeEach(async () => {
    await setupLiquidation();
  });

  it("syncs the LP bucket against the pre-credit liquidity", () => {
    const liquidityBefore = usdcBalance(stateV1());
    const lpUpdateBefore = capRead("get-last-lp-bucket-update");
    expect(getSimnetBlockTime() - lpUpdateBefore).toBeGreaterThanOrEqual(
      DECAY_WINDOW
    );
    // The deposit's inflow left the bucket far above its ceiling; a full decay lands it
    // exactly on 20% of the liquidity state-v1 holds before the liquidation credits it.
    const expectedCeiling = (liquidityBefore * LP_CAP_FACTOR) / SCALING;

    const liquidation = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        contractPrincipalCV(deployer, "mock-btc"),
        Cl.principal(borrower),
        Cl.uint(100n * USDC),
        Cl.uint(1),
      ],
      depositor
    );
    ok(liquidation);

    expect(capRead("get-last-lp-bucket-update")).toBeGreaterThan(lpUpdateBefore);
    expect(capRead("get-lp-bucket")).toBe(expectedCeiling);

    const lpSync = findPrint(liquidation, "sync-lp-bucket");
    expect(lpSync).toBeDefined();
    expect(lpSync["old-lp-bucket-value"].value).toBeGreaterThan(
      expectedCeiling
    );
    expect(lpSync["new-lp-bucket-value"].value).toBe(expectedCeiling);
    // The liquidation path syncs the debt bucket on the pre-credit balance too.
    expect(findPrint(liquidation, "sync-debt-bucket")).toBeDefined();

    // The liquidation credited state-v1 with the repaid assets afterwards.
    expect(usdcBalance(stateV1())).toBeGreaterThan(liquidityBefore);
  });
});
