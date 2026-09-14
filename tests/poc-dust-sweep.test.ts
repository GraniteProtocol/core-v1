// A liquidation must not leave behind collateral that nothing can seize at the
// current price, because that remainder holds collateral value above zero and
// keeps the bad-debt writedown shut while every later attempt fails on a
// zero-amount transfer.
//
// Live sBTC parameters throughout: max-LTV 50%, liquidation-LTV 65%, premium 10%.

import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType, contractPrincipalCV } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  getUserBalance,
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
const depositor = accounts.get("wallet_4")!;
const borrower = accounts.get("wallet_1")!;
const liquidator = accounts.get("wallet_5")!;
const otherBorrower = accounts.get("wallet_2")!;
const staker = accounts.get("wallet_3")!;
const btc_collateral = contractPrincipalCV(deployer, "mock-btc");
const eth_collateral = contractPrincipalCV(deployer, "mock-eth");

const ONE_BTC = 100_000_000;
const DEPOSIT = 10_000_000_000_000; // $100,000
const BORROW = 3_000_000_000_000; // $30,000, half the collateral value at open

// Prices carry cents, as a real feed does. A whole-dollar price divides evenly
// and hides the defect completely.
const PRICE_OPEN = 60_000n;
const PRICE_UNDERWATER = 2_013_742_000_000n; // $20,137.42
const PRICE_PARTIAL = 4_521_355_000_000n; // $45,213.55
const PRICE_ETH = 2_000_370_000_000n; // $20,003.70

const initialize_ir_zero = (deployer: string) => {
  const res = simnet.callPublicFn(
    "linear-kinked-ir-v1",
    "update-ir-params",
    [Cl.uint(0), Cl.uint(0), Cl.uint(700_000_000_000), Cl.uint(0)],
    deployer,
  );
  expect(res.result.type).toBe(ClarityType.ResponseOk);
};

const openPosition = (collateralSats: number) => {
  mint_token("mock-usdc", DEPOSIT, depositor);
  deposit(DEPOSIT, depositor);

  update_supported_collateral("mock-btc", 50_000_000, 65_000_000, 10_000_000, 8, deployer);
  mint_token("mock-btc", collateralSats, borrower);
  add_collateral("mock-btc", collateralSats, deployer, borrower);
  borrow(BORROW, borrower);

  mint_token("mock-usdc", DEPOSIT, liquidator);
  simnet.mineEmptyBlocks(6);
};

// A main collateral plus a small second one, so the repay cap for the second
// comes from its own value rather than the position's.
const openTwoCollateralPosition = async (ethUnits: number) => {
  update_supported_collateral("mock-eth", 50_000_000, 65_000_000, 10_000_000, 8, deployer);
  await set_initial_price("mock-eth", 1n, deployer);
  await set_price_without_scaling("mock-eth", PRICE_ETH, deployer);

  mint_token("mock-usdc", DEPOSIT, depositor);
  deposit(DEPOSIT, depositor);
  update_supported_collateral("mock-btc", 50_000_000, 65_000_000, 10_000_000, 8, deployer);
  mint_token("mock-btc", ONE_BTC, borrower);
  add_collateral("mock-btc", ONE_BTC, deployer, borrower);
  mint_token("mock-eth", ethUnits, borrower);
  add_collateral("mock-eth", ethUnits, deployer, borrower);
  borrow(BORROW, borrower);
  mint_token("mock-usdc", DEPOSIT, liquidator);
  simnet.mineEmptyBlocks(6);
};

const liquidate = (collateral: any, repayAmount: number, user: string = borrower) =>
  simnet.callPublicFn(
    "liquidator-v1",
    "liquidate-collateral",
    [
      Cl.buffer(build_price_update()),
      collateral,
      Cl.principal(user),
      Cl.uint(repayAmount),
      Cl.uint(1),
    ],
    liquidator,
  );

const collateralLeft = (collateral: any, user: string = borrower): bigint => {
  const res = simnet.callReadOnlyFn(
    "state-v1",
    "get-user-collateral",
    [Cl.principal(user), collateral],
    deployer,
  );
  if (res.result.type !== ClarityType.OptionalSome) return 0n;
  return res.result.value.value["amount"].value as bigint;
};

const debtShares = (user: string = borrower): bigint => {
  const res = simnet.callReadOnlyFn(
    "state-v1",
    "get-borrow-repay-params",
    [Cl.principal(user)],
    deployer,
  );
  return res.result.value["user-position"].value.value["debt-shares"].value as bigint;
};

const totalAssets = (): bigint => {
  const res = simnet.callReadOnlyFn("state-v1", "get-lp-params", [], deployer);
  return res.result.value["total-assets"].value as bigint;
};

