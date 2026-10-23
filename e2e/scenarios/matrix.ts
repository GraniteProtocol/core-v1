import { Cl } from "@stacks/transactions";
import type { Account } from "../keys.ts";
import type { Chain } from "../chain.ts";
import type { Scenario, ScenarioContext } from "../scenario.ts";
import { newAccount, fundAccount } from "../accounts.ts";
import {
  addCollateral,
  batchLiquidate,
  borrow,
  deposit,
  finalizeUnstake,
  flashLoan,
  initiateUnstake,
  liquidate,
  removeCollateral,
  repay,
  stake,
  withdraw,
} from "../actors.ts";
import { BTC, ETH, MARKET, STX, collateralSettingsOf, lpParams, mint } from "../setup.ts";
import { priceUpdate, resetToBaseline, setPrice, setPriceRaw } from "../prices.ts";
import { healthOf, lpBalance, positionOf, stakedBalance, tokenBalance, totalStakedLpTokens, userCollateral } from "../reads.ts";
import { asBool, asPrincipal, asTuple, asUint } from "../values.ts";

const USDC = 100_000_000n;
const UNIT = 100_000_000n;
const HUNDRED_PCT = 100_000_000n;
const LIQUIDATION_BLOCK_GAP = 6;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fund(
  ctx: ScenarioContext,
  name: string,
  funds: { usdc?: bigint; btc?: bigint; eth?: bigint },
): Promise<Account> {
  const account = newAccount(name);
  await ctx.step(`fund ${name}`, () => fundAccount(ctx.chain, ctx.actors.deployer, account));
  if (funds.usdc) {
    await ctx.step(`mint usdc ${name}`, () =>
      mint(ctx.chain, ctx.actors.deployer, MARKET, funds.usdc as bigint, account.address),
    );
  }
  if (funds.btc) {
    await ctx.step(`mint btc ${name}`, () =>
      mint(ctx.chain, ctx.actors.deployer, BTC, funds.btc as bigint, account.address),
    );
  }
  if (funds.eth) {
    await ctx.step(`mint eth ${name}`, () =>
      mint(ctx.chain, ctx.actors.deployer, ETH, funds.eth as bigint, account.address),
    );
  }
  return account;
}

const callAsDeployer = (
  chain: Chain,
  deployer: Account,
  contract: string,
  fn: string,
  args: Parameters<Chain["call"]>[3],
) => chain.call(deployer, contract, fn, args);

export const matrix: Scenario[] = [];

const scenario = (name: string, run: Scenario["run"]) => matrix.push({ name, run });

scenario("lp-withdraw-cap", async (ctx) => {
  const { chain, actors } = ctx;
  await ctx.step("set lp cap 10%", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-lp-cap", [Cl.uint(HUNDRED_PCT / 10n)]),
  );
  const lp = await fund(ctx, "cap-lp", { usdc: 1_000_000n * USDC });
  await ctx.step("lp deposits 1,000,000", () => deposit(chain, lp, 1_000_000n * USDC));
  await ctx.step("wait for the decay window", () => sleep(61_000));
  // The bucket only syncs inside a successful call; an aborted one rolls its sync back.
  await ctx.step("withdraw one unit to sync the bucket", () => withdraw(chain, lp, 1n));
  const bucket = asUint(await chain.read("withdrawal-caps-v1", "get-lp-bucket"));
  await ctx.assert("bucket is positive after decay", bucket > 1n, `bucket ${bucket}`);
  await ctx.attempt(
    "withdrawal above the bucket aborts",
    () => withdraw(chain, lp, bucket * 2n),
    "u120002",
  );
  await ctx.step("withdraw at the bucket succeeds", () => withdraw(chain, lp, bucket));
  await ctx.step("wait for the refill window", () => sleep(121_000));
  await ctx.step("withdraw one unit to sync the bucket", () => withdraw(chain, lp, 1n));
  const refilled = asUint(await chain.read("withdrawal-caps-v1", "get-lp-bucket"));
  await ctx.assert("the bucket refilled", refilled > 1n, `bucket ${refilled}`);
  await ctx.step("withdraw after refill succeeds", () => withdraw(chain, lp, refilled));
  await ctx.step("reset lp cap", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-lp-cap", [Cl.uint(0)]),
  );
});

