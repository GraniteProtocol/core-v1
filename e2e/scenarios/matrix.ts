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
import {
  BTC,
  ETH,
  MARKET,
  PROFILE,
  STX,
  collateralSettingsOf,
  expectedCollateralConfigs,
  lpParams,
  mint,
  setCapWindows,
} from "../setup.ts";
import { priceUpdate, resetToBaseline, setPrice, setPriceRaw } from "../prices.ts";
import { healthOf, lpBalance, positionOf, stakedBalance, tokenBalance, totalStakedLpTokens, userCollateral } from "../reads.ts";
import { registerProbeUser, suspendExitability } from "../invariants.ts";
import { asBool, asOptional, asPrincipal, asTuple, asUint, okUint } from "../values.ts";

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
  registerProbeUser(account.address);
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

const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
// A cap-relative tolerance: a 25% refill/decay bug must fail, while one raw unit plus the factor
// step caused by the syncing withdrawal stays inside it.
const capTolerance = (cap: bigint): bigint => {
  const relative = cap / 1000n;
  return relative > 0n ? relative : 1n;
};
const stateContract = (chain: Chain) => `${chain.deployer}.state-v1`;

const proposalIdFrom = (repr: string | undefined): string => {
  const match = repr?.match(/0x([0-9a-f]{64})/);
  if (!match) throw new Error(`no proposal id in ${repr}`);
  return match[1];
};

/** Proposes through the test governance, waits its timelock and executes, then verifies. */
async function proposeAndExecute(
  ctx: ScenarioContext,
  label: string,
  propose: () => Promise<string>,
  verify: () => Promise<boolean>,
  autoExecutes = false,
): Promise<void> {
  let proposalId = "";
  await ctx.step(`propose ${label}`, async () => {
    proposalId = await propose();
  });
  if (!autoExecutes) {
    await ctx.step(`wait the test timelock for ${label}`, () => ctx.chain.waitBlocks(3));
    await ctx.step(`execute ${label}`, () =>
      ctx.chain.call(ctx.actors.deployer, "governance-test", "execute", [Cl.bufferFromHex(proposalId)]),
    );
  }
  await ctx.assert(`${label} took effect`, await verify(), `${label} did not change state`);
}

/** The bucket's cap: liquidity held by state-v1 times the factor. */
async function lpCapMax(chain: Chain, factor: bigint): Promise<bigint> {
  const liquidity = await tokenBalance(chain, MARKET, stateContract(chain));
  return (liquidity * factor) / HUNDRED_PCT;
}

async function collateralCapMax(chain: Chain, token: string, factor: bigint): Promise<bigint> {
  const liquidity = await tokenBalance(chain, token, stateContract(chain));
  return (liquidity * factor) / HUNDRED_PCT;
}