const openInterest = () => {
  const res = simnet.callReadOnlyFn("state-v1", "get-open-interest", [], deployer);
  return {
    lp: res.result.value["lp-open-interest"].value as bigint,
    staked: res.result.value["staked-open-interest"].value as bigint,
    protocol: res.result.value["protocol-open-interest"].value as bigint,
  };
};

const socializeEvent = (liq: any): any =>
  liq.events.find((e: any) => e.data?.value?.value?.["action"]?.value === "socialized-bad-debt");

// The `swept` field is the only record of a seizure the liquidator did not pay
// for in full, so it carries both the computed amount and the amount handed over.
const sweptFromEvent = (liq: any): any => {
  const event = liq.events.find(
    (e: any) => e.data?.value?.value?.["action"]?.value === "liquidate-collateral",
  );
  expect(event, "the liquidation event must be emitted").toBeDefined();
  return event.data.value.value["swept"];
};

const socializedParts = (liq: any) => {
  const event = socializeEvent(liq);
  expect(event, "the write-off must fire for its parts to be readable").toBeDefined();
  const value = event.data.value.value;
  return {
    lp: value["lp-part"].value as bigint,
    staked: value["staked-part"].value as bigint,
    protocol: value["protocol-part"].value as bigint,
  };
};

describe("a liquidation absorbs collateral it cannot seize", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 100_000_000_000_000_000n);
    initialize_ir_zero(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", PRICE_OPEN, deployer);
  });

  it("sweeps an unseizable remainder to the liquidator and socializes in one call", async () => {
    openPosition(ONE_BTC + 101);
    await set_price_without_scaling("mock-btc", PRICE_UNDERWATER, deployer);
    const assetsBefore = totalAssets();

    const res = liquidate(btc_collateral, DEPOSIT);
    expect(res.result.type, "a maximum-repay liquidation of an insolvent position must succeed").toBe(
      ClarityType.ResponseOk,
    );

    expect(collateralLeft(btc_collateral), "the liquidation must not leave a residue").toBe(0n);
    expect(
      getUserBalance(Cl.principal(liquidator), "mock-btc", deployer),
      "the liquidator receives the whole balance including the unseizable unit",
    ).toBe(BigInt(ONE_BTC + 101));
    expect(socializeEvent(res), "an emptied position must socialize its bad debt").toBeDefined();
    expect(debtShares(), "the position must be left with no outstanding debt").toBe(0n);
    expect(totalAssets(), "the uncovered loss must be written down").toBeLessThan(assetsBefore);

    const swept = sweptFromEvent(res);
    expect(swept.type, "a swept seizure must be recorded in the event").toBe(
      ClarityType.OptionalSome,
    );
    expect(
      swept.value.value["computed"].value,
      "the event must record the seizure the math produced",
    ).toBe(BigInt(ONE_BTC + 100));
    expect(
      swept.value.value["given"].value,
      "the event must record the amount actually handed over",
    ).toBe(BigInt(ONE_BTC + 101));
  });

  it("sweeps when a repay already at the allowed maximum seized nothing", async () => {
    // The predicate reconstructs a full-value repay, but repay-allowed is a min
    // of three terms. In the band where the debt term binds, the real seizure is
    // smaller than the predicate assumes and floors to zero while the predicate
    // still reports the balance as seizable.
    const TEN_DEC_UNITS = 100;

    mint_token("mock-usdc", DEPOSIT, depositor);
    deposit(DEPOSIT, depositor);
    update_supported_collateral("mock-btc", 50_000_000, 65_000_000, 10_000_000, 10, deployer);
    await set_price_without_scaling("mock-btc", 18_010_000_000_000n, deployer); // $180,100.00
    mint_token("mock-btc", TEN_DEC_UNITS, borrower);
    add_collateral("mock-btc", TEN_DEC_UNITS, deployer, borrower);
    borrow(90_001, borrower);
    mint_token("mock-usdc", DEPOSIT, liquidator);
    simnet.mineEmptyBlocks(6);
    await set_price_without_scaling("mock-btc", 10_000_000_000_000n, deployer); // $100,000.00

    const res = liquidate(btc_collateral, DEPOSIT);
    expect(
      res.result.type,
      "a maximal repay that seized nothing must still clear the position",
    ).toBe(ClarityType.ResponseOk);

    expect(collateralLeft(btc_collateral), "the unreachable balance must be absorbed").toBe(0n);
    expect(socializeEvent(res), "the emptied position must socialize its bad debt").toBeDefined();
    expect(debtShares(), "the position must be left with no outstanding debt").toBe(0n);
  });

  it("takes only what it paid for when bad debt still has recoverable collateral", async () => {
    openPosition(ONE_BTC + 101);
    await set_price_without_scaling("mock-btc", PRICE_UNDERWATER, deployer);
    const assetsBefore = totalAssets();

    const res = liquidate(btc_collateral, 100_000_000_000);
    expect(res.result.type, "a partial liquidation of an insolvent position must succeed").toBe(
      ClarityType.ResponseOk,
    );

    expect(
      collateralLeft(btc_collateral),
      "recoverable collateral must not be swept along with a partial repayment",
    ).toBeGreaterThan(90_000_000n);
    expect(
      getUserBalance(Cl.principal(liquidator), "mock-btc", deployer),
      "the liquidator receives only the collateral its repayment bought",
    ).toBeLessThan(10_000_000n);
    expect(socializeEvent(res), "collateral still remains, so nothing is written off").toBeUndefined();
    expect(debtShares(), "the debt must survive a partial liquidation").toBeGreaterThan(0n);
    expect(totalAssets(), "no write-down while collateral is recoverable").toBe(assetsBefore);
    expect(
      sweptFromEvent(res).type,
      "an ordinary seizure must record no sweep",
    ).toBe(ClarityType.OptionalNone);
  });

  it("keeps a remainder that is still seizable, down to two units", async () => {
    // Two units convert back to one, so they are seizable and must survive. One
    // unit converts back to zero and is what the sweep exists for.
    await openTwoCollateralPosition(3);
    await set_price_without_scaling("mock-btc", PRICE_UNDERWATER, deployer);

    const res = liquidate(eth_collateral, 20_000);
    expect(res.result.type, "a partial liquidation of the second collateral must succeed").toBe(
      ClarityType.ResponseOk,
    );

    expect(
      collateralLeft(eth_collateral),
      "a two-unit remainder is seizable and must not be handed over",
    ).toBe(2n);
  });

  it("does not sweep a solvent position, and a dust-only seizure there still reverts", async () => {
    await openTwoCollateralPosition(7);
    // Unhealthy but comfortably solvent: the btc leg still covers the debt.
    await set_price_without_scaling("mock-btc", PRICE_PARTIAL, deployer);

    const res = liquidate(eth_collateral, DEPOSIT);
    expect(res.result.type, "liquidating a secondary collateral must succeed").toBe(
      ClarityType.ResponseOk,
    );
    expect(
      collateralLeft(eth_collateral),
      "a solvent position keeps the unseizable remainder instead of gifting it",
    ).toBe(1n);
    expect(socializeEvent(res), "a solvent position must not be socialized").toBeUndefined();
    expect(debtShares(), "a solvent position keeps its debt").toBeGreaterThan(0n);

    // The remainder is now the whole balance and converts to a zero seizure.
    expect(
      liquidate(eth_collateral, DEPOSIT).result,
      "a zero seizure on a solvent position is rejected as a null transfer",
    ).toBeErr(Cl.uint(101));
  });

  it("absorbs a multi-unit residue when the collateral out-precisions the market token", async () => {
    // The collateral carries more decimals than the market token, so the value
    // conversion divides and the seizure quantizes onto multiples of 100.
    const TEN_DEC_BALANCE = 10_000_000_137; // 1.0000000137 at 10 decimals

    mint_token("mock-usdc", DEPOSIT, depositor);
    deposit(DEPOSIT, depositor);
    update_supported_collateral("mock-btc", 50_000_000, 65_000_000, 10_000_000, 10, deployer);
    mint_token("mock-btc", TEN_DEC_BALANCE, borrower);
    add_collateral("mock-btc", TEN_DEC_BALANCE, deployer, borrower);
    borrow(BORROW, borrower);
    mint_token("mock-usdc", DEPOSIT, liquidator);
    simnet.mineEmptyBlocks(6);
    await set_price_without_scaling("mock-btc", PRICE_UNDERWATER, deployer);

    const res = liquidate(btc_collateral, DEPOSIT);
    expect(res.result.type, "a maximum-repay liquidation of an insolvent position must succeed").toBe(
      ClarityType.ResponseOk,
    );

    expect(collateralLeft(btc_collateral), "a 37-unit residue must be absorbed").toBe(0n);
    expect(
      getUserBalance(Cl.principal(liquidator), "mock-btc", deployer),
      "the liquidator receives the whole balance including the quantized remainder",
    ).toBe(BigInt(TEN_DEC_BALANCE));
    expect(socializeEvent(res), "an emptied position must socialize its bad debt").toBeDefined();
    expect(debtShares(), "the position must be left with no outstanding debt").toBe(0n);
  });

  it("clears dust held in a second collateral that no liquidation created", async () => {
    // A one-unit deposit is dust from the start, so this covers a residue that
    // arrived by any route rather than only one a liquidation left behind.
    await openTwoCollateralPosition(1);
    await set_price_without_scaling("mock-btc", PRICE_UNDERWATER, deployer);

    const btcLiq = liquidate(btc_collateral, DEPOSIT);
    expect(btcLiq.result.type, "liquidating the main collateral must succeed").toBe(
      ClarityType.ResponseOk,
    );
    expect(collateralLeft(btc_collateral), "the main collateral is fully seized").toBe(0n);
    expect(socializeEvent(btcLiq), "dust elsewhere still defers the write-off").toBeUndefined();

    const ethLiq = liquidate(eth_collateral, DEPOSIT);
    expect(ethLiq.result.type, "liquidating a dust-only collateral must succeed").toBe(
      ClarityType.ResponseOk,
    );
    expect(collateralLeft(eth_collateral), "the dust collateral must be cleared").toBe(0n);
    expect(socializeEvent(ethLiq), "clearing the last collateral must socialize").toBeDefined();
    expect(debtShares(), "the position must be left with no outstanding debt").toBe(0n);
  });
});