scenario("ltv-boundary", async (ctx) => {
  const { chain } = ctx;
  const borrower = await fund(ctx, "ltv-borrower", { btc: 2n * UNIT, usdc: 1_000n * USDC });
  await ctx.step("add 1 BTC", () => addCollateral(chain, borrower, BTC, UNIT));
  await ctx.step("borrow at the 70% limit", () => borrow(chain, borrower, 42_000n * USDC), "debt");
  await ctx.attempt("one unit over the limit aborts", () => borrow(chain, borrower, 1n * USDC), "u20002", "debt");
  await ctx.step("full repay", () => repay(chain, borrower, 10n ** 30n), "debt");
  const afterFull = await positionOf(chain, borrower.address);
  await ctx.assert("full repay clears debt", afterFull !== null && afterFull.debtShares === 0n, "debt shares remain");
  await ctx.step("borrow 10,000", () => borrow(chain, borrower, 10_000n * USDC), "debt");
  await ctx.step("partial repay 4,000", () => repay(chain, borrower, 4_000n * USDC), "debt");
  const afterPartial = await positionOf(chain, borrower.address);
  await ctx.assert(
    "partial repay leaves debt between 0 and 10,000",
    afterPartial !== null && afterPartial.debtShares > 0n && afterPartial.borrowedAmount <= 10_000n * USDC,
    `unexpected borrowed amount ${afterPartial?.borrowedAmount}`,
  );
});

scenario("mixed-collateral", async (ctx) => {
  const { chain } = ctx;
  const borrower = await fund(ctx, "mixed-borrower", { btc: 2n * UNIT, eth: 20n * UNIT, usdc: 1_000n * USDC });
  await ctx.step("add 1 BTC and 10 ETH", async () => {
    await addCollateral(chain, borrower, BTC, UNIT);
    await addCollateral(chain, borrower, ETH, 10n * UNIT);
  });
  await ctx.step("borrow 50,000", () => borrow(chain, borrower, 50_000n * USDC), "debt");
  await ctx.step("repay 20,000", () => repay(chain, borrower, 20_000n * USDC), "debt");
  await ctx.assert(
    "both collaterals stay posted",
    (await userCollateral(chain, borrower.address, BTC)) === UNIT &&
      (await userCollateral(chain, borrower.address, ETH)) === 10n * UNIT,
    "collateral changed during a borrow/repay cycle",
  );
});

scenario("health-across-collaterals", async (ctx) => {
  const { chain } = ctx;
  const borrower = await fund(ctx, "health-borrower", { btc: 2n * UNIT, eth: 20n * UNIT });
  await ctx.step("add 1 BTC and 10 ETH", async () => {
    await addCollateral(chain, borrower, BTC, UNIT);
    await addCollateral(chain, borrower, ETH, 10n * UNIT);
  });
  await ctx.step("borrow 57,000", () => borrow(chain, borrower, 57_000n * USDC), "debt");
  const healthy = await healthOf(chain, borrower.address);
  await ctx.assert(
    "position starts healthy",
    healthy !== null && healthy.positionHealth > HUNDRED_PCT,
    `health ${healthy?.positionHealth}`,
  );
  setPrice(ETH, 2_000n);
  const afterGradualDrop = await healthOf(chain, borrower.address);
  await ctx.assert(
    "a gradual ETH drop keeps the position above water",
    afterGradualDrop !== null && afterGradualDrop.positionHealth > HUNDRED_PCT,
    `health ${afterGradualDrop?.positionHealth}`,
  );
  setPrice(ETH, 1_000n);
  const unhealthy = await healthOf(chain, borrower.address);
  await ctx.assert(
    "a sudden ETH drop turns the position unhealthy",
    unhealthy !== null && unhealthy.positionHealth < HUNDRED_PCT,
    `health ${unhealthy?.positionHealth}`,
  );
  await ctx.attempt("borrowing against a sick position aborts", () => borrow(chain, borrower, 1n * USDC), "u20002", "debt");
  setPrice(ETH, 3_000n);
  const recovered = await healthOf(chain, borrower.address);
  await ctx.assert(
    "the position recovers with the price",
    recovered !== null && recovered.positionHealth > HUNDRED_PCT,
    `health ${recovered?.positionHealth}`,
  );
  resetToBaseline();
});