scenario("lp-withdraw-cap", async (ctx) => {
  const { chain, actors } = ctx;
  const factor = HUNDRED_PCT / 10n;
  await ctx.step("use test cap windows", () => setCapWindows(chain, actors.deployer, PROFILE.test.capWindows));
  await ctx.step("set lp cap 10%", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-lp-cap", [Cl.uint(factor)]),
  );
  const lp = await fund(ctx, "cap-lp", { usdc: 1_000_000n * USDC });
  await ctx.step("lp deposits 1,000,000", () => deposit(chain, lp, 1_000_000n * USDC));
  // The windows are block-time seconds and blocks arrive every ~5s. Sample mid-window (partial
  // movement) and at the endpoint (fully decayed/refilled) so a 2x-3x rate error cannot hide.
  const bucketAfterDeposit = asUint(await chain.read("withdrawal-caps-v1", "get-lp-bucket"));
  await ctx.step("wait half the decay window", () => sleep(7_000));
  // The bucket only syncs inside a successful call; an aborted one rolls its sync back.
  await ctx.step("withdraw one unit to sync the bucket", () => withdraw(chain, lp, 1n));
  const bucketMidDecay = asUint(await chain.read("withdrawal-caps-v1", "get-lp-bucket"));
  const midDecayMax = await lpCapMax(chain, factor);
  await ctx.assert(
    "the bucket decayed only partially mid-window",
    bucketMidDecay > midDecayMax && bucketMidDecay < bucketAfterDeposit - 1n,
    `after ${bucketAfterDeposit} mid ${bucketMidDecay} cap ${midDecayMax}`,
  );
  await ctx.step("wait past the decay window", () => sleep(25_000));
  await ctx.step("withdraw one unit to sync the bucket", () => withdraw(chain, lp, 1n));
  const bucket = asUint(await chain.read("withdrawal-caps-v1", "get-lp-bucket"));
  const decayedMax = await lpCapMax(chain, factor);
  await ctx.assert(
    "bucket decayed to the cap",
    absDiff(bucket, decayedMax) <= capTolerance(decayedMax),
    `bucket ${bucket} cap ${decayedMax}`,
  );
  await ctx.attempt(
    "withdrawal above the bucket aborts",
    () => withdraw(chain, lp, bucket * 2n),
    "u120002",
  );
  await ctx.step("withdraw within the bucket succeeds", () => withdraw(chain, lp, bucket / 2n));
  const bucketBeforeRefill = asUint(await chain.read("withdrawal-caps-v1", "get-lp-bucket"));
  await ctx.step("wait half the refill window", () => sleep(7_000));
  await ctx.step("withdraw one unit to sync the bucket", () => withdraw(chain, lp, 1n));
  const bucketMidRefill = asUint(await chain.read("withdrawal-caps-v1", "get-lp-bucket"));
  const midRefillMax = await lpCapMax(chain, factor);
  await ctx.assert(
    "the bucket refilled only partially mid-window",
    bucketMidRefill > bucketBeforeRefill && bucketMidRefill < midRefillMax,
    `before ${bucketBeforeRefill} mid ${bucketMidRefill} cap ${midRefillMax}`,
  );
  await ctx.step("wait past the refill window", () => sleep(45_000));
  await ctx.step("withdraw one unit to sync the bucket", () => withdraw(chain, lp, 1n));
  const refilled = asUint(await chain.read("withdrawal-caps-v1", "get-lp-bucket"));
  const refilledMax = await lpCapMax(chain, factor);
  await ctx.assert(
    "the bucket refilled to the cap",
    refilled > bucketBeforeRefill && absDiff(refilled, refilledMax) <= capTolerance(refilledMax),
    `before ${bucketBeforeRefill} after ${refilled} cap ${refilledMax}`,
  );
  await ctx.step("withdraw after refill succeeds", () => withdraw(chain, lp, refilled / 2n));
  await ctx.step("restore the live lp cap", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-lp-cap", [Cl.uint(PROFILE.caps.lp)]),
  );
  await ctx.step("restore live cap windows", () => setCapWindows(chain, actors.deployer, PROFILE.caps.windows));
});

scenario("ltv-boundary", async (ctx) => {
  const { chain } = ctx;
  const borrower = await fund(ctx, "ltv-borrower", { btc: 2n * UNIT, usdc: 1_000n * USDC });
  await ctx.step("add 1 BTC", () => addCollateral(chain, borrower, BTC, UNIT));
  await ctx.step("borrow at the live 50% limit", () => borrow(chain, borrower, 30_000n * USDC), "debt");
  await ctx.attempt("one dollar over the limit aborts", () => borrow(chain, borrower, 1n * USDC), "u20002", "debt");
  await ctx.step("full repay", () => repay(chain, borrower, 10n ** 30n), "debt");
  const afterFull = await positionOf(chain, borrower.address);
  await ctx.assert("full repay clears debt", afterFull !== null && afterFull.debtShares === 0n, "debt shares remain");
  await ctx.step("borrow 10,000", () => borrow(chain, borrower, 10_000n * USDC), "debt");
  const beforePartial = await positionOf(chain, borrower.address);
  await ctx.step("partial repay 4,000", () => repay(chain, borrower, 4_000n * USDC), "debt");
  const afterPartial = await positionOf(chain, borrower.address);
  await ctx.assert(
    "partial repay strictly reduces debt without clearing it",
    beforePartial !== null &&
      afterPartial !== null &&
      afterPartial.debtShares > 0n &&
      afterPartial.borrowedAmount < beforePartial.borrowedAmount,
    `borrowed ${beforePartial?.borrowedAmount} -> ${afterPartial?.borrowedAmount}`,
  );
});

