import { Cl } from "@stacks/transactions";
import type { Scenario } from "../scenario.ts";
import { addCollateral, borrow, deposit, repay, withdraw } from "../actors.ts";
import { BTC, MARKET, lpParams } from "../setup.ts";
import { positionOf, tokenBalance, userCollateral } from "../reads.ts";
import { asTuple, asUint } from "../values.ts";

const USDC = 100_000_000n;

export const happy: Scenario = {
  name: "happy-path",
  async run(ctx) {
    const { chain, actors } = ctx;
    const borrower = actors.safe;
    const lp = actors.lp;

    const lpBefore = await tokenBalance(chain, MARKET, lp.address);
    const assetsBefore = (await lpParams(chain)).totalAssets;
    await ctx.step("lp deposits 1,000,000", () => deposit(chain, lp, 1_000_000n * USDC));
    await ctx.assert(
      "lp balance debited",
      (await tokenBalance(chain, MARKET, lp.address)) === lpBefore - 1_000_000n * USDC,
      "lp USDC balance did not drop by the deposit",
    );

    await ctx.step("borrower adds 1 BTC", () => addCollateral(chain, borrower, BTC, 100_000_000n));
    await ctx.step("borrower borrows 30,000", () => borrow(chain, borrower, 30_000n * USDC), "debt");
    await ctx.assert(
      "borrow credited",
      (await tokenBalance(chain, MARKET, borrower.address)) === 30_000n * USDC,
      "borrower did not receive the borrowed USDC",
    );
    // The market's first debt: open interest is principal only, which pins the principal bookkeeping.
    const firstDebt = asTuple(await chain.read("state-v1", "get-debt-params"));
    const firstBorrowed = asTuple(
      await chain.read("state-v1", "get-borrow-repay-params", [Cl.principal(borrower.address)]),
    );
    await ctx.assert(
      "the first borrow leaves open interest equal to the outstanding principal",
      asUint(firstDebt["open-interest"]) === asUint(firstBorrowed["total-borrowed-amount"]),
      `open ${asUint(firstDebt["open-interest"])} vs principal ${asUint(firstBorrowed["total-borrowed-amount"])}`,
    );

    await ctx.step("borrower repays 15,000", () => repay(chain, borrower, 15_000n * USDC), "debt");
    await ctx.assert(
      "repay debited",
      (await tokenBalance(chain, MARKET, borrower.address)) === 15_000n * USDC,
      "borrower balance after repay is not 15,000",
    );

    const position = await positionOf(chain, borrower.address);
    await ctx.assert(
      "position open",
      position !== null && position.debtShares > 0n,
      "borrower position is missing after a partial repay",
    );
    await ctx.assert(
      "collateral kept",
      (await userCollateral(chain, borrower.address, BTC)) === 100_000_000n,
      "collateral changed although the scenario removes none",
    );

    await ctx.step("lp withdraws 100,000", () => withdraw(chain, lp, 100_000n * USDC));
    const lpAfter = await lpParams(chain);
    const assetsDelta = lpAfter.totalAssets - assetsBefore;
    await ctx.assert(
      "market assets move by the deposit minus the withdrawal",
      assetsDelta > 899_000n * USDC && assetsDelta < 901_000n * USDC,
      `unexpected total-assets delta ${assetsDelta}`,
    );
  },
};