scenario("direct-liquidation", async (ctx) => {
  const { chain } = ctx;
  const borrower = await fund(ctx, "liq-borrower", { btc: 2n * UNIT });
  const liquidator = await fund(ctx, "liq-liquidator", { usdc: 100_000n * USDC });
  await ctx.step("add 1 BTC", () => addCollateral(chain, borrower, BTC, UNIT));
  await ctx.step("borrow 42,000", () => borrow(chain, borrower, 42_000n * USDC), "debt");
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(BTC, 50_000n);
  const collateralBefore = await userCollateral(chain, borrower.address, BTC);
  const seizedBefore = await tokenBalance(chain, BTC, liquidator.address);
  await ctx.step("liquidate", () => liquidate(chain, liquidator, BTC, borrower.address, 100_000n * USDC), "debt");
  const collateralAfter = await userCollateral(chain, borrower.address, BTC);
  const seizedAfter = await tokenBalance(chain, BTC, liquidator.address);
  await ctx.assert("collateral seized", collateralAfter < collateralBefore, `collateral ${collateralAfter}`);
  await ctx.assert("liquidator paid and received collateral", seizedAfter > seizedBefore, "liquidator balance unchanged");
  const health = await healthOf(chain, borrower.address);
  await ctx.assert(
    "position is healthy after liquidation",
    health === null || health.positionHealth >= HUNDRED_PCT,
    `health ${health?.positionHealth}`,
  );

  // ETH collateral: 10 ETH at $3,000 borrows 14,000; a crash to $1,000 makes it liquidatable.
  const ethBorrower = await fund(ctx, "liq-eth-borrower", { eth: 20n * UNIT });
  await ctx.step("add 10 ETH", () => addCollateral(chain, ethBorrower, ETH, 10n * UNIT));
  await ctx.step("borrow 14,000 against ETH", () => borrow(chain, ethBorrower, 14_000n * USDC), "debt");
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(ETH, 1_000n);
  const ethBefore = await tokenBalance(chain, ETH, liquidator.address);
  await ctx.step("liquidate ETH collateral", () =>
    liquidate(chain, liquidator, ETH, ethBorrower.address, 100_000n * USDC), "debt",
  );
  const ethAfter = await tokenBalance(chain, ETH, liquidator.address);
  await ctx.assert("liquidator received ETH", ethAfter > ethBefore, `${ethBefore} -> ${ethAfter}`);

  // STX collateral: 10,000 STX at $2 borrows 9,000; a crash to $1 makes it liquidatable.
  const stxBorrower = await fund(ctx, "liq-stx-borrower", { usdc: 0n });
  await ctx.step("add 10,000 STX", () => addCollateral(chain, stxBorrower, STX, 10_000n * 1_000_000n));
  await ctx.step("borrow 9,000 against STX", () => borrow(chain, stxBorrower, 9_000n * USDC), "debt");
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(STX, 1n);
  await ctx.step("liquidate STX collateral", () =>
    liquidate(chain, liquidator, STX, stxBorrower.address, 100_000n * USDC), "debt",
  );
  await ctx.assert(
    "STX collateral was seized",
    (await userCollateral(chain, stxBorrower.address, STX)) < 10_000n * 1_000_000n,
    "STX collateral unchanged",
  );
  resetToBaseline();
});