scenario("mixed-collateral", async (ctx) => {
  const { chain } = ctx;
  const borrower = await fund(ctx, "mixed-borrower", { btc: 2n * UNIT, eth: 20n * UNIT, usdc: 1_000n * USDC });
  await ctx.step("add 1 BTC and 10 ETH", async () => {
    await addCollateral(chain, borrower, BTC, UNIT);
    await addCollateral(chain, borrower, ETH, 10n * UNIT);
  });
  await ctx.step("borrow 40,000", () => borrow(chain, borrower, 40_000n * USDC), "debt");
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
  await ctx.step("borrow 44,000", () => borrow(chain, borrower, 44_000n * USDC), "debt");
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
  setPrice(ETH, 500n);
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
  await ctx.step("borrow 25,000", () => borrow(chain, borrower, 25_000n * USDC), "debt");
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(BTC, 35_000n);
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
      await borrow(chain, borrower, 25_000n * USDC);
    }, "debt");
  }
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(BTC, 35_000n);
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
  await ctx.step("borrow 25,000", () => borrow(chain, borrower, 25_000n * USDC), "debt");
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(BTC, 35_000n);
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
  await ctx.step("borrow 25,000", () => borrow(chain, borrower, 25_000n * USDC), "debt");
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
  const deployer = actors.deployer.address;
  // Live rewards are zero, so the staked-interest split would never execute. Route governance to the
  // test contract, apply the named test reward params for this scenario, and put both back after.
  const governance = Cl.contractPrincipal(chain.deployer, "governance-test");
  const rewardParamsMatch = async (kink: bigint) =>
    asUint(asTuple(await chain.read("staking-reward-v1", "get-reward-params"))["staked-kink"]) === kink;
  await ctx.step("route governance to the test contract", () =>
    chain.call(actors.deployer, "state-v1", "update-governance", [governance]),
  );
  await proposeAndExecute(ctx,
    "test reward params",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-reward-params", [
        Cl.int(PROFILE.test.rewardParams.slope1),
        Cl.int(PROFILE.test.rewardParams.slope2),
        Cl.uint(PROFILE.test.rewardParams.kink),
        Cl.uint(PROFILE.test.rewardParams.base),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    () => rewardParamsMatch(PROFILE.test.rewardParams.kink),
  );
  await ctx.step("deposit for staking", () => deposit(chain, actors.staker, 100_000n * USDC));
  const lpTokens = await lpBalance(chain, actors.staker.address);
  const half = lpTokens / 2n;
  await ctx.step("stake half the LP tokens", () => stake(chain, actors.staker, half));
  const staked = await stakedBalance(chain, actors.staker.address);
  await ctx.assert("staked balance is positive", staked > 0n, "no staked LP tokens");
  const supply = okUint(await chain.read("state-v1", "get-total-supply"));
  const reward = okUint(
    await chain.read("staking-reward-v1", "get-staking-reward-percentage", [Cl.uint(staked), Cl.uint(supply)]),
  );
  await ctx.assert("staking reward percentage is positive", reward > 0n, `reward percentage ${reward}`);
  // Interest a borrower pays must land in the staked bucket, not only in lp-open-interest.
  const borrower = await fund(ctx, "staking-borrower", { btc: 2n * UNIT, usdc: 1_000n * USDC });
  await ctx.step(
    "staking borrower opens a position",
    async () => {
      await addCollateral(chain, borrower, BTC, UNIT);
      await borrow(chain, borrower, 25_000n * USDC);
    },
    "debt",
  );
  await ctx.step("wait for interest to accrue", () => chain.waitBlocks(12));
  const stakedBucketBefore = asUint(await chain.read("staking-v1", "get-active-staked-lp-tokens"));
  await ctx.step("staking borrower repays", () => repay(chain, borrower, 10n ** 30n), "debt");
  const stakedBucketAfter = asUint(await chain.read("staking-v1", "get-active-staked-lp-tokens"));
  await ctx.assert(
    "repaid interest grows the staked bucket",
    stakedBucketAfter > stakedBucketBefore,
    `${stakedBucketBefore} -> ${stakedBucketAfter}`,
  );
  await ctx.step("initiate unstake", () => initiateUnstake(chain, actors.staker, staked / 2n));
  await ctx.attempt("finalizing early aborts", () => finalizeUnstake(chain, actors.staker, 0n), "u60004");
  const lpBeforeFinalize = await lpBalance(chain, actors.staker.address);
  await ctx.step("wait the finalization period", () => chain.waitBlocks(6));
  await ctx.step("finalize after the period", () => finalizeUnstake(chain, actors.staker, 0n));
  const lpAfterFinalize = await lpBalance(chain, actors.staker.address);
  await ctx.assert(
    "finalize returned the LP tokens",
    lpAfterFinalize > lpBeforeFinalize,
    `lp balance ${lpBeforeFinalize} -> ${lpAfterFinalize}`,
  );
  await proposeAndExecute(ctx,
    "restore live reward params",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-reward-params", [
        Cl.int(PROFILE.reward.slope1),
        Cl.int(PROFILE.reward.slope2),
        Cl.uint(PROFILE.reward.kink),
        Cl.uint(PROFILE.reward.base),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    () => rewardParamsMatch(PROFILE.reward.kink),
  );
  await proposeAndExecute(ctx,
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
  await ctx.step("use test cap windows", () => setCapWindows(chain, actors.deployer, PROFILE.test.capWindows));
  await ctx.step("set the BTC collateral cap to 10%", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-collateral-cap", [
      Cl.contractPrincipal(chain.deployer, BTC),
      Cl.uint(HUNDRED_PCT / 10n),
    ]),
  );
  const factor = HUNDRED_PCT / 10n;
  const readBucket = () =>
    chain
      .read("withdrawal-caps-v1", "get-collateral-bucket", [Cl.contractPrincipal(chain.deployer, BTC)])
      .then(asUint);
  await ctx.step("add 10 BTC", () => addCollateral(chain, borrower, BTC, 10n * UNIT));
  // Sample mid-window (partial movement) and at the endpoint, so a rate error cannot hide.
  const bucketAfterDeposit = await readBucket();
  await ctx.step("wait half the decay window", () => sleep(7_000));
  // The bucket only syncs inside a successful call; an aborted one rolls its sync back.
  await ctx.step("remove one unit to sync the bucket", () => removeCollateral(chain, borrower, BTC, 1n));
  const bucketMidDecay = await readBucket();
  const midDecayMax = await collateralCapMax(chain, BTC, factor);
  await ctx.assert(
    "the collateral bucket decayed only partially mid-window",
    bucketMidDecay > midDecayMax && bucketMidDecay < bucketAfterDeposit - 1n,
    `after ${bucketAfterDeposit} mid ${bucketMidDecay} cap ${midDecayMax}`,
  );
  await ctx.step("wait past the decay window", () => sleep(25_000));
  await ctx.step("remove one unit to sync the bucket", () => removeCollateral(chain, borrower, BTC, 1n));
  const bucket = await readBucket();
  const decayedMax = await collateralCapMax(chain, BTC, factor);
  await ctx.assert(
    "collateral bucket decayed to the cap",
    absDiff(bucket, decayedMax) <= capTolerance(decayedMax),
    `bucket ${bucket} cap ${decayedMax}`,
  );
  const collateral = await userCollateral(chain, borrower.address, BTC);
  await ctx.attempt(
    "removing more than the bucket aborts",
    () => removeCollateral(chain, borrower, BTC, collateral),
    "u120004",
  );
  await ctx.step("removing within the bucket succeeds", () => removeCollateral(chain, borrower, BTC, bucket / 2n));
  const bucketBeforeRefill = await readBucket();
  await ctx.step("wait half the refill window", () => sleep(7_000));
  await ctx.step("remove one unit to sync the bucket", () => removeCollateral(chain, borrower, BTC, 1n));
  const bucketMidRefill = await readBucket();
  const midRefillMax = await collateralCapMax(chain, BTC, factor);
  await ctx.assert(
    "the collateral bucket refilled only partially mid-window",
    bucketMidRefill > bucketBeforeRefill && bucketMidRefill < midRefillMax,
    `before ${bucketBeforeRefill} mid ${bucketMidRefill} cap ${midRefillMax}`,
  );
  await ctx.step("wait past the refill window", () => sleep(45_000));
  await ctx.step("remove one unit to sync the bucket", () => removeCollateral(chain, borrower, BTC, 1n));
  const refilled = await readBucket();
  const refilledMax = await collateralCapMax(chain, BTC, factor);
  await ctx.assert(
    "collateral bucket refilled to the cap",
    refilled > bucketBeforeRefill && absDiff(refilled, refilledMax) <= capTolerance(refilledMax),
    `before ${bucketBeforeRefill} after ${refilled} cap ${refilledMax}`,
  );
  await ctx.step("removing the refilled amount succeeds", () =>
    removeCollateral(chain, borrower, BTC, refilled / 2n),
  );
  await ctx.step("zero the collateral cap factor", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-collateral-cap", [
      Cl.contractPrincipal(chain.deployer, BTC),
      Cl.uint(0),
    ]),
  );
  const beforeUncapped = await userCollateral(chain, borrower.address, BTC);
  await ctx.step("a zero factor removes the cap", () => removeCollateral(chain, borrower, BTC, 40_000_000n));
  const afterUncapped = await userCollateral(chain, borrower.address, BTC);
  await ctx.assert(
    "the uncapped removal left the borrower",
    afterUncapped === beforeUncapped - 40_000_000n,
    `collateral ${beforeUncapped} -> ${afterUncapped}`,
  );
  await ctx.step("restore the live collateral cap", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-collateral-cap", [
      Cl.contractPrincipal(chain.deployer, BTC),
      Cl.uint(PROFILE.caps.collateral[BTC]),
    ]),
  );

  // Debt cap: a 10% factor makes the debt bucket finite; a borrow above it must be refused. The
  // bucket carries history from the live factor seeded at setup, so let it decay to the new cap
  // before sampling it.
  await ctx.step("set the debt cap to 10%", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-debt-cap", [Cl.uint(HUNDRED_PCT / 10n)]),
  );
  const debtBorrower = await fund(ctx, "debt-cap-borrower", { btc: 10n * UNIT, usdc: 1_000n * USDC });
  await ctx.step("add 10 BTC for the debt-cap probe", () => addCollateral(chain, debtBorrower, BTC, 10n * UNIT));
  await ctx.step("wait past the decay window for the debt bucket", () => sleep(25_000));
  await ctx.step("borrow one dollar to sync the debt bucket", () => borrow(chain, debtBorrower, 1n * USDC), "debt");
  const debtBucket = asUint(await chain.read("withdrawal-caps-v1", "get-debt-bucket"));
  // The debt bucket is a fraction of the borrowable balance, so assert the magnitude rather than
  // just using whatever value the contract reports.
  const borrowable = asUint(await chain.read("state-v1", "get-borrowable-balance"));
  const expectedDebtMax = (borrowable * (HUNDRED_PCT / 10n)) / HUNDRED_PCT;
  await ctx.assert(
    "debt bucket synced to 10% of the borrowable balance",
    absDiff(debtBucket, expectedDebtMax) <= capTolerance(expectedDebtMax),
    `bucket ${debtBucket} expected ${expectedDebtMax}`,
  );
  await ctx.attempt(
    "borrowing above the debt bucket aborts",
    () => borrow(chain, debtBorrower, debtBucket * 2n),
    "u120003",
    "debt",
  );
  await ctx.step("borrowing up to the debt bucket succeeds", () => borrow(chain, debtBorrower, debtBucket), "debt");
  // Repaying credits the bucket back, so later scenarios are not throttled by this probe.
  await ctx.step("repay the debt-cap probe", () => repay(chain, debtBorrower, 10n ** 30n), "debt");
  await ctx.step("restore the live debt cap", () =>
    callAsDeployer(chain, actors.deployer, "withdrawal-caps-v1", "set-debt-cap", [Cl.uint(PROFILE.caps.debt)]),
  );
  await ctx.step("restore live cap windows", () => setCapWindows(chain, actors.deployer, PROFILE.caps.windows));
});

