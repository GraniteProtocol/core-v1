import { tx } from "@stacks/clarinet-sdk";
import { Cl, ClarityValue } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
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
  minedExecution,
  minedResult,
  set_allowed_contracts,
  set_asset_cap,
  transfer_token,
  update_supported_collateral,
} from "./utils";

// Design validation for staking share pricing: staker interest is priced into
// every share conversion through the effective backing (materialized backing
// plus accrued-but-unminted staker interest in LP-token terms).

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const honest = accounts.get("wallet_1")!;
const jit = accounts.get("wallet_2")!;
const borrower = accounts.get("wallet_3")!;
const queuer = accounts.get("wallet_4")!;
// Must match NULL_ADDRESS in staking-v1.clar.
const NULL_ADDRESS = "ST000000000000000000002AMW42H";

const USDC = 100_000_000n;
const HONEST_DEPOSIT = 10_000n * USDC;
const JIT_DEPOSIT = 1_000n * USDC;
const QUEUER_DEPOSIT = 1_000n * USDC;
const BORROWER_DEPOSIT = 1_000n * USDC;
const HONEST_STAKE = 1_000n * USDC;
const JIT_STAKE = 1_000n * USDC;
const QUEUER_STAKE = 500n * USDC;
const BORROW = 7_000n * USDC;
const INTEREST_BLOCKS = 100;
const RESERVE_FUNDING = 100n * USDC;
const FULL_REPAY = 10_000n * USDC;
// Rounding across a handful of floor divisions cannot exceed a few units.
const TOL = 10n;

const ok = (r: any) => expect(r.result).toBeOk(Cl.bool(true));
const okMined = (r: any) => expect(minedResult(r)).toBeOk(Cl.bool(true));
const call = (
  contract: string,
  fn: string,
  args: ClarityValue[],
  sender: string
) => simnet.callPublicFn(contract, fn, args, sender);
const ro = (contract: string, fn: string, args: ClarityValue[] = []) =>
  simnet.callReadOnlyFn(contract, fn, args, deployer).result as any;
const uintOf = (contract: string, fn: string, args: ClarityValue[] = []) =>
  ro(contract, fn, args).value as bigint;
const okUintOf = (contract: string, fn: string, args: ClarityValue[] = []) =>
  ro(contract, fn, args).value.value as bigint;
const lpBalance = (who: ClarityValue) => okUintOf("state-v1", "get-balance", [who]);
const stakedBalance = (who: ClarityValue) =>
  okUintOf("staking-v1", "get-balance", [who]);
const activeBacking = () => uintOf("staking-v1", "get-active-staked-lp-tokens");
const stakedSupply = () => okUintOf("staking-v1", "get-total-supply");
const claimOf = (shares: bigint) =>
  uintOf("staking-v1", "convert-to-lp-tokens", [Cl.uint(shares), Cl.bool(false)]);
const pendingStaked = () =>
  ro("state-v1", "get-open-interest").value["staked-open-interest"].value as bigint;
const lpParams = () => {
  const p = ro("state-v1", "get-lp-params").value;
  return {
    assets: p["total-assets"].value as bigint,
    shares: p["total-shares"].value as bigint,
  };
};
// Pending staker interest in LP-token terms, floored like math-v1 does.
const pendingLpFor = (
  pending: bigint,
  p: { assets: bigint; shares: bigint }
) => (p.assets === 0n ? pending : (pending * p.shares) / p.assets);
const pendingLp = (pending: bigint) => pendingLpFor(pending, lpParams());
const eventAmount = (res: any, action: string) =>
  minedExecution(res).events.find(
    (e: any) => e.data?.value?.value?.["action"]?.value === action
  ).data.value.value["amount"].value as bigint;
const within = (actual: bigint, expected: bigint, tol = TOL) =>
  actual >= expected - tol && actual <= expected + tol;

// Measurement carried between the two conversion-continuity tests.
let repayMeasurement: { effective: bigint; pendingLp: bigint } | undefined;