scenario("batch-liquidation", async (ctx) => {
  const { chain } = ctx;
  const first = await fund(ctx, "batch-a", { btc: 2n * UNIT });
  const second = await fund(ctx, "batch-b", { btc: 2n * UNIT });
  const liquidator = await fund(ctx, "batch-liquidator", { usdc: 100_000n * USDC });
  for (const borrower of [first, second]) {
    await ctx.step(`open ${borrower.name}`, async () => {
      await addCollateral(chain, borrower, BTC, UNIT);
      await borrow(chain, borrower, 42_000n * USDC);
    }, "debt");
  }
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(BTC, 50_000n);
  const before = await Promise.all([first, second].map((b) => userCollateral(chain, b.address, BTC)));
  await ctx.step("batch liquidate both", () =>
    batchLiquidate(chain, liquidator, BTC, [
      { user: first.address, repayAmount: 20_000n * USDC, minCollateralExpected: 0n },
      { user: second.address, repayAmount: 20_000n * USDC, minCollateralExpected: 0n },
    ]), "debt",
  );
  const after = await Promise.all([first, second].map((b) => userCollateral(chain, b.address, BTC)));
  await ctx.assert(
    "both positions lost collateral",
    after[0] < before[0] && after[1] < before[1],
    `collateral ${before} -> ${after}`,
  );
  resetToBaseline();
});

scenario("flash-loan-liquidation", async (ctx) => {
  const { chain, actors } = ctx;
  const borrower = await fund(ctx, "flash-liq-borrower", { btc: 2n * UNIT });
  await ctx.step("add 1 BTC", () => addCollateral(chain, borrower, BTC, UNIT));
  await ctx.step("borrow 42,000", () => borrow(chain, borrower, 42_000n * USDC), "debt");
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(BTC, 50_000n);
  const before = await userCollateral(chain, borrower.address, BTC);
  await ctx.step("liquidate through the flash-loan callback", async () =>
    callAsDeployer(chain, actors.liquidator, "mock-liquidator-with-flash-loan", "liquidate-collateral", [
      Cl.buffer(await priceUpdate(chain)),
      Cl.principal(borrower.address),
      Cl.uint(100_000n * USDC),
      Cl.uint(0),
      Cl.contractPrincipal(chain.deployer, "mock-liquidator-with-flash-loan"),
    ]), "debt",
  );
  const after = await userCollateral(chain, borrower.address, BTC);
  await ctx.assert("flash-loan path seized collateral", after < before, `collateral ${before} -> ${after}`);
  resetToBaseline();
});

scenario("dust-sweep", async (ctx) => {
  const { chain } = ctx;
  const borrower = await fund(ctx, "dust-borrower", { btc: 2n * UNIT });
  const liquidator = await fund(ctx, "dust-liquidator", { usdc: 100_000n * USDC });
  await ctx.step("add 1 BTC plus dust", () => addCollateral(chain, borrower, BTC, UNIT + 101n));
  await ctx.step("borrow 42,000", () => borrow(chain, borrower, 42_000n * USDC), "debt");
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPriceRaw(BTC, 2_013_742_000_000n); // $20,137.42, a price with cents
  await ctx.step("liquidate a deep bad-debt position", () =>
    liquidate(chain, liquidator, BTC, borrower.address, 100_000n * USDC), "debt",
  );
  const remaining = await userCollateral(chain, borrower.address, BTC);
  await ctx.assert("no dust is left behind", remaining === 0n, `collateral left: ${remaining}`);
  const health = await healthOf(chain, borrower.address);
  const position = await positionOf(chain, borrower.address);
  await ctx.assert(
    "bad debt is written off",
    position === null || position.debtShares === 0n || (health !== null && health.currentDebt === 0n),
    `debt remains: ${position?.debtShares}`,
  );
  resetToBaseline();
});

scenario("staking", async (ctx) => {
  const { chain, actors } = ctx;
  await ctx.step("deposit for staking", () => deposit(chain, actors.staker, 100_000n * USDC));
  const lpTokens = await lpBalance(chain, actors.staker.address);
  const half = lpTokens / 2n;
  await ctx.step("stake half the LP tokens", () => stake(chain, actors.staker, half));
  const staked = await stakedBalance(chain, actors.staker.address);
  await ctx.assert("staked balance is positive", staked > 0n, "no staked LP tokens");
  await ctx.step("initiate unstake", () => initiateUnstake(chain, actors.staker, staked / 2n));
  await ctx.attempt("finalizing early aborts", () => finalizeUnstake(chain, actors.staker, 0n), "u60004");
  await ctx.step("wait the finalization period", () => chain.waitBlocks(11));
  await ctx.step("finalize after the period", () => finalizeUnstake(chain, actors.staker, 0n));
});