scenario("bad-debt-socialization", async (ctx) => {
  const { chain, actors } = ctx;
  const borrower = await fund(ctx, "baddebt-borrower", { btc: 2n * UNIT });
  await ctx.step("deposit and stake a little LP", async () => {
    await deposit(chain, actors.staker, 10_000n * USDC);
    const balance = await lpBalance(chain, actors.staker.address);
    await stake(chain, actors.staker, balance / 10n);
  });
  // Leave a pending withdrawal so the slash's spill-over onto unfinalized withdrawals is observed.
  let withdrawalIndex: bigint | undefined;
  await ctx.step("initiate an unstake before the bad debt", async () => {
    const staked = await stakedBalance(chain, actors.staker.address);
    const result = await initiateUnstake(chain, actors.staker, staked / 2n);
    const match = /\(ok u(\d+)\)/.exec(result.result ?? "");
    if (!match) throw new Error(`no withdrawal index in ${result.result}`);
    withdrawalIndex = BigInt(match[1]);
  });
  const withdrawalSharesBefore = await (async () => {
    if (withdrawalIndex === undefined) throw new Error("withdrawal index not recorded");
    const stored = asOptional(
      await chain.read("staking-v1", "get-withdrawal", [Cl.principal(actors.staker.address), Cl.uint(withdrawalIndex)]),
    );
    if (!stored) throw new Error("withdrawal missing before the liquidation");
    return asUint(asTuple(stored)["withdrawal-shares"]);
  })();
  const withdrawalLpBefore = asUint(
    await chain.read("staking-v1", "convert-to-withdrawal-lp-tokens", [Cl.uint(withdrawalSharesBefore)]),
  );
  await ctx.step("add 1 BTC", () => addCollateral(chain, borrower, BTC, UNIT));
  await ctx.step("borrow 25,000", () => borrow(chain, borrower, 25_000n * USDC), "debt");
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
  const withdrawalLpAfter = asUint(
    await chain.read("staking-v1", "convert-to-withdrawal-lp-tokens", [Cl.uint(withdrawalSharesBefore)]),
  );
  await ctx.assert("position emptied", await userCollateral(chain, borrower.address, BTC) === 0n, "collateral remains");
  await ctx.assert("debt written off", position === null || position.debtShares === 0n, "debt remains");
  await ctx.assert("LP assets written down", assetsAfter < assetsBefore, `${assetsBefore} -> ${assetsAfter}`);
  await ctx.assert(
    "staked LP absorbed a slash",
    stakedAfter < stakedBefore,
    `${stakedBefore} -> ${stakedAfter}`,
  );
  await ctx.assert(
    "the slash spilled onto the pending withdrawal",
    withdrawalLpAfter < withdrawalLpBefore,
    `${withdrawalLpBefore} -> ${withdrawalLpAfter}`,
  );
  resetToBaseline();
});

