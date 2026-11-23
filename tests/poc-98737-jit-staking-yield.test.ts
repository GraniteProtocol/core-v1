import { tx } from "@stacks/clarinet-sdk";
import { Cl, ClarityValue } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  build_price_update,
  init_pyth,
  set_initial_price,
  set_pyth_time_delta,
} from "./pyth";
import {
  add_collateral,
  initialize_ir,
  initialize_lp,
  initialize_staking,
  initialize_staking_reward,
  mint_token,
  set_allowed_contracts,
  set_asset_cap,
  update_supported_collateral,
} from "./utils";

// Immunefi 98737: yield lands pro-rata at repay with no per-staker checkpoint,
// so a JIT stake just before the repay captures yield accrued before it staked.

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const honest = accounts.get("wallet_1")!;
const jit = accounts.get("wallet_2")!;
const borrower = accounts.get("wallet_3")!;
const queuer = accounts.get("wallet_4")!;

const USDC = 100_000_000n; // simnet mock-usdc is 8 decimals
const HONEST_DEPOSIT = 10_000n * USDC;
const JIT_DEPOSIT = 1_000n * USDC;
const QUEUER_DEPOSIT = 1_000n * USDC;
const HONEST_STAKE = 1_000n * USDC;
const JIT_STAKE = 1_000n * USDC;
const QUEUER_STAKE = 500n * USDC;
const BORROW = 7_000n * USDC;
const INTEREST_BLOCKS = 100;
const RESERVE_FUNDING = 100n * USDC;
const FULL_REPAY = 10_000n * USDC;

const ok = (r: any) => expect(r.result).toBeOk(Cl.bool(true));
const call = (
  contract: string,
  fn: string,
  args: ClarityValue[],
  sender: string
) => simnet.callPublicFn(contract, fn, args, sender);
const lpBalance = (who: ClarityValue) =>
  (simnet.callReadOnlyFn("state-v1", "get-balance", [who], deployer).result as any)
    .value.value as bigint;
const stakedBalance = (who: ClarityValue) =>
  (simnet.callReadOnlyFn("staking-v1", "get-balance", [who], deployer).result as any)
    .value.value as bigint;
const activeBacking = () =>
  (
    simnet.callReadOnlyFn("staking-v1", "get-active-staked-lp-tokens", [], deployer)
      .result as any
  ).value as bigint;
const claimOf = (stakedTokens: bigint) =>
  (
    simnet.callReadOnlyFn(
      "staking-v1",
      "convert-to-lp-tokens",
      [Cl.uint(stakedTokens), Cl.bool(false)],
      deployer
    ).result as any
  ).value as bigint;
const increaseLpStakedEvent = (res: any) =>
  res.events.find(
    (e: any) => e.data?.value?.value?.["action"]?.value === "increase-lp-staked-balance"
  ) as any;

// The no-JIT run's measurement, used by the JIT test for the cross-run
// comparison. Tests in this file run in declaration order.
let controlRun:
  | { deltaB: bigint; honestClaim: bigint; honestGain: bigint }
  | undefined;

// Live-like setup: 12,000 USDC of LP liquidity (one honest LP staked from the
// start), a 7,000 USDC borrow accruing real interest, an unfinalized
// withdrawal queue, and a funded protocol reserve.
const setup = async () => {
  init_pyth(deployer);
  set_pyth_time_delta(7200, deployer);
  set_allowed_contracts(deployer);
  set_asset_cap(deployer, 100_000n * USDC);
  initialize_ir(deployer);
  initialize_staking_reward(deployer);
  initialize_lp(deployer);
  await set_initial_price("mock-usdc", 1n, deployer);
  await set_initial_price("mock-btc", 10n, deployer);
  update_supported_collateral(
    "mock-btc",
    70_000_000,
    80_000_000,
    10_000_000,
    8,
    deployer
  );
  initialize_staking(deployer);

  for (const [who, amount] of [
    [honest, HONEST_DEPOSIT],
    [jit, JIT_DEPOSIT],
    [queuer, QUEUER_DEPOSIT],
  ] as const) {
    mint_token("mock-usdc", Number(amount), who);
    ok(call("liquidity-provider-v1", "deposit", [Cl.uint(amount), Cl.principal(who)], who));
  }

  mint_token("mock-btc", Number(1_000n * USDC), borrower);
  add_collateral("mock-btc", Number(1_000n * USDC), deployer, borrower);
  ok(
    call(
      "borrower-v1",
      "borrow",
      [Cl.buffer(build_price_update()), Cl.uint(BORROW), Cl.none()],
      borrower
    )
  );

  mint_token("mock-usdc", Number(RESERVE_FUNDING), deployer);
  ok(call("state-v1", "deposit-to-reserve", [Cl.uint(RESERVE_FUNDING)], deployer));

  // One honest staker from the start, and an unfinalized queue.
  ok(call("staking-v1", "stake", [Cl.uint(HONEST_STAKE)], honest));
  ok(call("staking-v1", "stake", [Cl.uint(QUEUER_STAKE)], queuer));
  expect(
    call("staking-v1", "initiate-unstake", [Cl.uint(QUEUER_STAKE)], queuer).result
  ).toBeOk(Cl.uint(0));
};