scenario("flash-loan", async (ctx) => {
  const { chain, actors } = ctx;
  const caller = await fund(ctx, "flash-caller", { usdc: 1_000n * USDC });
  const governanceBefore = await tokenBalance(chain, MARKET, actors.deployer.address);
  await ctx.step("allowed caller takes a flash loan", () =>
    flashLoan(chain, caller, 10_000n * USDC, "mock-flash-loan-callback"),
  );
  const governanceAfter = await tokenBalance(chain, MARKET, actors.deployer.address);
  await ctx.assert(
    "the fee reached governance",
    governanceAfter > governanceBefore,
    `fee balance ${governanceBefore} -> ${governanceAfter}`,
  );
  await ctx.step("remove the callback from the allow list", () =>
    callAsDeployer(chain, actors.deployer, "flash-loan-v1", "remove-allowed-contract", [
      Cl.contractPrincipal(chain.deployer, "mock-flash-loan-callback"),
    ]),
  );
  await ctx.attempt(
    "a non-allowed callback is refused",
    () => flashLoan(chain, caller, 1_000n * USDC, "mock-flash-loan-callback"),
    "u110000",
  );
  await ctx.step("restore the allow list", () =>
    callAsDeployer(chain, actors.deployer, "flash-loan-v1", "set-allowed-contract", [
      Cl.contractPrincipal(chain.deployer, "mock-flash-loan-callback"),
    ]),
  );
});

scenario("caps", async (ctx) => {
  const { chain, actors } = ctx;
  const borrower = await fund(ctx, "caps-borrower", { btc: 12n * UNIT });
  await ctx.step("set the BTC collateral cap to 10%", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-collateral-cap", [
      Cl.contractPrincipal(chain.deployer, BTC),
      Cl.uint(HUNDRED_PCT / 10n),
    ]),
  );
  await ctx.step("add 10 BTC", () => addCollateral(chain, borrower, BTC, 10n * UNIT));
  await ctx.step("wait for the decay window", () => sleep(61_000));
  // The bucket only syncs inside a successful call; an aborted one rolls its sync back.
  await ctx.step("remove one unit to sync the bucket", () => removeCollateral(chain, borrower, BTC, 1n));
  const bucket = asUint(
    await chain.read("withdrawal-caps-v1", "get-collateral-bucket", [Cl.contractPrincipal(chain.deployer, BTC)]),
  );
  await ctx.assert("collateral bucket is positive after decay", bucket > 1n, `bucket ${bucket}`);
  const collateral = await userCollateral(chain, borrower.address, BTC);
  await ctx.attempt(
    "removing more than the bucket aborts",
    () => removeCollateral(chain, borrower, BTC, collateral),
    "u120004",
  );
  await ctx.step("removing up to the bucket succeeds", () => removeCollateral(chain, borrower, BTC, bucket));
  await ctx.step("wait for the refill window", () => sleep(121_000));
  await ctx.step("remove one unit to sync the bucket", () => removeCollateral(chain, borrower, BTC, 1n));
  const refilled = asUint(
    await chain.read("withdrawal-caps-v1", "get-collateral-bucket", [Cl.contractPrincipal(chain.deployer, BTC)]),
  );
  await ctx.assert("collateral bucket refilled", refilled > 1n, `bucket ${refilled}`);
  await ctx.step("removing the refilled amount succeeds", () => removeCollateral(chain, borrower, BTC, refilled));
  await ctx.step("zero the collateral cap factor", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-collateral-cap", [
      Cl.contractPrincipal(chain.deployer, BTC),
      Cl.uint(0),
    ]),
  );
  await ctx.step("a zero factor removes the cap", () => removeCollateral(chain, borrower, BTC, 40_000_000n));
  await ctx.step("restore the collateral cap", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-collateral-cap", [
      Cl.contractPrincipal(chain.deployer, BTC),
      Cl.uint(80_000_000n),
    ]),
  );
});