scenario("remove-collateral-stuck", async (ctx) => {
  const { chain, actors } = ctx;
  // This scenario deliberately builds the documented stuck state, so the exitability invariant is
  // suspended here and restored in the finally.
  suspendExitability(true);
  try {
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
  // Half the posted ETH stays inside the live collateral cap even after a partial decay, so the
  // call reaches the de-listing check rather than failing on the cap first.
  await ctx.attempt(
    "withdrawing a de-listed collateral aborts",
    () => removeCollateral(chain, borrower, ETH, UNIT / 2n),
    "u108",
  );
  await ctx.step(`wait ${LIQUIDATION_BLOCK_GAP} blocks`, () => chain.waitBlocks(LIQUIDATION_BLOCK_GAP));
  setPrice(BTC, 30_000n);
  await ctx.attempt(
    "liquidating a de-listed collateral aborts",
    () => liquidate(chain, actors.liquidator, ETH, borrower.address, 1_000n * USDC),
    "u30005",
    "debt",
  );
  await ctx.step("restore ETH settings", () => {
    const eth = expectedCollateralConfigs()[ETH];
    return callAsDeployer(chain, actors.deployer, "state-v1", "update-collateral-settings", [
      Cl.contractPrincipal(chain.deployer, ETH),
      Cl.uint(eth.maxLtv),
      Cl.uint(eth.liquidationLtv),
      Cl.uint(eth.liquidationPremium),
      Cl.uint(eth.decimals),
    ]);
  });
    resetToBaseline();
  } finally {
    suspendExitability(false);
  }
});