// Interest and staking are live here, and `update-ir-params` only accepts the
// deployer once, so this needs its own setup.
describe("a swept write-off against a shared book", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 100_000_000_000_000_000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", PRICE_OPEN, deployer);
  });

  it("writes each borrower down within the open-interest buckets it draws from", async () => {
    // liquidator-v1 computes the three parts that state-v1 subtracts from the
    // open-interest buckets, and state-v1 subtracts without a floor. Each part
    // must stay within its bucket, including on a second write-off against
    // buckets the first already reduced.
    const reserve = simnet.callPublicFn(
      "state-v1",
      "set-protocol-reserve-percentage",
      [Cl.uint(10_000_000)],
      deployer,
    );
    expect(reserve.result, "the protocol bucket must be funded").toBeOk(Cl.bool(true));

    mint_token("mock-usdc", DEPOSIT, depositor);
    deposit(DEPOSIT, depositor);
    initialize_staking(deployer);
    mint_token("mock-usdc", 1_000_000_000, staker);
    deposit(1_000_000_000, staker);
    const staked = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(500_000_000)], staker);
    expect(staked.result, "staking must succeed so the staked bucket is funded").toBeOk(
      Cl.bool(true),
    );

    update_supported_collateral("mock-btc", 50_000_000, 65_000_000, 10_000_000, 8, deployer);
    for (const who of [borrower, otherBorrower]) {
      mint_token("mock-btc", ONE_BTC + 101, who);
      add_collateral("mock-btc", ONE_BTC + 101, deployer, who);
      borrow(BORROW, who);
    }

    mint_token("mock-usdc", DEPOSIT, liquidator);
    simnet.mineEmptyBlocks(600); // accrue interest into every bucket
    await set_price_without_scaling("mock-btc", PRICE_UNDERWATER, deployer);

    const before = openInterest();
    expect(before.lp, "the lp bucket must carry a balance").toBeGreaterThan(0n);
    expect(before.staked, "the staked bucket must carry a balance").toBeGreaterThan(0n);
    expect(before.protocol, "the protocol bucket must carry a balance").toBeGreaterThan(0n);

    // Clarity aborts on uint underflow, so a part exceeding its bucket reverts
    // the whole liquidation. Each write-off succeeding with non-zero parts is
    // what proves the three subtractions stayed in range.
    const first = liquidate(btc_collateral, DEPOSIT);
    expect(first.result.type, "the first write-off must succeed").toBe(ClarityType.ResponseOk);
    const firstParts = socializedParts(first);
    expect(firstParts.lp, "lp-part must be a real operand, not zero").toBeGreaterThan(0n);
    expect(firstParts.staked, "staked-part must be a real operand, not zero").toBeGreaterThan(0n);
    expect(firstParts.protocol, "protocol-part must be a real operand, not zero").toBeGreaterThan(0n);

    const between = openInterest();
    expect(between.lp, "the first write-off must have drawn the lp bucket down").toBeLessThan(
      before.lp + firstParts.lp,
    );

    const second = liquidate(btc_collateral, DEPOSIT, otherBorrower);
    expect(
      second.result.type,
      "a second write-off against the reduced buckets must succeed",
    ).toBe(ClarityType.ResponseOk);
    const secondParts = socializedParts(second);
    expect(secondParts.lp, "lp-part must be a real operand on the second write-off").toBeGreaterThan(
      0n,
    );
    expect(
      secondParts.staked,
      "staked-part must be a real operand on the second write-off",
    ).toBeGreaterThan(0n);

    expect(collateralLeft(btc_collateral), "the first residue must be absorbed").toBe(0n);
    expect(
      collateralLeft(btc_collateral, otherBorrower),
      "the second residue must be absorbed",
    ).toBe(0n);
    expect(debtShares(), "the first borrower must be left with no debt").toBe(0n);
    expect(debtShares(otherBorrower), "the second borrower must be left with no debt").toBe(0n);
  });
});