scenario("bad-debt-socialization", async (ctx) => {
  const { chain, actors } = ctx;
  const borrower = await fund(ctx, "baddebt-borrower", { btc: 2n * UNIT });
  await ctx.step("deposit and stake a little LP", async () => {
    await deposit(chain, actors.staker, 10_000n * USDC);
    const balance = await lpBalance(chain, actors.staker.address);
    await stake(chain, actors.staker, balance / 10n);
  });
  await ctx.step("add 1 BTC", () => addCollateral(chain, borrower, BTC, UNIT));
  await ctx.step("borrow 42,000", () => borrow(chain, borrower, 42_000n * USDC), "debt");
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(BTC, 10_000n);
  const stakedBefore = await totalStakedLpTokens(chain);
  const assetsBefore = (await lpParams(chain)).totalAssets;
  await ctx.step("liquidate an insolvent position", () =>
    liquidate(chain, actors.liquidator, BTC, borrower.address, 100_000n * USDC), "debt",
  );
  const position = await positionOf(chain, borrower.address);
  const stakedAfter = await totalStakedLpTokens(chain);
  const assetsAfter = (await lpParams(chain)).totalAssets;
  await ctx.assert("position emptied", await userCollateral(chain, borrower.address, BTC) === 0n, "collateral remains");
  await ctx.assert("debt written off", position === null || position.debtShares === 0n, "debt remains");
  await ctx.assert("LP assets written down", assetsAfter < assetsBefore, `${assetsBefore} -> ${assetsAfter}`);
  await ctx.assert("staked LP absorbed a slash", stakedAfter <= stakedBefore, `${stakedBefore} -> ${stakedAfter}`);
  resetToBaseline();
});

scenario("remove-collateral-stuck", async (ctx) => {
  const { chain, actors } = ctx;
  const borrower = await fund(ctx, "stuck-borrower", { btc: 2n * UNIT, eth: 2n * UNIT });
  await ctx.step("add 1 BTC and 1 ETH", async () => {
    await addCollateral(chain, borrower, BTC, UNIT);
    await addCollateral(chain, borrower, ETH, UNIT);
  });
  await ctx.step("borrow 30,000", () => borrow(chain, borrower, 30_000n * USDC), "debt");
  await ctx.step("de-list ETH as a collateral", () =>
    callAsDeployer(chain, actors.deployer, "state-v1", "remove-collateral", [
      Cl.contractPrincipal(chain.deployer, ETH),
    ]),
  );
  await ctx.attempt(
    "withdrawing a de-listed collateral aborts",
    () => removeCollateral(chain, borrower, ETH, UNIT),
    "u20007",
  );
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(BTC, 30_000n);
  await ctx.attempt(
    "liquidating a de-listed collateral aborts",
    () => liquidate(chain, actors.liquidator, ETH, borrower.address, 1_000n * USDC),
    "u30005",
    "debt",
  );
  await ctx.step("restore ETH settings", () =>
    callAsDeployer(chain, actors.deployer, "state-v1", "update-collateral-settings", [
      Cl.contractPrincipal(chain.deployer, ETH),
      Cl.uint(50_000_000n),
      Cl.uint(70_000_000n),
      Cl.uint(10_000_000n),
      Cl.uint(8),
    ]),
  );
  resetToBaseline();
});

