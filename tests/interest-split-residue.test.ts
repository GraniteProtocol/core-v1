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

const currentDebt = () => {
  const position = positionOf();
  return ro("math-v1", "convert-to-debt-assets", [
    ro("state-v1", "get-debt-params"),
    Cl.uint(position["debt-shares"].value),
    Cl.bool(true),
  ]).value as bigint;
};

// Mirrors borrower-v1 / liquidator-v1's three floor divisions and the remainder
// they leave behind, so a test can prove it exercises the case it claims to.
const expectedSplit = (repayAmount: bigint) => {
  const b = buckets();
  const position = positionOf();
  const debt = currentDebt();
  const borrowed = position["borrowed-amount"].value as bigint;
  const effectiveBorrowed = debt < borrowed ? debt : borrowed;
  const interestAccrued = debt - effectiveBorrowed;
  const interestPart = (interestAccrued * repayAmount + debt - 1n) / debt;
  const principalPart = repayAmount - interestPart;
  const totalBorrowed = totalBorrowedAmount();
  const lpInterest = b.lp > totalBorrowed ? b.lp - totalBorrowed : 0n;
  const denominator = totalOpenInterest() > totalBorrowed ? totalOpenInterest() - totalBorrowed : 0n;
  const divide = (numerator: bigint) =>
    denominator === 0n ? 0n : numerator / denominator;
  const lpPart = divide(interestPart * lpInterest);
  const stakedPart = divide(interestPart * b.staked);
  const protocolPart = divide(interestPart * b.protocol);
  return {
    interestPart,
    principalPart,
    lpPart,
    stakedPart,
    protocolPart,
    remainder: interestPart - (lpPart + stakedPart + protocolPart),
    lpBucket: b.lp,
  };
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

// The borrower's spread is already in the book; zeroing the curve lets a test
// read state and then transact without the transaction's own accrual moving it.
const freezeInterestAccrual = () => {
  const handOverGovernance = simnet.callPublicFn(
    "state-v1",
    "update-governance",
    [Cl.principal(governor)],
    deployer
  );
  expect(handOverGovernance.result).toBeOk(Cl.bool(true));
  const freeze = simnet.callPublicFn(
    "linear-kinked-ir-v1",
    "update-ir-params",
    [Cl.uint(0), Cl.uint(0), Cl.uint(0), Cl.uint(0)],
    governor
  );
  expect(freeze.result).toBeOk(Cl.bool(true));
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
      split.lpBucket >= split.principalPart + split.lpPart + split.remainder,
      "the LP bucket must have room for the remainder, or the test proves nothing"
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
      split.lpBucket - totalBorrowed - split.lpPart,
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

  it("keeps the empty staked bucket at zero across a sweep of partial repays", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);
    update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
    mint_token("mock-btc", 20_000_000_000, borrower);
    add_collateral("mock-btc", 20_000_000_000, deployer, borrower);
    borrow(18_000_000_000, borrower);
    simnet.mineEmptyBlocks(5_000);
    accrueInterest();
    freezeInterestAccrual();

    expect(ro("staking-v1", "get-total-staked-lp-tokens").value).toBe(0n);

    // Repays of 1 and 2 units always leave a flooring remainder here; routing
    // it to the empty staked bucket is the pre-#54 underflow that reverted them.
    for (const amount of [1n, 2n, 1n]) {
      const split = expectedSplit(amount);
      expect(split.remainder, "each repay must carry a remainder").toBeGreaterThan(0n);
      const before = buckets();
      repay(Number(amount), borrower);
      const after = buckets();
      expect(after.staked).toBe(before.staked);
      expect(after.lp + after.staked + after.protocol).toBe(
        before.lp + before.staked + before.protocol - amount
      );
    }
    expect(
      buckets().lp >= totalBorrowedAmount(),
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

    const split = expectedSplit(18_181_818_181n);
    expect(split.remainder, "the scenario must exercise a flooring remainder").toBeGreaterThan(0n);

    const before = buckets();
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

    const after = buckets();
    expect(
      after.lp + after.staked + after.protocol,
      "the three buckets must fall by exactly the amount the liquidator paid"
    ).toBe(before.lp + before.staked + before.protocol - repaidAmount);
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

    const before = buckets();
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

    const after = buckets();
    expect(
      after.lp + after.staked + after.protocol,
      "both splits must reduce the buckets by exactly what was repaid and socialized"
    ).toBe(before.lp + before.staked + before.protocol - repaidAmount - socializedAmount);
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