scenario("governance", async (ctx) => {
  const { chain, actors } = ctx;
  const deployer = actors.deployer.address;
  const governance = Cl.contractPrincipal(chain.deployer, "governance-test");
  // The test governance and meta-governance are initialized in setup because the staking scenario
  // uses them too.
  await ctx.step("point state at the test governance", () =>
    chain.call(actors.deployer, "state-v1", "update-governance", [governance]),
  );

  await proposeAndExecute(ctx,
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

  await proposeAndExecute(ctx,
    "interest params",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-interest-params", [
        Cl.uint(800_000_000_000n),
        Cl.uint(1_600_000_000_000n),
        Cl.uint(750_000_000_000n),
        Cl.uint(350_000_000_000n),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    async () => {
      const params = asTuple(await chain.read("linear-kinked-ir-v1", "get-ir-params"));
      // Values distinct from setup, so a no-op execution cannot pass this check.
      return (
        asUint(params["base-ir"]) === 350_000_000_000n &&
        asUint(params["utilization-kink"]) === 750_000_000_000n
      );
    },
  );

  await proposeAndExecute(ctx,
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

  await proposeAndExecute(ctx,
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

  await proposeAndExecute(ctx,
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
    true, // unpausing is not time-locked, so it executes when the proposal is created
  );

  await proposeAndExecute(ctx,
    "restore ETH settings",
    async () => {
      const eth = expectedCollateralConfigs()[ETH];
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-collateral-settings", [
        Cl.contractPrincipal(chain.deployer, ETH),
        Cl.uint(eth.maxLtv),
        Cl.uint(eth.liquidationLtv),
        Cl.uint(eth.liquidationPremium),
        Cl.uint(eth.decimals),
      ]);
      return proposalIdFrom(result.result);
    },
    async () => (await collateralSettingsOf(chain, ETH)).maxLtv === expectedCollateralConfigs()[ETH].maxLtv,
  );

  await proposeAndExecute(ctx,
    "restore the BTC collateral cap",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-withdrawal-caps-param", [
        Cl.uint(32),
        Cl.tuple({ collateral: Cl.some(Cl.contractPrincipal(chain.deployer, BTC)), factor: Cl.uint(PROFILE.caps.collateral[BTC]) }),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    async () =>
      asUint(
        await chain.read("withdrawal-caps-v1", "get-collateral-cap-factor", [
          Cl.contractPrincipal(chain.deployer, BTC),
        ]),
      ) === PROFILE.caps.collateral[BTC],
  );

  await proposeAndExecute(ctx,
    "restore the live interest params",
    async () => {
      const result = await chain.call(actors.deployer, "governance-test", "initiate-proposal-to-update-interest-params", [
        Cl.uint(PROFILE.ir.slope1),
        Cl.uint(PROFILE.ir.slope2),
        Cl.uint(PROFILE.ir.kink),
        Cl.uint(PROFILE.ir.base),
        Cl.uint(1000),
      ]);
      return proposalIdFrom(result.result);
    },
    async () => {
      const params = asTuple(await chain.read("linear-kinked-ir-v1", "get-ir-params"));
      return asUint(params["base-ir"]) === PROFILE.ir.base && asUint(params["utilization-kink"]) === PROFILE.ir.kink;
    },
  );

  await proposeAndExecute(ctx,
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
    (await collateralSettingsOf(chain, ETH)).maxLtv === expectedCollateralConfigs()[ETH].maxLtv,
    "ETH config moved unexpectedly",
  );
  await ctx.assert("STX still configured", (await collateralSettingsOf(chain, STX)).maxLtv === expectedCollateralConfigs()[STX].maxLtv, "STX missing");
  await ctx.assert(
    "caps read",
    (await asUint(await chain.read("withdrawal-caps-v1", "get-refill-time-window"))) === PROFILE.caps.windows.refill,
    "refill window changed",
  );
});