scenario("governance", async (ctx) => {
  const { chain, actors } = ctx;
  const deployer = actors.deployer.address;
  const governance = Cl.contractPrincipal(chain.deployer, "governance-test");
  await ctx.step("initialize meta-governance", () =>
    chain.call(actors.deployer, "meta-governance-v1", "initialize-governance", [
      Cl.list([Cl.some(Cl.principal(deployer)), Cl.none(), Cl.none(), Cl.none(), Cl.none()]),
    ]),
  );
  await ctx.step("initialize test governance", () =>
    chain.call(actors.deployer, "governance-test", "initialize-governance", [
      Cl.list([Cl.some(Cl.principal(deployer)), Cl.none(), Cl.none(), Cl.none(), Cl.none()]),
    ]),
  );
  await ctx.step("point state at the test governance", () =>
    chain.call(actors.deployer, "state-v1", "update-governance", [governance]),
  );

  const proposeAndExecute = async (
    label: string,
    propose: () => Promise<string>,
    verify: () => Promise<boolean>,
  ) => {
    let proposalId = "";
    await ctx.step(`propose ${label}`, async () => {
      proposalId = await propose();
    });
    await ctx.step(`wait the test timelock for ${label}`, () => chain.waitBlocks(11));
    await ctx.step(`execute ${label}`, () =>
      chain.call(actors.deployer, "governance-test", "execute", [Cl.buffer(proposalId)]),
    );
    await ctx.assert(`${label} took effect`, await verify(), `${label} did not change state`);
  };

  const proposalIdFrom = (repr: string | undefined): string => {
    const match = repr?.match(/0x[0-9a-f]{64}/);
    if (!match) throw new Error(`no proposal id in ${repr}`);
    return match[0];
  };

  await proposeAndExecute(
    "collateral settings",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-collateral-settings", [
        Cl.contractPrincipal(chain.deployer, ETH),
        Cl.uint(60_000_000n),
        Cl.uint(75_000_000n),
        Cl.uint(10_000_000n),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    async () => (await collateralSettingsOf(chain, ETH)).maxLtv === 60_000_000n,
  );

  await proposeAndExecute(
    "interest params",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-interest-params", [
        Cl.uint(750_000_000_000n),
        Cl.uint(1_500_000_000_000n),
        Cl.uint(700_000_000_000n),
        Cl.uint(300_000_000_000n),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    async () => {
      const params = asTuple(await chain.read("linear-kinked-ir-v1", "get-ir-params"));
      return asUint(params["base-ir"]) === 300_000_000_000n;
    },
  );

  await proposeAndExecute(
    "collateral cap",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-withdrawal-caps-param", [
        Cl.uint(32),
        Cl.tuple({ collateral: Cl.some(Cl.contractPrincipal(chain.deployer, BTC)), factor: Cl.uint(70_000_000n) }),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    async () =>
      asUint(
        await chain.read("withdrawal-caps-v1", "get-collateral-cap-factor", [
          Cl.contractPrincipal(chain.deployer, BTC),
        ]),
      ) === 70_000_000n,
  );

  await proposeAndExecute(
    "market pause",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-set-market-state", [
        Cl.uint(9),
        Cl.uint(1000),
        Cl.uint(0),
      ]);
      return proposalIdFrom(result.result);
    },
    async () => asBool(await chain.read("state-v1", "is-borrow-enabled")) === false,
  );

  await proposeAndExecute(
    "market unpause",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-set-market-state", [
        Cl.uint(10),
        Cl.uint(1000),
        Cl.uint(0),
      ]);
      return proposalIdFrom(result.result);
    },
    async () => asBool(await chain.read("state-v1", "is-borrow-enabled")) === true,
  );

  await proposeAndExecute(
    "restore ETH settings",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-collateral-settings", [
        Cl.contractPrincipal(chain.deployer, ETH),
        Cl.uint(50_000_000n),
        Cl.uint(70_000_000n),
        Cl.uint(10_000_000n),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    async () => (await collateralSettingsOf(chain, ETH)).maxLtv === 50_000_000n,
  );

  await proposeAndExecute(
    "restore the BTC collateral cap",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-withdrawal-caps-param", [
        Cl.uint(32),
        Cl.tuple({ collateral: Cl.some(Cl.contractPrincipal(chain.deployer, BTC)), factor: Cl.uint(80_000_000n) }),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    async () =>
      asUint(
        await chain.read("withdrawal-caps-v1", "get-collateral-cap-factor", [
          Cl.contractPrincipal(chain.deployer, BTC),
        ]),
      ) === 80_000_000n,
  );

  await proposeAndExecute(
    "governance handover back to the deployer",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-governance", [
        Cl.principal(deployer),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    async () => asPrincipal(await chain.read("state-v1", "get-governance")) === deployer,
  );

  await ctx.assert(
    "collateral configs restored",
    (await collateralSettingsOf(chain, ETH)).maxLtv === 50_000_000n,
    "ETH config moved unexpectedly",
  );
  await ctx.assert("STX still configured", (await collateralSettingsOf(chain, STX)).maxLtv === 50_000_000n, "STX missing");
  await ctx.assert("caps read", (await asUint(await chain.read("withdrawal-caps-v1", "get-refill-time-window"))) === 120n, "refill window changed");
});
