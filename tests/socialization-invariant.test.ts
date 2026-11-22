// state-v1::socialize-user-bad-debt subtracts the three split parts from the
// open-interest buckets with a plain `-`, and the LP part also has to cover the
// written-off principal. This runs a real bad-debt liquidation through the dust
// sweep on a live-like book (two borrowers, accruing interest, active and queued
// staking, a funded protocol reserve) and pins the LP part against the bucket it
// is subtracted from at the call, not just against the end state.
import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType, contractPrincipalCV } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  initialize_ir,
  initialize_lp,
  initialize_staking,
  initialize_staking_reward,
  mint_token,
  set_allowed_contracts,
  set_asset_cap,
  update_supported_collateral,
} from "./utils";
import {
  build_price_update,
  init_pyth,
  set_initial_price,
  set_price_without_scaling,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const victim = accounts.get("wallet_1")!;
const otherBorrower = accounts.get("wallet_2")!;
const staker = accounts.get("wallet_3")!;
const depositor = accounts.get("wallet_4")!;
const liquidator = accounts.get("wallet_5")!;
const governor = accounts.get("wallet_6")!;
const btc = contractPrincipalCV(deployer, "mock-btc");

const ONE_USDC = 100_000_000n; // 8 decimals, same as the price scaling factor
const ONE_BTC = 100_000_000n; // sats
const DEPOSIT_MAIN = 100_000_000_000_000n; // $100,000
const DEPOSIT_SECOND = 30_000_000_000_000n; // $30,000
const STAKE_MAIN = 20_000_000_000_000n; // $20,000 of the main LP's tokens
const STAKE_SECOND = 10_000_000_000_000n; // $10,000
const QUEUED_SECOND = 2_000_000_000_000n; // $2,000 moved into an unfinalized withdrawal
const BORROW = 3_000_000_000_000n; // $30,000 against 1 BTC+101 sats at $60,000
const RESERVE_DEPOSIT = 1_000_000_000_000n; // $10,000 funded into the protocol reserve
const PROTOCOL_RESERVE_PERCENTAGE = 25_000_000n; // 25% of interest

// The dust-sweep trigger: a price carrying cents strands the last satoshi of a
// 1 BTC + 101 sats balance, so the sweep empties the collateral and the existing
// zero-collateral gate opens the socialization path.
const PRICE_OPEN = 60_000n; // whole dollars, fed through set_initial_price
const PRICE_UNDERWATER = 2_013_742_000_000n; // $20,137.42, raw 1e8 fixed point

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

const positionOf = (user: string) =>
  ro("state-v1", "get-user-position", [Cl.principal(user)]).value.value as any;

const totalBorrowedOf = (user: string) =>
  ro("state-v1", "get-borrow-repay-params", [Cl.principal(user)]).value[
    "total-borrowed-amount"
  ].value as bigint;

const totalDebtShares = () =>
  ro("state-v1", "get-debt-params").value["total-debt-shares"].value as bigint;

const collateralLeft = (user: string): bigint => {
  const res = ro("state-v1", "get-user-collateral", [
    Cl.principal(user),
    Cl.contractPrincipal(deployer, "mock-btc"),
  ]);
  return res.type === ClarityType.OptionalSome ? (res.value.value["amount"].value as bigint) : 0n;
};

const activeStaked = () => ro("staking-v1", "get-active-staked-lp-tokens").value as bigint;
const totalStaked = () => ro("staking-v1", "get-total-staked-lp-tokens").value as bigint;
const reserveBalance = () => ro("state-v1", "get-reserve-balance").value as bigint;

const eventTuples = (tx: any): any[] =>
  tx.events.map((e: any) => e.data?.value?.value).filter(Boolean);

const findAction = (tx: any, action: string) =>
  eventTuples(tx).find((e: any) => e?.["action"]?.value === action);

// The state the split arithmetic reads, mirroring get-borrow-repay-params and
// convert-to-debt-assets.
const readSplitState = (user: string) => {
  const position = positionOf(user);
  return {
    buckets: buckets(),
    borrowedAmount: position["borrowed-amount"].value as bigint,
    debt: ro("math-v1", "convert-to-debt-assets", [
      ro("state-v1", "get-debt-params"),
      Cl.uint(position["debt-shares"].value),
      Cl.bool(true),
    ]).value as bigint,
    totalBorrowed: totalBorrowedOf(user),
  };
};

// Mirrors liquidator-v1's three floor divisions and the remainder they leave.
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
  const divide = (numerator: bigint) => (denominator === 0n ? 0n : numerator / denominator);
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

// The conserve-interest-split assignment order: LP, then staked, then protocol.
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

const handOverGovernanceAndFreezeInterest = () => {
  expect(
    simnet.callPublicFn("state-v1", "update-governance", [Cl.principal(governor)], deployer).result
  ).toBeOk(Cl.bool(true));
  expect(
    simnet.callPublicFn(
      "linear-kinked-ir-v1",
      "update-ir-params",
      [Cl.uint(0), Cl.uint(0), Cl.uint(0), Cl.uint(0)],
      governor
    ).result
  ).toBeOk(Cl.bool(true));
};

// An empty batch accrues interest without touching a position, so the snapshot
// below is taken after the live curve has run and before it is frozen.
const accrueInterest = () => {
  const accrual = simnet.callPublicFn(
    "liquidator-v1",
    "batch-liquidate",
    [Cl.buffer(build_price_update()), btc, Cl.list([])],
    depositor
  );
  expect(accrual.result).toBeOk(Cl.bool(true));
};

describe("bad-debt socialization against a live-like shared book", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 100_000_000_000_000_000n);
    initialize_ir(deployer); // real kinked curve: base 30%, slopes above
    initialize_staking_reward(deployer); // 30% of LP-side interest to stakers
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", PRICE_OPEN, deployer);
    expect(
      simnet.callPublicFn(
        "state-v1",
        "set-protocol-reserve-percentage",
        [Cl.uint(PROTOCOL_RESERVE_PERCENTAGE)],
        deployer
      ).result
    ).toBeOk(Cl.bool(true));

    // Two LPs fund the book out of two different positions.
    mint_token("mock-usdc", Number(DEPOSIT_MAIN), depositor);
    deposit(Number(DEPOSIT_MAIN), depositor);
    mint_token("mock-usdc", Number(DEPOSIT_SECOND), staker);
    deposit(Number(DEPOSIT_SECOND), staker);

    // Live staking with both active and queued balances at liquidation time.
    initialize_staking(deployer);
    expect(
      simnet.callPublicFn("staking-v1", "stake", [Cl.uint(STAKE_MAIN)], depositor).result
    ).toBeOk(Cl.bool(true));
    expect(
      simnet.callPublicFn("staking-v1", "stake", [Cl.uint(STAKE_SECOND)], staker).result
    ).toBeOk(Cl.bool(true));
    expect(
      simnet.callPublicFn("staking-v1", "initiate-unstake", [Cl.uint(QUEUED_SECOND)], staker)
        .result
    ).toBeOk(Cl.uint(0));

    // The shared book: two borrowing positions on the same collateral.
    update_supported_collateral("mock-btc", 50_000_000, 65_000_000, 10_000_000, 8, deployer);
    for (const who of [victim, otherBorrower]) {
      mint_token("mock-btc", Number(ONE_BTC + 101n), who);
      add_collateral("mock-btc", Number(ONE_BTC + 101n), deployer, who);
      borrow(Number(BORROW), who);
    }

    // Real interest: let the live curve accrue into all three buckets, then
    // freeze it so the snapshot below is exactly what the liquidation reads.
    simnet.mineEmptyBlocks(3_000);
    accrueInterest();
    handOverGovernanceAndFreezeInterest();

    // Fund the protocol reserve so the write-off's reserve leg has cash behind it.
    mint_token("mock-usdc", Number(RESERVE_DEPOSIT), governor);
    expect(
      simnet.callPublicFn("state-v1", "deposit-to-reserve", [Cl.uint(RESERVE_DEPOSIT)], governor)
        .result
    ).toBeOk(Cl.bool(true));

    mint_token("mock-usdc", Number(DEPOSIT_MAIN), liquidator);
    await set_price_without_scaling("mock-btc", PRICE_UNDERWATER, deployer);
  });

  it("keeps every split part inside the bucket state-v1 subtracts it from", () => {
    // The config is live-like before the liquidation, or the run proves nothing.
    const before = buckets();
    expect(before.lp, "the LP bucket must carry principal and interest").toBeGreaterThan(0n);
    expect(before.staked, "the staked bucket must carry interest").toBeGreaterThan(0n);
    expect(before.protocol, "the protocol bucket must carry interest").toBeGreaterThan(0n);
    expect(totalStaked(), "staking must have queued tokens").toBeGreaterThan(activeStaked());
    expect(reserveBalance(), "the protocol reserve must be funded").toBe(RESERVE_DEPOSIT);

    const snapshot = readSplitState(victim);
    expect(snapshot.debt, "interest must have accrued on the victim").toBeGreaterThan(
      snapshot.borrowedAmount
    );
    expect(
      snapshot.buckets.lp - snapshot.totalBorrowed,
      "the LP bucket must carry interest room for the split"
    ).toBeGreaterThan(0n);

    const liquidation = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        btc,
        Cl.principal(victim),
        Cl.uint(DEPOSIT_MAIN),
        Cl.uint(1),
      ],
      liquidator
    );
    // A revert here is the underflow this test exists to catch: state-v1
    // subtracts all four operands with a plain `-`.
    expect(liquidation.result, "the liquidation must not underflow").toBeOk(Cl.bool(true));

    const liquidationEvent = findAction(liquidation, "liquidate-collateral");
    const socializeEvent = findAction(liquidation, "socialized-bad-debt");
    expect(liquidationEvent, "the liquidation print must exist").toBeDefined();
    expect(socializeEvent, "the swept position must socialize").toBeDefined();

    // Prove the run went through the sweep rather than an exact-zero seizure.
    const swept = liquidationEvent["swept"];
    expect(swept.type, "the unseizable satoshi must be swept").toBe(ClarityType.OptionalSome);
    expect(swept.value.value["computed"].value).toBe(ONE_BTC + 100n);
    expect(swept.value.value["given"].value).toBe(ONE_BTC + 101n);
    expect(collateralLeft(victim), "the sweep must empty the collateral").toBe(0n);

    // Rebuild the buckets the socialization call subtracts from: the snapshot
    // minus the liquidation's own split, which state-v1 applies first.
    const repaidAmount = liquidationEvent["repaid-amount"].value as bigint;
    const liquidateSplit = splitAt(snapshot, repaidAmount);
    const liquidateParts = applyRemainder(liquidateSplit);
    const atSocialize = {
      buckets: {
        lp: snapshot.buckets.lp - (liquidateSplit.principalPart + liquidateParts.lpPart),
        staked: snapshot.buckets.staked - liquidateParts.stakedPart,
        protocol: snapshot.buckets.protocol - liquidateParts.protocolPart,
      },
      borrowedAmount: snapshot.borrowedAmount - liquidateSplit.principalPart,
      debt: socializeEvent["amount"].value as bigint,
      totalBorrowed: snapshot.totalBorrowed - liquidateSplit.principalPart,
    };
    expect(atSocialize.buckets.lp, "the reconstruction must stay a real bucket").toBeGreaterThan(
      0n
    );

    const lpPart = socializeEvent["lp-part"].value as bigint;
    const stakedPart = socializeEvent["staked-part"].value as bigint;
    const protocolPart = socializeEvent["protocol-part"].value as bigint;
    const socializedAmount = socializeEvent["amount"].value as bigint;

    // The invariant under test, asserted against the bucket at the subtraction.
    expect(lpPart, "lp-part must fit inside lp-open-interest at the subtraction").toBeLessThanOrEqual(
      atSocialize.buckets.lp
    );
    expect(stakedPart, "staked-part must fit inside staked-open-interest").toBeLessThanOrEqual(
      atSocialize.buckets.staked
    );
    expect(protocolPart, "protocol-part must fit inside protocol-open-interest").toBeLessThanOrEqual(
      atSocialize.buckets.protocol
    );

    expect(lpPart, "the shared book must leave visible headroom").toBeLessThan(
      atSocialize.buckets.lp
    );

    // The parts must be the split the source computes, not merely under the
    // bucket: the shared book leaves enough headroom that an over-allocation of
    // a few units would not underflow.
    const socializeSplit = splitAt(atSocialize, socializedAmount);
    const socializeParts = applyRemainder(socializeSplit);
    expect(socializeSplit.lpInterest, "the LP split must carry interest").toBeGreaterThan(0n);
    expect(lpPart, "lp-part = principal plus the LP interest share").toBe(
      socializeSplit.principalPart + socializeParts.lpPart
    );
    expect(stakedPart, "staked-part is the staked interest share").toBe(
      socializeParts.stakedPart
    );
    expect(protocolPart, "protocol-part is the protocol interest share").toBe(
      socializeParts.protocolPart
    );
    expect(
      lpPart + stakedPart + protocolPart,
      "the three parts must sum to the socialized amount"
    ).toBe(socializedAmount);

    // Every one of the four plain subtractions landed where the split said.
    const after = buckets();
    expect(after.lp).toBe(atSocialize.buckets.lp - lpPart);
    expect(after.staked).toBe(atSocialize.buckets.staked - stakedPart);
    expect(after.protocol).toBe(atSocialize.buckets.protocol - protocolPart);
    expect(totalBorrowedOf(victim), "the written-off principal is gone from the book").toBe(
      atSocialize.totalBorrowed - atSocialize.borrowedAmount
    );
    expect(positionOf(victim)["debt-shares"].value, "the position's shares are zeroed").toBe(0n);
    expect(totalDebtShares(), "the global shares fall by the position's shares").toBeGreaterThan(
      0n
    );
    expect(collateralLeft(otherBorrower), "the other borrower is untouched").toBe(ONE_BTC + 101n);
  });
});
