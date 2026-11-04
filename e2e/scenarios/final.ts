import { Cl, type ClarityValue } from "@stacks/transactions";
import { newAccount, fundAccount } from "../accounts.ts";
import type { Account } from "../keys.ts";
import type { Chain } from "../chain.ts";
import type { Scenario } from "../scenario.ts";
import { BTC, MARKET, PROFILE, collateralSettingsOf, mint } from "../setup.ts";
import { addCollateral, borrow, deposit } from "../actors.ts";
import { registerProbeUser } from "../invariants.ts";
import { asBool, asOk, asOptional, asPrincipal, asTuple, asUint } from "../values.ts";

const USDC = 100_000_000n;

const proposalIdFrom = (repr: string | undefined): string => {
  const match = repr?.match(/0x([0-9a-f]{64})/);
  if (!match) throw new Error(`no proposal id in ${repr}`);
  return match[1];
};

const proposalOf = async (chain: Chain, id: string) =>
  asOptional(await chain.read("governance-v1", "get-proposal", [Cl.bufferFromHex(id)]));

const isMemberOf = async (chain: Chain, contract: string, who: string): Promise<boolean> =>
  asBool(asOk(await chain.read(contract, "is-governance-member", [Cl.principal(who)])));


/** Runs after the fuzz phase: governance-real leaves state governance on governance-v1. */
export const governanceReal: Scenario = {
  name: "governance-real",
  run: async (ctx) => {
    const { chain, actors } = ctx;
    const deployer = actors.deployer;
    const funded = async (name: string, funds: { usdc?: bigint; btc?: bigint }): Promise<Account> => {
      const account = newAccount(name);
      registerProbeUser(account.address);
      await ctx.step(`fund ${name}`, () => fundAccount(chain, actors.deployer, account));
      if (funds.usdc) {
        await ctx.step(`mint usdc ${name}`, () => mint(chain, actors.deployer, MARKET, funds.usdc as bigint, account.address));
      }
      if (funds.btc) {
        await ctx.step(`mint btc ${name}`, () => mint(chain, actors.deployer, BTC, funds.btc as bigint, account.address));
      }
      return account;
    };

    const guardian = await funded("gov-guardian", {});
    const memberB = await funded("gov-member-b", {});
    const memberC = await funded("gov-member-c", {});
    const borrower = await funded("gov-borrower", { usdc: 1_000n * USDC, btc: 100_000_000n });

    const governor = asPrincipal(await chain.read("state-v1", "get-governance"));
    await ctx.assert(
      "the deployer still holds market governance",
      governor === deployer.address,
      `governance is ${governor}; an earlier scenario did not hand it back`,
    );
    await ctx.step("initialize governance-v1 with the guardian", () =>
      chain.call(deployer, "governance-v1", "initialize-governance", [
        Cl.list([Cl.some(Cl.principal(guardian.address)), Cl.none(), Cl.none(), Cl.none(), Cl.none()]),
      ]),
    );
    await ctx.step("point state governance at governance-v1", () =>
      chain.call(deployer, "state-v1", "update-governance", [
        Cl.contractPrincipal(chain.deployer, "governance-v1"),
      ]),
    );
    await ctx.attempt(
      "a non-member cannot initiate a governance proposal",
      () =>
        chain.call(guardian, "governance-v1", "initiate-proposal-to-set-market-feature", [
          Cl.uint(2n),
          Cl.bool(false),
          Cl.uint(1000n),
          Cl.uint(0n),
        ]),
      "u50000",
    );
    await ctx.step("borrower posts collateral", () => addCollateral(chain, borrower, BTC, 100_000_000n));

    const propose = async (label: string, account: Account, fn: string, args: ClarityValue[]): Promise<string> => {
      let id = "";
      await ctx.step(`propose ${label}`, async () => {
        const result = await chain.call(account, "governance-v1", fn, args);
        id = proposalIdFrom(result.result);
      });
      return id;
    };
    const setDepositFlag = async (enabled: boolean): Promise<string> =>
      propose(`deposits ${enabled ? "enabled" : "disabled"}`, deployer, "initiate-proposal-to-set-market-feature", [
        Cl.uint(2n),
        Cl.bool(enabled),
        Cl.uint(1000n),
        Cl.uint(0n),
      ]);

    // Immediate actions execute at initiation.
    await setDepositFlag(false);
    await ctx.assert(
      "the deposit flag is disabled through governance",
      !asBool(await chain.read("state-v1", "is-deposit-asset-enabled")),
      "still enabled",
    );
    await ctx.attempt("deposit aborts after the governance action", () => deposit(chain, actors.staker, 1n * USDC), "u102");
    await setDepositFlag(true);
    await ctx.step("deposit works again", () => deposit(chain, actors.staker, 1n * USDC));

    const distinctCap = 1_234_567_890_000_000n;
    await propose("a distinct asset cap", deployer, "initiate-proposal-to-update-asset-cap", [
      Cl.uint(distinctCap),
      Cl.uint(1000n),
    ]);
    await ctx.assert(
      "the asset cap moved",
      asUint(await chain.read("state-v1", "get-asset-cap")) === distinctCap,
      "cap unchanged",
    );
    await propose("the test asset cap", deployer, "initiate-proposal-to-update-asset-cap", [
      Cl.uint(PROFILE.test.assetCap),
      Cl.uint(1000n),
    ]);

    // A time-locked action records execute-at and refuses to run now.
    const timelocked = await propose("new BTC settings", deployer, "initiate-proposal-to-update-collateral-settings", [
      Cl.contractPrincipal(chain.deployer, BTC),
      Cl.uint(40_000_000n),
      Cl.uint(65_000_000n),
      Cl.uint(10_000_000n),
      Cl.uint(1000n),
    ]);
    const timelockedProposal = await proposalOf(chain, timelocked);
    const executeAt = timelockedProposal
      ? asOptional(asTuple(timelockedProposal)["execute-at"])
      : null;
    const height = await chain.blockHeight();
    await ctx.assert(
      "the collateral proposal is time-locked",
      executeAt !== null && asUint(executeAt) >= BigInt(height) + 21_500n,
      `execute-at ${executeAt === null ? "none" : asUint(executeAt)} vs height ${height}`,
    );
    await ctx.attempt(
      "executing a time-locked proposal aborts",
      () => chain.call(deployer, "governance-v1", "execute", [Cl.bufferFromHex(timelocked)]),
      "u40017",
    );
    await ctx.assert(
      "the time-locked settings are unchanged",
      (await collateralSettingsOf(chain, BTC)).maxLtv === PROFILE.collateral[BTC].maxLtv,
      "settings moved",
    );

    // Deny path: with three members a proposal can be denied by the two who did not initiate it.
    const addMember = async (member: Account): Promise<string> => {
      let id = "";
      await ctx.step(`add member ${member.name}`, async () => {
        const result = await chain.call(deployer, "meta-governance-v1", "initiate-proposal-to-update-governance-multisig", [
          Cl.uint(0n),
          Cl.principal(member.address),
          Cl.uint(1000n),
        ]);
        id = proposalIdFrom(result.result);
      });
      return id;
    };
    await addMember(memberB);
    await ctx.assert(
      "the first member joined meta-governance",
      await isMemberOf(chain, "meta-governance-v1", memberB.address),
      "member B missing",
    );
    const addC = await addMember(memberC);
    await ctx.step("the first member approves the second", () =>
      chain.call(memberB, "meta-governance-v1", "approve", [Cl.bufferFromHex(addC)]),
    );
    await ctx.assert(
      "the second member joined meta-governance",
      await isMemberOf(chain, "meta-governance-v1", memberC.address),
      "member C missing",
    );

    const denyId = await propose("a deposit-flag change from the second member", memberB, "initiate-proposal-to-set-market-feature", [
      Cl.uint(2n),
      Cl.bool(false),
      Cl.uint(1000n),
      Cl.uint(0n),
    ]);
    await ctx.assert(
      "the proposal did not execute at initiation",
      asBool(await chain.read("state-v1", "is-deposit-asset-enabled")),
      "deposits changed",
    );
    await ctx.step("the deployer denies it", () =>
      chain.call(deployer, "governance-v1", "deny", [Cl.bufferFromHex(denyId)]),
    );
    await ctx.step("the third member denies it", () =>
      chain.call(memberC, "governance-v1", "deny", [Cl.bufferFromHex(denyId)]),
    );
    const denied = await proposalOf(chain, denyId);
    await ctx.assert(
      "the denied proposal closed without executing",
      denied !== null && asBool(asTuple(denied)["closed"]) && !asBool(asTuple(denied)["executed"]),
      "proposal state wrong",
    );
    await ctx.attempt(
      "executing a denied proposal aborts",
      () => chain.call(deployer, "governance-v1", "execute", [Cl.bufferFromHex(denyId)]),
      "u40004",
    );

    // Guardian path: pause, then unpause through governance action 10.
    await ctx.step("the guardian pauses the market", () =>
      chain.call(guardian, "governance-v1", "guardian-pause-market", []),
    );
    await ctx.assert(
      "the market is paused",
      !asBool(await chain.read("state-v1", "is-borrow-enabled")),
      "still enabled",
    );
    await ctx.attempt("deposit aborts while paused", () => deposit(chain, actors.staker, 1n * USDC), "u102");
    await ctx.attempt("borrow aborts while paused", () => borrow(chain, borrower, 1_000n * USDC), "u102", "debt");

    const unpauseId = await propose("the unpause", deployer, "initiate-proposal-to-set-market-state", [
      Cl.uint(10n),
      Cl.uint(2000n),
      Cl.uint(0n),
    ]);
    await ctx.step("the second member approves the unpause", () =>
      chain.call(memberB, "governance-v1", "approve", [Cl.bufferFromHex(unpauseId)]),
    );
    await ctx.assert(
      "the market is unpaused",
      asBool(await chain.read("state-v1", "is-borrow-enabled")),
      "still paused",
    );
    await ctx.step("deposit works again", () => deposit(chain, actors.staker, 1n * USDC));
    await ctx.step("borrow works again", () => borrow(chain, borrower, 1_000n * USDC), "debt");
    await ctx.assert(
      "the unpause also restored the staking flag",
      asBool(await chain.read("state-v1", "is-staking-enabled")),
      "staking still disabled",
    );
    const finalGovernance = asPrincipal(await chain.read("state-v1", "get-governance"));
    await ctx.assert(
      "state governance is still governance-v1",
      finalGovernance === `${chain.deployer}.governance-v1`,
      `governance is ${finalGovernance}`,
    );
  },
};