const setup = async (
  opts: {
    queuer?: boolean;
    honestStake?: boolean;
    borrowerDeposit?: bigint;
  } = {}
) => {
  const { queuer: withQueuer = true, honestStake = true, borrowerDeposit = 0n } = opts;
  init_pyth(deployer);
  set_pyth_time_delta(7200, deployer);
  set_allowed_contracts(deployer);
  set_asset_cap(deployer, 100_000n * USDC);
  initialize_ir(deployer);
  initialize_staking_reward(deployer);
  initialize_lp(deployer);
  await set_initial_price("mock-usdc", 1n, deployer);
  await set_initial_price("mock-btc", 10n, deployer);
  update_supported_collateral("mock-btc", 70_000_000, 80_000_000, 10_000_000, 8, deployer);
  initialize_staking(deployer);

  const deposits: [string, bigint][] = [
    [honest, HONEST_DEPOSIT],
    [jit, JIT_DEPOSIT],
  ];
  if (withQueuer) deposits.push([queuer, QUEUER_DEPOSIT]);
  if (borrowerDeposit > 0n) deposits.push([borrower, borrowerDeposit]);
  for (const [who, amount] of deposits) {
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

  if (honestStake) {
    ok(call("staking-v1", "stake", [Cl.uint(HONEST_STAKE)], honest));
  }
  if (withQueuer) {
    ok(call("staking-v1", "stake", [Cl.uint(QUEUER_STAKE)], queuer));
    const shares = stakedBalance(Cl.principal(queuer));
    expect(call("staking-v1", "initiate-unstake", [Cl.uint(shares)], queuer).result).toBeOk(
      Cl.uint(0)
    );
  }
};

const exit = (who: string, expectedIndex = 0) => {
  const shares = stakedBalance(Cl.principal(who));
  expect(
    call("staking-v1", "initiate-unstake", [Cl.uint(shares)], who).result
  ).toBeOk(Cl.uint(expectedIndex));
  simnet.mineEmptyBlocks(101);
  ok(call("staking-v1", "finalize-unstake", [Cl.uint(expectedIndex)], who));
};

describe("staking JIT design validation", () => {
  it("variant a: staking inside the repay block earns none of the accrued staked interest", async () => {
    await setup();
    const honestShares = stakedBalance(Cl.principal(honest));
    const setupShortfall = HONEST_STAKE - activeBacking();
    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    mint_token("mock-usdc", Number(3_000n * USDC), borrower);

    const block = simnet.mineBlock([
      tx.callPublicFn("staking-v1", "stake", [Cl.uint(JIT_STAKE)], jit),
      tx.callPublicFn("borrower-v1", "repay", [Cl.uint(FULL_REPAY), Cl.none()], borrower),
    ]);
    okMined(block[0]);
    okMined(block[1]);

    const jitShares = stakedBalance(Cl.principal(jit));
    const deltaB = eventAmount(block[1], "increase-lp-staked-balance");
    expect(deltaB).toBeGreaterThan(0n);

    exit(jit);
    const jitGain = lpBalance(Cl.principal(jit)) - JIT_DEPOSIT;
    const honestGain = claimOf(honestShares) - HONEST_STAKE;

    console.log(
      JSON.stringify({
        variant: "a-same-block",
        stakedInterestAdded: deltaB.toString(),
        setupShortfall: setupShortfall.toString(),
        jitSharesMinted: jitShares.toString(),
        jitGain: jitGain.toString(),
        honestGain: honestGain.toString(),
      })
    );

    // Priced against the effective backing: fewer shares than the deposit.
    expect(jitShares).toBeLessThan(JIT_STAKE);
    expect(within(jitGain, 0n)).toBe(true);
    expect(within(honestGain, deltaB - setupShortfall)).toBe(true);
    expect(within(honestGain + jitGain, deltaB - setupShortfall)).toBe(true);
  });

  it("variant b: queued exit after the repay captures none of the materialized interest", async () => {
    await setup();
    const honestShares = stakedBalance(Cl.principal(honest));
    const setupShortfall = HONEST_STAKE - activeBacking();
    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    mint_token("mock-usdc", Number(3_000n * USDC), borrower);

    // Stake one block before the repay, then queue the exit and finalize.
    ok(call("staking-v1", "stake", [Cl.uint(JIT_STAKE)], jit));
    const jitShares = stakedBalance(Cl.principal(jit));
    const pendingAtStake = pendingStaked();
    const paramsAtStake = lpParams();
    const block = simnet.mineBlock([
      tx.callPublicFn("borrower-v1", "repay", [Cl.uint(FULL_REPAY), Cl.none()], borrower),
    ]);
    okMined(block[0]);
    const deltaB = eventAmount(block[0], "increase-lp-staked-balance");
    // Interest that accrued after the stake: the most the JIT can fairly earn.
    const earnedWhileStaked =
      deltaB - pendingLpFor(pendingAtStake, paramsAtStake);
    expect(earnedWhileStaked).toBeGreaterThan(0n);

    exit(jit);
    const jitGain = lpBalance(Cl.principal(jit)) - JIT_DEPOSIT;
    const honestGain = claimOf(honestShares) - HONEST_STAKE;

    console.log(
      JSON.stringify({
        variant: "b-queued-after-repay",
        stakedInterestAdded: deltaB.toString(),
        setupShortfall: setupShortfall.toString(),
        jitSharesMinted: jitShares.toString(),
        earnedWhileStaked: earnedWhileStaked.toString(),
        jitGain: jitGain.toString(),
        honestGain: honestGain.toString(),
      })
    );

    expect(jitShares).toBeLessThan(JIT_STAKE);
    expect(jitGain).toBeGreaterThanOrEqual(-TOL);
    expect(jitGain).toBeLessThanOrEqual(earnedWhileStaked + TOL);
    expect(within(honestGain + jitGain, deltaB - setupShortfall)).toBe(true);
  });

  it("variant b-neg: a queue placed before the repay cannot capture materialized interest", async () => {
    await setup();
    const honestShares = stakedBalance(Cl.principal(honest));
    const setupShortfall = HONEST_STAKE - activeBacking();
    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    mint_token("mock-usdc", Number(3_000n * USDC), borrower);

    const queueBefore = uintOf("staking-v1", "get-total-staked-lp-tokens") - activeBacking();
    ok(call("staking-v1", "stake", [Cl.uint(JIT_STAKE)], jit));
    const jitShares = stakedBalance(Cl.principal(jit));
    const pendingAtStake = pendingStaked();
    const paramsAtStake = lpParams();
    expect(
      call("staking-v1", "initiate-unstake", [Cl.uint(jitShares)], jit).result
    ).toBeOk(Cl.uint(0));
    const pendingAtInitiate = pendingStaked();
    const earnedWhileStaked = pendingLpFor(
      pendingAtInitiate - pendingAtStake,
      paramsAtStake
    );
    const queueAfter = uintOf("staking-v1", "get-total-staked-lp-tokens") - activeBacking();
    const queuedClaim = queueAfter - queueBefore;

    const block = simnet.mineBlock([
      tx.callPublicFn("borrower-v1", "repay", [Cl.uint(FULL_REPAY), Cl.none()], borrower),
    ]);
    okMined(block[0]);
    const deltaB = eventAmount(block[0], "increase-lp-staked-balance");

    simnet.mineEmptyBlocks(101);
    ok(call("staking-v1", "finalize-unstake", [Cl.uint(0)], jit));
    const jitGain = lpBalance(Cl.principal(jit)) - JIT_DEPOSIT;
    const honestGain = claimOf(honestShares) - HONEST_STAKE;

    console.log(
      JSON.stringify({
        variant: "b-queued-before-repay",
        stakedInterestAdded: deltaB.toString(),
        setupShortfall: setupShortfall.toString(),
        jitSharesMinted: jitShares.toString(),
        queuedClaim: queuedClaim.toString(),
        earnedWhileStaked: earnedWhileStaked.toString(),
        jitGain: jitGain.toString(),
        honestGain: honestGain.toString(),
      })
    );

    // The claim was fixed before the repay, so materialization cannot revisit it.
    expect(within(jitGain, queuedClaim - JIT_STAKE)).toBe(true);
    expect(jitGain).toBeGreaterThanOrEqual(-TOL);
    expect(jitGain).toBeLessThanOrEqual(earnedWhileStaked + TOL);
    expect(within(honestGain + jitGain, deltaB - setupShortfall)).toBe(true);
  });

  it("variant c: a borrower staking before repaying their own debt earns no staker interest", async () => {
    await setup({ borrowerDeposit: BORROWER_DEPOSIT });
    const honestShares = stakedBalance(Cl.principal(honest));
    const setupShortfall = HONEST_STAKE - activeBacking();
    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    mint_token("mock-usdc", Number(3_000n * USDC), borrower);

    const block = simnet.mineBlock([
      tx.callPublicFn("staking-v1", "stake", [Cl.uint(BORROWER_DEPOSIT)], borrower),
      tx.callPublicFn("borrower-v1", "repay", [Cl.uint(FULL_REPAY), Cl.none()], borrower),
    ]);
    okMined(block[0]);
    okMined(block[1]);

    const borrowerShares = stakedBalance(Cl.principal(borrower));
    const deltaB = eventAmount(block[1], "increase-lp-staked-balance");

    exit(borrower);
    const borrowerGain = lpBalance(Cl.principal(borrower)) - BORROWER_DEPOSIT;
    const honestGain = claimOf(honestShares) - HONEST_STAKE;

    console.log(
      JSON.stringify({
        variant: "c-borrower-self",
        stakedInterestAdded: deltaB.toString(),
        setupShortfall: setupShortfall.toString(),
        borrowerSharesMinted: borrowerShares.toString(),
        borrowerGain: borrowerGain.toString(),
        honestGain: honestGain.toString(),
      })
    );

    expect(borrowerShares).toBeLessThan(BORROWER_DEPOSIT);
    expect(within(borrowerGain, 0n)).toBe(true);
    expect(within(honestGain, deltaB - setupShortfall)).toBe(true);
  });

  it("zero-supply edge: the first staker cannot capture backing that accrued with no stakers", async () => {
    await setup({ honestStake: false, queuer: false });

    // Build active backing with zero staked supply: gift LP to the staking
    // contract, then reconcile (governance) so the module accounts for it.
    const giftAssets = 500n * USDC;
    mint_token("mock-usdc", Number(giftAssets), deployer);
    ok(
      call(
        "liquidity-provider-v1",
        "deposit",
        [Cl.uint(giftAssets), Cl.principal(deployer)],
        deployer
      )
    );
    const gift = lpBalance(Cl.principal(deployer));
    expect(gift).toBeGreaterThan(0n);
    transfer_token(
      "state-v1",
      Number(gift),
      deployer,
      Cl.contractPrincipal(deployer, "staking-v1")
    );
    ok(call("staking-v1", "reconcile-lp-token-balance", [], deployer));
    expect(activeBacking()).toBe(gift);
    expect(stakedSupply()).toBe(0n);

    // Accrue staker interest while no one is staked. The reconcile call above
    // already accrued at its own block; accrue again at this one.
    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    ok(call("staking-v1", "reconcile-lp-token-balance", [], deployer));
    const pendingBeforeStake = pendingStaked();
    expect(pendingBeforeStake).toBeGreaterThan(0n);

    ok(call("staking-v1", "stake", [Cl.uint(HONEST_STAKE)], honest));
    const minted = stakedBalance(Cl.principal(honest));
    const pendingAfterStake = pendingStaked();
    const effectiveBeforeStake =
      activeBacking() - HONEST_STAKE + pendingLp(pendingAfterStake);
    const supplyAfterStake = stakedSupply();
    const claim = claimOf(minted);
    const deadShares = okUintOf("staking-v1", "get-balance", [
      Cl.principal(NULL_ADDRESS),
    ]);

    console.log(
      JSON.stringify({
        edge: "zero-supply",
        activeBacking: (activeBacking() - HONEST_STAKE).toString(),
        pendingStakedInterest: pendingBeforeStake.toString(),
        effectiveBeforeStake: effectiveBeforeStake.toString(),
        deadShares: deadShares.toString(),
        sharesMinted: minted.toString(),
        claim: claim.toString(),
        supplyAfterStake: supplyAfterStake.toString(),
      })
    );

    expect(minted).toBe(HONEST_STAKE);
    expect(claim).toBe(HONEST_STAKE);
    expect(deadShares).toBe(effectiveBeforeStake);
    expect(supplyAfterStake).toBe(effectiveBeforeStake + HONEST_STAKE);
  });

  it("zero-supply fresh module: a first stake still mints 1:1", async () => {
    await setup({ honestStake: false, queuer: false });
    expect(stakedSupply()).toBe(0n);
    expect(activeBacking()).toBe(0n);
    expect(claimOf(1_000n)).toBe(0n);

    mint_token("mock-usdc", Number(HONEST_STAKE), honest);
    ok(call("liquidity-provider-v1", "deposit", [Cl.uint(HONEST_STAKE), Cl.principal(honest)], honest));
    ok(call("staking-v1", "stake", [Cl.uint(HONEST_STAKE)], honest));

    expect(stakedBalance(Cl.principal(honest))).toBe(HONEST_STAKE);
    expect(
      okUintOf("staking-v1", "get-balance", [Cl.principal(NULL_ADDRESS)])
    ).toBe(0n);
  });

  it("large exit while pending: named error until the interest materializes, then succeeds", async () => {
    await setup();
    const honestShares = stakedBalance(Cl.principal(honest));
    simnet.mineEmptyBlocks(INTEREST_BLOCKS);

    // The sole active staker's claim includes pending interest the contract has
    // not been minted yet, so the exit is refused rather than paid short.
    expect(
      call("staking-v1", "initiate-unstake", [Cl.uint(honestShares)], honest).result
    ).toBeErr(Cl.uint(60015));

    mint_token("mock-usdc", Number(3_000n * USDC), borrower);
    ok(
      call("borrower-v1", "repay", [Cl.uint(FULL_REPAY), Cl.none()], borrower)
    );

    // Once the repayment materializes the interest the same exit succeeds.
    expect(
      call("staking-v1", "initiate-unstake", [Cl.uint(honestShares)], honest).result
    ).toBeOk(Cl.uint(0));
    simnet.mineEmptyBlocks(101);
    ok(call("staking-v1", "finalize-unstake", [Cl.uint(0)], honest));
  });

  it("stake below the share price reverts instead of minting zero shares", async () => {
    await setup();
    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    transfer_token("state-v1", 1, honest, Cl.principal(jit));
    const res = call("staking-v1", "stake", [Cl.uint(1n)], jit);
    console.log(JSON.stringify({ zeroMint: JSON.stringify(res.result) }));
    expect(res.result).toBeErr(Cl.uint(60014));
  });

  it("rounding: both conversions floor on the effective backing", async () => {
    await setup();
    // A long accrual plus a position this size makes the two candidate
    // denominators separate by thousands of units, not just one.
    simnet.mineEmptyBlocks(1_000);
    const supplyBefore = stakedSupply();
    const backingBefore = activeBacking();
    const stakeAmount = 10_000_000n;

    transfer_token("state-v1", Number(stakeAmount), honest, Cl.principal(jit));
    ok(call("staking-v1", "stake", [Cl.uint(stakeAmount)], jit));
    const minted = stakedBalance(Cl.principal(jit));
    // Read the accrual state after the stake: LP params move with the accrual,
    // and the conversion inside the stake used the post-accrual params.
    const pendingAfterStake = pendingStaked();
    const paramsAfterStake = lpParams();
    const effectiveAtStake =
      backingBefore + pendingLpFor(pendingAfterStake, paramsAfterStake);
    const expectedMinted = (stakeAmount * supplyBefore) / effectiveAtStake;
    const materializedMinted = (stakeAmount * supplyBefore) / backingBefore;

    const supplyBeforeUnstake = stakedSupply();
    const backingBeforeUnstake = activeBacking();
    const queueBeforeUnstake =
      uintOf("staking-v1", "get-total-staked-lp-tokens") - backingBeforeUnstake;
    expect(
      call("staking-v1", "initiate-unstake", [Cl.uint(minted)], jit).result
    ).toBeOk(Cl.uint(0));
    const pendingAfterUnstake = pendingStaked();
    const paramsAfterUnstake = lpParams();
    const effectiveAtUnstake =
      backingBeforeUnstake + pendingLpFor(pendingAfterUnstake, paramsAfterUnstake);
    const expectedReturned = (minted * effectiveAtUnstake) / supplyBeforeUnstake;
    const materializedReturned =
      (minted * backingBeforeUnstake) / supplyBeforeUnstake;
    const queueAfterUnstake =
      uintOf("staking-v1", "get-total-staked-lp-tokens") - activeBacking();
    const returned = queueAfterUnstake - queueBeforeUnstake;

    console.log(
      JSON.stringify({
        rounding: {
          effectiveAtStake: effectiveAtStake.toString(),
          stakeAmount: stakeAmount.toString(),
          minted: minted.toString(),
          expectedMinted: expectedMinted.toString(),
          materializedMinted: materializedMinted.toString(),
          effectiveAtUnstake: effectiveAtUnstake.toString(),
          returned: returned.toString(),
          expectedReturned: expectedReturned.toString(),
          materializedReturned: materializedReturned.toString(),
        },
      })
    );

    expect(minted).toBe(expectedMinted);
    expect(minted).toBeLessThanOrEqual(stakeAmount);
    expect(materializedMinted - expectedMinted).toBeGreaterThan(TOL);
    expect(returned).toBe(expectedReturned);
    expect(expectedReturned - materializedReturned).toBeGreaterThan(TOL);
  });

  it("multi-staker exit: a partial exit pays its slice of pending interest and the guard passes", async () => {
    await setup({ honestStake: false, queuer: false });
    const block = simnet.mineBlock([
      tx.callPublicFn("staking-v1", "stake", [Cl.uint(HONEST_STAKE)], honest),
      tx.callPublicFn("staking-v1", "stake", [Cl.uint(JIT_STAKE)], jit),
    ]);
    okMined(block[0]);
    okMined(block[1]);
    const aShares = stakedBalance(Cl.principal(honest));
    const bShares = stakedBalance(Cl.principal(jit));
    expect(aShares).toBe(HONEST_STAKE);
    expect(bShares).toBe(JIT_STAKE);

    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    const backingBefore = activeBacking();
    const supplyBefore = stakedSupply();
    const queueBefore =
      uintOf("staking-v1", "get-total-staked-lp-tokens") - backingBefore;

    expect(
      call("staking-v1", "initiate-unstake", [Cl.uint(bShares)], jit).result
    ).toBeOk(Cl.uint(0));

    const pendingAfter = pendingStaked();
    const params = lpParams();
    const effectiveBefore = backingBefore + pendingLpFor(pendingAfter, params);
    const expectedB = (bShares * effectiveBefore) / supplyBefore;
    const queueAfter =
      uintOf("staking-v1", "get-total-staked-lp-tokens") - activeBacking();
    const bPayout = queueAfter - queueBefore;
    const aClaim = claimOf(aShares);
    const pendingInLp = pendingLpFor(pendingAfter, params);

    console.log(
      JSON.stringify({
        multiStaker: {
          pendingInLp: pendingInLp.toString(),
          bPayout: bPayout.toString(),
          bShareOfPending: (bPayout - bShares).toString(),
          aClaim: aClaim.toString(),
          aShareOfPending: (aClaim - aShares).toString(),
        },
      })
    );

    // B's claim is priced on the effective backing and clears the solvency guard.
    expect(bPayout).toBe(expectedB);
    expect(bPayout).toBeGreaterThan(bShares);
    expect(within(bPayout - bShares, pendingInLp / 2n)).toBe(true);
    // A keeps the other half of the pending interest, and the claims conserve.
    expect(within(aClaim - aShares, pendingInLp - pendingInLp / 2n)).toBe(true);
    expect(within(aClaim + bPayout, effectiveBefore)).toBe(true);

    simnet.mineEmptyBlocks(101);
    ok(call("staking-v1", "finalize-unstake", [Cl.uint(0)], jit));
    expect(lpBalance(Cl.principal(jit))).toBe(bPayout);
  });

  it("effective backing: pending interest is already counted before a repay", async () => {
    await setup();
    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    mint_token("mock-usdc", Number(3_000n * USDC), borrower);
    ok(call("staking-v1", "reconcile-lp-token-balance", [], deployer));

    const pendingInLp = pendingLp(pendingStaked());
    const effective = activeBacking() + pendingInLp;
    repayMeasurement = { effective, pendingLp: pendingInLp };

    console.log(
      JSON.stringify({
        effectiveBeforeRepay: {
          pendingInLp: pendingInLp.toString(),
          effective: effective.toString(),
        },
      })
    );

    expect(pendingInLp).toBeGreaterThan(0n);
  });

  it("effective backing: a repay materializes exactly the interest already counted", async () => {
    expect(repayMeasurement, "the before-repay test must run first").toBeDefined();
    await setup();
    simnet.mineEmptyBlocks(INTEREST_BLOCKS);
    mint_token("mock-usdc", Number(3_000n * USDC), borrower);

    const block = simnet.mineBlock([
      tx.callPublicFn("staking-v1", "reconcile-lp-token-balance", [], deployer),
      tx.callPublicFn("borrower-v1", "repay", [Cl.uint(FULL_REPAY), Cl.none()], borrower),
    ]);
    okMined(block[0]);
    okMined(block[1]);
    const deltaB = eventAmount(block[1], "increase-lp-staked-balance");
    const effectiveAfter = activeBacking();

    console.log(
      JSON.stringify({
        effectiveAfterRepay: {
          materialized: deltaB.toString(),
          effective: effectiveAfter.toString(),
          effectiveBefore: repayMeasurement!.effective.toString(),
        },
      })
    );

    expect(deltaB).toBe(repayMeasurement!.pendingLp);
    expect(effectiveAfter).toBe(repayMeasurement!.effective);
  });
});
