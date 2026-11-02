import { beforeEach, describe, expect, it } from "vitest";
import { Cl, contractPrincipalCV } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  initialize_ir,
  initialize_lp,
  initialize_staking,
  initialize_staking_reward,
  mint_token,
  repay,
  set_allowed_contracts,
  set_asset_cap,
  update_supported_collateral,
} from "./utils";
import {
  build_price_update,
  converted_price,
  init_pyth,
  set_initial_price,
  set_price,
  set_price_without_scaling,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const borrower = accounts.get("wallet_1")!;
const borrower2 = accounts.get("wallet_2")!;
const liquidator = accounts.get("wallet_3")!;
const depositor = accounts.get("wallet_4")!;
const governor = accounts.get("wallet_5")!;
const btc = contractPrincipalCV(deployer, "mock-btc");

const PROTOCOL_RESERVE_PERCENTAGE = 25_000_000n;

const ro = (contract: string, fn: string, args: any[] = []) =>
  simnet.callReadOnlyFn(contract, fn, args, deployer).result as any;

const buckets = () => {
  const oi = ro("state-v1", "get-open-interest").value;
  return {
    lp: oi["lp-open-interest"].value as bigint,
    staked: oi["staked-open-interest"].value as bigint,
    protocol: oi["protocol-open-interest"].value as bigint,
  };
};

const totalOpenInterest = () => {
  const b = buckets();
  return b.lp + b.staked + b.protocol;
};

const borrowableBalance = () =>
  ro("state-v1", "get-borrowable-balance").value as bigint;
const reserveBalance = () => ro("state-v1", "get-reserve-balance").value as bigint;
const totalBorrowedAmount = () =>
  ro("state-v1", "get-borrow-repay-params", [Cl.principal(borrower)]).value[
    "total-borrowed-amount"
  ].value as bigint;

const positionOf = () =>
  ro("state-v1", "get-user-position", [Cl.principal(borrower)]).value.value as any;

const currentDebt = () => readSplitState().debt;

const readSplitState = () => {
  const position = positionOf();
  return {
    buckets: buckets(),
    borrowedAmount: position["borrowed-amount"].value as bigint,
    debt: ro("math-v1", "convert-to-debt-assets", [
      ro("state-v1", "get-debt-params"),
      Cl.uint(position["debt-shares"].value),
      Cl.bool(true),
    ]).value as bigint,
    totalBorrowed: totalBorrowedAmount(),
  };
};

// Mirrors borrower-v1 / liquidator-v1's three floor divisions and the remainder
// they leave behind, so a test can prove it exercises the case it claims to.
const splitAt = (state: ReturnType<typeof readSplitState>, repayAmount: bigint) => {
  const b = state.buckets;
  const effectiveBorrowed =
    state.debt < state.borrowedAmount ? state.debt : state.borrowedAmount;
  const interestAccrued = state.debt - effectiveBorrowed;
  const interestPart = (interestAccrued * repayAmount + state.debt - 1n) / state.debt;
  const principalPart = repayAmount - interestPart;
  const lpInterest = b.lp > state.totalBorrowed ? b.lp - state.totalBorrowed : 0n;
  const totalOpenInterest = b.lp + b.staked + b.protocol;
  const denominator =
    totalOpenInterest > state.totalBorrowed ? totalOpenInterest - state.totalBorrowed : 0n;
  const divide = (numerator: bigint) =>
    denominator === 0n ? 0n : numerator / denominator;
  const lpPart = divide(interestPart * lpInterest);
  const stakedPart = divide(interestPart * b.staked);
  const protocolPart = divide(interestPart * b.protocol);
  return {
    interestPart,
    principalPart,
    lpInterest,
    stakedInterest: b.staked,
    protocolInterest: b.protocol,
    lpPart,
    stakedPart,
    protocolPart,
    remainder: interestPart - (lpPart + stakedPart + protocolPart),
  };
};

const expectedSplit = (repayAmount: bigint) => splitAt(readSplitState(), repayAmount);

const ONE = 100_000_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// Mirrors the helper's assignment order so a test can predict the final parts.
const applyRemainder = (split: ReturnType<typeof splitAt>) => {
  const { lpPart, stakedPart, protocolPart, remainder } = split;
  if (remainder === 0n) return { lpPart, stakedPart, protocolPart };
  if (split.lpInterest >= lpPart + remainder) {
    return { lpPart: lpPart + remainder, stakedPart, protocolPart };
  }
  if (split.stakedInterest >= stakedPart + remainder) {
    return { lpPart, stakedPart: stakedPart + remainder, protocolPart };
  }
  if (split.protocolInterest >= protocolPart + remainder) {
    return { lpPart, stakedPart, protocolPart: protocolPart + remainder };
  }
  return { lpPart, stakedPart, protocolPart };
};

const COLLATERAL_SATS = 20_000_000_000n;
const LIQUIDATION_LTV = 99_000_000n;
const LIQUIDATION_PREMIUM = 1n;

// Mirrors liquidator-v1's repayment and collateral arithmetic, so a test can
// choose the price that produces a chosen repay.
const liquidationAt = (price: bigint, state: ReturnType<typeof readSplitState>) => {
  const cv = (COLLATERAL_SATS * price) / ONE;
  const liquidCollateral = (cv * LIQUIDATION_LTV) / ONE;
  const denominator = ONE - ((ONE + LIQUIDATION_PREMIUM) * LIQUIDATION_LTV) / ONE;
  if (state.debt <= liquidCollateral) return null;
  const totalRepay = ((state.debt - liquidCollateral) * ONE) / denominator;
  const repayWithoutDiscount = ceilDiv(cv * ONE, ONE + LIQUIDATION_PREMIUM);
  const repayAllowed = [totalRepay, repayWithoutDiscount, state.debt].reduce((a, b) =>
    a < b ? a : b
  );
  const repay = [
    ceilDiv(repayAllowed * ONE, converted_price("mock-usdc")),
    state.debt,
  ].reduce((a, b) => (a < b ? a : b));
  const badDebt = cv < state.debt + (cv * LIQUIDATION_PREMIUM) / ONE;
  const withDiscount = (repay * (ONE + LIQUIDATION_PREMIUM)) / ONE;
  const collateralToGive = [(withDiscount * ONE) / price, COLLATERAL_SATS].reduce((a, b) =>
    a < b ? a : b
  );
  const remaining = COLLATERAL_SATS - collateralToGive;
  const liquidAfter = (((remaining * price) / ONE) * LIQUIDATION_LTV) / ONE;
  const debtAfter = state.debt - repay;
  const health = debtAfter > 0n ? (liquidAfter * ONE) / debtAfter : 10n ** 30n;
  return { cv, repay, badDebt, health };
};

// Mining empty blocks does not run accrual; an empty batch liquidation accrues
// without touching a position.
const accrueInterest = () => {
  const accrual = simnet.callPublicFn(
    "liquidator-v1",
    "batch-liquidate",
    [Cl.buffer(build_price_update()), btc, Cl.list([])],
    depositor
  );
  expect(accrual.result).toBeOk(Cl.bool(true));
};

const handOverGovernance = () => {
  if (ro("state-v1", "get-governance").value === governor) return;
  const handOver = simnet.callPublicFn(
    "state-v1",
    "update-governance",
    [Cl.principal(governor)],
    deployer
  );
  expect(handOver.result).toBeOk(Cl.bool(true));
};

// The borrower's spread is already in the book; zeroing the curve lets a test
// read state and then transact without the transaction's own accrual moving it.
const freezeInterestAccrual = () => {
  handOverGovernance();
  const freeze = simnet.callPublicFn(
    "linear-kinked-ir-v1",
    "update-ir-params",
    [Cl.uint(0), Cl.uint(0), Cl.uint(0), Cl.uint(0)],
    governor
  );
  expect(freeze.result).toBeOk(Cl.bool(true));
};

const openStakedMarket = () => {
  mint_token("mock-usdc", 100_000_000_000, depositor);
  deposit(100_000_000_000, depositor);
  initialize_staking(deployer);
  const stake = simnet.callPublicFn(
    "staking-v1",
    "stake",
    [Cl.uint(5_000_000_000)],
    depositor
  );
  expect(stake.result).toBeOk(Cl.bool(true));
  update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
  mint_token("mock-btc", 20_000_000_000, borrower);
  add_collateral("mock-btc", 20_000_000_000, deployer, borrower);
  borrow(18_000_000_000, borrower);
};

describe("interest split residue", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 100_000_000_000_000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);
    const reserve = simnet.callPublicFn(
      "state-v1",
      "set-protocol-reserve-percentage",
      [Cl.uint(PROTOCOL_RESERVE_PERCENTAGE)],
      deployer
    );
    expect(reserve.result).toBeOk(Cl.bool(true));
  });

  it("credits a partial repay's flooring remainder to the LP bucket", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);
    update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
    mint_token("mock-btc", 20_000_000_000, borrower);
    add_collateral("mock-btc", 20_000_000_000, deployer, borrower);
    borrow(18_000_000_000, borrower);
    simnet.mineEmptyBlocks(5_000);
    accrueInterest();
    freezeInterestAccrual();

    const split = expectedSplit(1n);
    expect(split.remainder, "the scenario must exercise a flooring remainder").toBe(1n);
    expect(split.principalPart, "a 1-unit repay must be pure interest").toBe(0n);

    const before = buckets();
    const beforeBorrowable = borrowableBalance();
    const beforeReserve = reserveBalance();

    repay(1, borrower);

    const after = buckets();
    expect(totalOpenInterest()).toBe(
      before.lp + before.staked + before.protocol - 1n
    );
    expect(after.lp).toBe(before.lp - 1n);
    expect(after.staked).toBe(before.staked);
    expect(after.protocol).toBe(before.protocol);
    expect(borrowableBalance()).toBe(beforeBorrowable + 1n);
    expect(reserveBalance()).toBe(beforeReserve);
    expect(
      after.lp >= totalBorrowedAmount(),
      "LP open interest must still cover total borrowed after the split"
    ).toBe(true);
  });

  it("assigns a two-unit remainder when all three interest buckets are funded", async () => {
    openStakedMarket();
    simnet.mineEmptyBlocks(5_000);
    accrueInterest();
    freezeInterestAccrual();

    // Pick the repay that makes the borrower's interest portion exactly 3, the
    // smallest value where three funded buckets floor two units away.
    const totalBorrowed = totalBorrowedAmount();
    const totalInterest = totalOpenInterest() - totalBorrowed;
    const repayAmount = (2n * (totalBorrowed + totalInterest)) / totalInterest + 1n;
    const split = expectedSplit(repayAmount);
    expect(split.interestPart, "the repay must carry exactly 3 interest units").toBe(3n);
    expect(split.remainder, "the scenario must exercise a two-unit remainder").toBe(2n);
    expect(split.stakedPart).toBe(0n);
    expect(split.protocolPart).toBe(0n);
    expect(
      split.lpInterest >= split.lpPart + split.remainder,
      "the LP interest must have room for the remainder, or the test proves nothing"
    ).toBe(true);

    const before = buckets();
    const beforeBorrowable = borrowableBalance();
    const beforeReserve = reserveBalance();

    repay(Number(repayAmount), borrower);

    const after = buckets();
    expect(
      after.lp + after.staked + after.protocol,
      "the three buckets must fall by exactly the amount the borrower paid"
    ).toBe(before.lp + before.staked + before.protocol - repayAmount);
    expect(after.lp).toBe(before.lp - (split.principalPart + split.lpPart + 2n));
    expect(after.staked).toBe(before.staked);
    expect(after.protocol).toBe(before.protocol);
    expect(borrowableBalance()).toBe(beforeBorrowable + split.principalPart + split.lpPart + 2n);
    expect(reserveBalance()).toBe(beforeReserve);
    expect(
      after.lp >= totalBorrowedAmount(),
      "LP open interest must still cover total borrowed after the split"
    ).toBe(true);
  });

  it("does not let a remainder consume LP principal backing", async () => {
    openStakedMarket();
    simnet.mineEmptyBlocks(5_000);
    accrueInterest();
    freezeInterestAccrual();

    const totalBorrowed = totalBorrowedAmount();
    const totalInterest = totalOpenInterest() - totalBorrowed;
    const debt = totalBorrowed + totalInterest;
    // Leaves each raw floor one unit short: interest 3, remainder 2, LP interest
    // slack 1. Counting principal as LP room would spend that unit of backing.
    const repayAmount = ((totalInterest - 1n) * debt) / totalInterest;
    const split = expectedSplit(repayAmount);
    expect(split.interestPart, "the repay must leave one interest unit").toBe(totalInterest - 1n);
    expect(split.remainder, "the scenario must exercise a two-unit remainder").toBe(2n);
    expect(
      split.lpInterest - split.lpPart,
      "LP interest slack must be 1, or the case does not discriminate"
    ).toBe(1n);

    mint_token("mock-usdc", Number(debt + 1_000_000_000n), borrower);
    repay(Number(repayAmount), borrower);
    expect(
      buckets().lp >= totalBorrowedAmount(),
      "LP open interest must still cover total borrowed after the split"
    ).toBe(true);

    repay(Number(currentDebt()), borrower);
    expect(totalOpenInterest()).toBe(0n);
  });

  it("falls through to the staked bucket when LP interest cannot absorb the remainder", async () => {
    openStakedMarket();
    const reserve = simnet.callPublicFn(
      "state-v1",
      "set-protocol-reserve-percentage",
      [Cl.uint(30_000_000)],
      deployer
    );
    expect(reserve.result).toBeOk(Cl.bool(true));
    handOverGovernance();
    // A flat 85% of LP-side interest to stakers keeps LP interest small enough
    // that the remainder cannot land there.
    const rewards = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      [Cl.int(0), Cl.int(-1), Cl.uint(99_000_000), Cl.uint(85_000_000)],
      governor
    );
    expect(rewards.result).toBeOk(Cl.bool(true));
    simnet.mineEmptyBlocks(5_000);
    accrueInterest();
    freezeInterestAccrual();

    const totalBorrowed = totalBorrowedAmount();
    const totalInterest = totalOpenInterest() - totalBorrowed;
    const debt = totalBorrowed + totalInterest;
    const repayAmount = ((totalInterest - 2n) * debt) / totalInterest;
    const split = expectedSplit(repayAmount);
    expect(split.interestPart).toBe(totalInterest - 2n);
    expect(split.remainder, "the scenario must exercise a two-unit remainder").toBe(2n);
    expect(
      split.lpInterest < split.lpPart + split.remainder,
      "LP interest must be short of the remainder, or the LP gate is never exercised"
    ).toBe(true);
    expect(
      split.stakedInterest >= split.stakedPart + split.remainder,
      "the staked bucket must have room for the remainder"
    ).toBe(true);

    const before = buckets();
    mint_token("mock-usdc", Number(debt + 1_000_000_000n), borrower);
    repay(Number(repayAmount), borrower);

    const after = buckets();
    expect(after.lp, "the LP bucket must fall by principal plus its interest part").toBe(
      before.lp - (split.principalPart + split.lpPart)
    );
    expect(
      after.staked,
      "the staked bucket must fall by its interest part plus the remainder"
    ).toBe(before.staked - (split.stakedPart + split.remainder));
    expect(after.protocol, "the protocol bucket must fall by its interest part").toBe(
      before.protocol - split.protocolPart
    );
    expect(after.lp + after.staked + after.protocol).toBe(
      before.lp + before.staked + before.protocol - repayAmount
    );
  });

  it("falls through to the staked bucket on a near-total liquidation", async () => {
    openStakedMarket();
    const reserve = simnet.callPublicFn(
      "state-v1",
      "set-protocol-reserve-percentage",
      [Cl.uint(30_000_000)],
      deployer
    );
    expect(reserve.result).toBeOk(Cl.bool(true));
    update_supported_collateral(
      "mock-btc",
      98_000_000,
      Number(LIQUIDATION_LTV),
      Number(LIQUIDATION_PREMIUM),
      8,
      deployer
    );
    handOverGovernance();
    const rewards = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      [Cl.int(0), Cl.int(-1), Cl.uint(99_000_000), Cl.uint(99_998_571)],
      governor
    );
    expect(rewards.result).toBeOk(Cl.bool(true));
    simnet.mineEmptyBlocks(5_000);
    accrueInterest();
    freezeInterestAccrual();

    const snapshot = readSplitState();
    // These settings leave a liquidation with a tiny residual debt and no
    // collateral; pick the price whose repay puts the borrower's interest
    // portion one unit short of every bucket's floor.
    const boundaryCv = ceilDiv(snapshot.debt * ONE, ONE - LIQUIDATION_PREMIUM);
    const firstPrice = ceilDiv(boundaryCv * ONE, COLLATERAL_SATS);
    let chosen: { price: bigint; repay: bigint; split: ReturnType<typeof splitAt> } | null = null;
    for (let step = 0n; step < 5_000n && chosen === null; step++) {
      const price = firstPrice + step;
      const outcome = liquidationAt(price, snapshot);
      if (outcome === null || outcome.badDebt) continue;
      if (outcome.health > 102_000_000n) continue;
      const split = splitAt(snapshot, outcome.repay);
      if (split.remainder !== 2n) continue;
      if (!(split.lpInterest < split.lpPart + split.remainder)) continue;
      if (!(split.stakedInterest >= split.stakedPart + split.remainder)) continue;
      chosen = { price, repay: outcome.repay, split };
    }
    expect(
      chosen,
      "the state must admit a near-total liquidation where the staked bucket absorbs the remainder"
    ).not.toBeNull();

    await set_price_without_scaling("mock-btc", chosen!.price, deployer);
    mint_token("mock-usdc", 20_000_000_000, depositor);
    simnet.mineEmptyBlocks(6);

    const before = snapshot.buckets;
    const liquidation = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        btc,
        Cl.principal(borrower),
        Cl.uint(Number(snapshot.debt)),
        Cl.uint(0),
      ],
      depositor
    );
    expect(liquidation.result).toBeOk(Cl.bool(true));
    const events = liquidation.events.map((e: any) => e.data?.value?.value);
    expect(
      events.find((e: any) => e?.["action"]?.value === "socialized-bad-debt"),
      "bad debt must stay clear, or the deltas include a second split"
    ).toBeUndefined();
    const liquidationEvent = events.find(
      (e: any) => e?.["action"]?.value === "liquidate-collateral"
    );
    const repaidAmount = liquidationEvent["repaid-amount"].value as bigint;
    expect(repaidAmount, "the contract must repay what the search predicted").toBe(
      chosen!.repay
    );

    const parts = applyRemainder(chosen!.split);
    expect(
      parts.stakedPart,
      "the staked bucket must absorb the two-unit remainder"
    ).toBe(chosen!.split.stakedPart + chosen!.split.remainder);

    const after = buckets();
    expect(after.lp, "the LP bucket must fall by principal plus its interest part").toBe(
      before.lp - (chosen!.split.principalPart + parts.lpPart)
    );
    expect(
      after.staked,
      "the staked bucket must fall by its interest part plus the remainder"
    ).toBe(before.staked - parts.stakedPart);
    expect(after.protocol, "the protocol bucket must fall by its interest part").toBe(
      before.protocol - parts.protocolPart
    );
    expect(after.lp + after.staked + after.protocol).toBe(
      before.lp + before.staked + before.protocol - repaidAmount
    );
    expect(
      after.lp >= totalBorrowedAmount(),
      "LP open interest must still cover total borrowed after the split"
    ).toBe(true);
  });

  it("keeps the split conserving on a partial liquidation", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);
    update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
    mint_token("mock-btc", 20_000_000_000, borrower);
    add_collateral("mock-btc", 20_000_000_000, deployer, borrower);
    borrow(18_000_000_000, borrower);
    simnet.mineEmptyBlocks(500);
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);
    update_supported_collateral("mock-btc", 40_000_000, 50_000_000, 2_000_000, 8, deployer);
    mint_token("mock-usdc", 18_181_818_181, depositor);
    simnet.mineEmptyBlocks(6);
    accrueInterest();
    freezeInterestAccrual();

    const snapshot = readSplitState();
    const beforeBorrowable = borrowableBalance();
    const beforeReserve = reserveBalance();

    const liquidation = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        btc,
        Cl.principal(borrower),
        Cl.uint(18_181_818_181),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidation.result).toBeOk(Cl.bool(true));
    const event = liquidation.events.find(
      (e: any) => e.data?.value?.value?.["action"]?.value === "liquidate-collateral"
    );
    expect(event, "the liquidation print event carries the repaid amount").toBeDefined();
    const repaidAmount = (event as any).data.value.value["repaid-amount"].value as bigint;

    const split = splitAt(snapshot, repaidAmount);
    expect(
      split.remainder,
      "the repaid amount must exercise a flooring remainder, or this test proves nothing"
    ).toBe(1n);

    const after = buckets();
    expect(
      after.lp + after.staked + after.protocol,
      "the three buckets must fall by exactly the amount the liquidator paid"
    ).toBe(snapshot.buckets.lp + snapshot.buckets.staked + snapshot.buckets.protocol - repaidAmount);
    expect(after.lp).toBe(snapshot.buckets.lp - (split.principalPart + split.lpPart + split.remainder));
    expect(after.staked).toBe(snapshot.buckets.staked - split.stakedPart);
    expect(after.protocol).toBe(snapshot.buckets.protocol - split.protocolPart);
    expect(borrowableBalance() + reserveBalance()).toBe(
      beforeBorrowable + beforeReserve + repaidAmount
    );
    expect(
      after.lp >= totalBorrowedAmount(),
      "LP open interest must still cover total borrowed after the split"
    ).toBe(true);
  });

  it("keeps the split conserving when bad debt is socialized", async () => {
    mint_token("mock-usdc", 10_000_000_000_000, depositor);
    deposit(10_000_000_000_000, depositor);
    update_supported_collateral("mock-btc", 50_000_000, 65_000_000, 10_000_000, 8, deployer);
    for (const user of [borrower, borrower2]) {
      mint_token("mock-btc", 10_000_000_000_000, user);
      add_collateral("mock-btc", 10_000_000_000_000, deployer, user);
      borrow(5_000_000_000_000, user);
    }
    simnet.mineEmptyBlocks(3_000);
    accrueInterest();
    freezeInterestAccrual();

    await set_price_without_scaling("mock-btc", 50_000_000n, deployer);
    mint_token("mock-usdc", 20_000_000_000_000, liquidator);

    const snapshot = readSplitState();
    const liquidation = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        btc,
        Cl.principal(borrower),
        Cl.uint(20_000_000_000_000),
        Cl.uint(0),
      ],
      liquidator
    );
    expect(liquidation.result).toBeOk(Cl.bool(true));
    const events = liquidation.events.map((e: any) => e.data?.value?.value);
    const liquidateEvent = events.find(
      (e: any) => e?.["action"]?.value === "liquidate-collateral"
    );
    const socializedEvent = events.find(
      (e: any) => e?.["action"]?.value === "socialized-bad-debt"
    );
    expect(socializedEvent, "the position must reach socialization").toBeDefined();
    const repaidAmount = liquidateEvent["repaid-amount"].value as bigint;
    const socializedAmount = socializedEvent["amount"].value as bigint;

    const liquidateSplit = splitAt(snapshot, repaidAmount);
    const liquidateParts = applyRemainder(liquidateSplit);
    const postLiquidateBuckets = {
      lp: snapshot.buckets.lp - (liquidateSplit.principalPart + liquidateParts.lpPart),
      staked: snapshot.buckets.staked - liquidateParts.stakedPart,
      protocol: snapshot.buckets.protocol - liquidateParts.protocolPart,
    };
    const socializeSplit = splitAt(
      {
        buckets: postLiquidateBuckets,
        debt: socializedAmount,
        borrowedAmount: snapshot.borrowedAmount - liquidateSplit.principalPart,
        totalBorrowed: snapshot.totalBorrowed - liquidateSplit.principalPart,
      },
      socializedAmount
    );
    const socializeParts = applyRemainder(socializeSplit);

    expect(
      socializedEvent["lp-part"].value,
      "lp-part must carry principal plus the LP interest part"
    ).toBe(socializeSplit.principalPart + socializeParts.lpPart);
    expect(
      socializedEvent["staked-part"].value,
      "staked-part must be the staked bucket's share"
    ).toBe(socializeParts.stakedPart);
    expect(
      socializedEvent["protocol-part"].value,
      "protocol-part must be the protocol bucket's share"
    ).toBe(socializeParts.protocolPart);

    const after = buckets();
    expect(after.lp, "the LP bucket must fall by both splits' LP parts").toBe(
      postLiquidateBuckets.lp - (socializeSplit.principalPart + socializeParts.lpPart)
    );
    expect(after.staked, "the staked bucket must fall by both splits' staked parts").toBe(
      postLiquidateBuckets.staked - socializeParts.stakedPart
    );
    expect(after.protocol, "the protocol bucket must fall by both splits' protocol parts").toBe(
      postLiquidateBuckets.protocol - socializeParts.protocolPart
    );
    expect(
      after.lp + after.staked + after.protocol,
      "both splits must reduce the buckets by exactly what was repaid and socialized"
    ).toBe(
      snapshot.buckets.lp +
        snapshot.buckets.staked +
        snapshot.buckets.protocol -
        repaidAmount -
        socializedAmount
    );
    expect(
      after.lp >= totalBorrowedAmount(),
      "LP open interest must still cover total borrowed after both splits"
    ).toBe(true);
  });

  it("leaves no residue when the last position closes", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);
    update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
    mint_token("mock-btc", 20_000_000_000, borrower);
    add_collateral("mock-btc", 20_000_000_000, deployer, borrower);
    borrow(18_000_000_000, borrower);
    simnet.mineEmptyBlocks(5_000);
    accrueInterest();
    freezeInterestAccrual();

    const debt = currentDebt();
    mint_token("mock-usdc", Number(debt - 18_000_000_000n), borrower);
    repay(Number(debt), borrower);

    const after = buckets();
    expect(after.lp + after.staked + after.protocol).toBe(0n);
    expect(positionOf()["debt-shares"].value).toBe(0n);
  });
});