describe("Immunefi 98737 - JIT staking captures yield accrued before the stake", () => {
  beforeEach(async () => {
    await setup();
  });

  it("control: the honest staker receives the full staked interest with no JIT stake", () => {
    const backingBefore = activeBacking();
    expect(backingBefore).toBe(HONEST_STAKE);

    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    mint_token("mock-usdc", Number(3_000n * USDC), borrower);
    const block = simnet.mineBlock([
      tx.callPublicFn(
        "borrower-v1",
        "repay",
        [Cl.uint(FULL_REPAY), Cl.none()],
        borrower
      ),
    ]);
    ok(block[0]);

    const deltaB = increaseLpStakedEvent(block[0]).data.value.value["amount"].value as bigint;
    expect(activeBacking()).toBe(backingBefore + deltaB);
    expect(deltaB).toBeGreaterThan(0n);

    const honestClaim = claimOf(HONEST_STAKE);
    expect(honestClaim).toBe(HONEST_STAKE + deltaB);

    controlRun = { deltaB, honestClaim, honestGain: honestClaim - HONEST_STAKE };

    console.log(
      JSON.stringify({
        test: "control",
        stakedInterestAdded: deltaB.toString(),
        honestClaim: honestClaim.toString(),
        honestGain: (honestClaim - HONEST_STAKE).toString(),
        jitGain: "0",
      })
    );
  });

  it("JIT: staking in the repay block captures half the accrued staked interest", () => {
    expect(controlRun, "the control test must run first in this file").toBeDefined();

    const backingBefore = activeBacking();
    expect(backingBefore).toBe(HONEST_STAKE);
    expect(stakedBalance(Cl.principal(jit))).toBe(0n);
    expect(lpBalance(Cl.principal(jit))).toBe(JIT_DEPOSIT);

    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    mint_token("mock-usdc", Number(3_000n * USDC), borrower);

    // JIT stakes and the borrower repays in the same block: the stake's accrual
    // happens before the mint, so the accrued yield is exactly the control's.
    const block = simnet.mineBlock([
      tx.callPublicFn("staking-v1", "stake", [Cl.uint(JIT_STAKE)], jit),
      tx.callPublicFn(
        "borrower-v1",
        "repay",
        [Cl.uint(FULL_REPAY), Cl.none()],
        borrower
      ),
    ]);
    ok(block[0]);
    ok(block[1]);

    // The JIT got staked-LP 1:1 against the pre-repay backing.
    const jitStakeMinted = stakedBalance(Cl.principal(jit));
    expect(jitStakeMinted).toBe(JIT_STAKE);

    const deltaB = increaseLpStakedEvent(block[1]).data.value.value["amount"].value as bigint;
    expect(activeBacking()).toBe(backingBefore + JIT_STAKE + deltaB);
    expect(deltaB).toBeGreaterThan(0n);
    expect(deltaB).toBe(controlRun!.deltaB);

    const totalStaked = HONEST_STAKE + JIT_STAKE;
    const honestClaim = claimOf(HONEST_STAKE);
    const jitClaim = claimOf(JIT_STAKE);
    expect(honestClaim).toBe(HONEST_STAKE + (deltaB * HONEST_STAKE) / totalStaked);
    expect(jitClaim).toBe(JIT_STAKE + (deltaB * JIT_STAKE) / totalStaked);
    // Both claims together are the whole backing, to one unit of floor rounding.
    const claimsSum = honestClaim + jitClaim;
    const wholeBacking = backingBefore + JIT_STAKE + deltaB;
    expect(wholeBacking - claimsSum <= 1n && claimsSum - wholeBacking <= 1n).toBe(true);

    // The honest staker is short the JIT account's share of the yield (to rounding).
    const honestShortfall = controlRun!.honestClaim - honestClaim;
    expect(honestShortfall).toBeGreaterThan(0n);
    const jitGainFromClaim = jitClaim - JIT_STAKE;
    expect(
      honestShortfall - jitGainFromClaim <= 1n &&
        jitGainFromClaim - honestShortfall <= 1n
    ).toBe(true);

    // The JIT exits: unstake right after the repay and finalize.
    expect(
      call("staking-v1", "initiate-unstake", [Cl.uint(JIT_STAKE)], jit).result
    ).toBeOk(Cl.uint(0));
    simnet.mineEmptyBlocks(101);
    ok(call("staking-v1", "finalize-unstake", [Cl.uint(0)], jit));

    const jitLpAfter = lpBalance(Cl.principal(jit));
    const jitGain = jitLpAfter - JIT_DEPOSIT;
    expect(jitGain).toBeGreaterThan(0n);
    expect(jitGain).toBe(jitClaim - JIT_STAKE);

    // Honest staker's claim after the JIT exit.
    const honestClaimAfter = claimOf(HONEST_STAKE);
    expect(honestClaimAfter).toBeGreaterThanOrEqual(honestClaim);

    // Cross-run: the honest staker is lower in the JIT run by what the JIT gained.
    expect(honestClaimAfter).toBeLessThan(controlRun!.honestClaim);
    const shortfallVsControl = controlRun!.honestClaim - honestClaimAfter;
    expect(shortfallVsControl).toBeGreaterThan(0n);
    expect(
      shortfallVsControl - jitGain <= 1n && jitGain - shortfallVsControl <= 1n
    ).toBe(true);

    console.log(
      JSON.stringify({
        test: "jit",
        stakedInterestAdded: deltaB.toString(),
        jitStakeMinted: jitStakeMinted.toString(),
        jitGain: jitGain.toString(),
        honestClaim: honestClaimAfter.toString(),
        honestGain: (honestClaimAfter - HONEST_STAKE).toString(),
        honestShortfallVsControl: shortfallVsControl.toString(),
        controlHonestClaim: controlRun!.honestClaim.toString(),
        controlStakedInterestAdded: controlRun!.deltaB.toString(),
      })
    );
  });
});
