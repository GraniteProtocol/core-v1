import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  set_allowed_contracts,
  initialize_governance,
  initialize_ir,
  mint_token,
  remove_collateral,
  repay,
  state_set_governance_contract,
  update_supported_collateral,
  update_supported_collateral_governance,
  set_asset_cap,
  initialize_staking_reward,
  initialize_lp,
} from "./utils";
import {
  build_price_update,
  init_pyth,
  set_initial_price,
  set_price_without_scaling,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const borrower = accounts.get("wallet_1")!;
const depositor = accounts.get("wallet_4")!;
const liquidator = accounts.get("wallet_5")!;
const deployer = accounts.get("deployer")!;

const STX = "stx-sip010";
const STATE = `${deployer}.state-v1`;

// STX is 6-decimal, so collateral amounts are micro-STX.
const ONE_STX = 1_000_000;
const STX_COLLATERAL = 100 * ONE_STX; // 100 STX

// The simnet market token (mock-usdc) is 8-decimal, so debt figures are 1e8 per
// dollar. Collateral is scaled 6 -> 8 by math-v1.to-fixed before comparison.
const ONE_USD_DEBT = 100_000_000;
const BORROW = 100 * ONE_USD_DEBT; // $100

const stxBalance = (who: string): bigint =>
  (
    simnet.callReadOnlyFn(STX, "get-balance", [Cl.principal(who)], deployer)
      .result as any
  ).value.value as bigint;

describe("STX as collateral via the SIP-010 facade", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price(STX, 2n, deployer);
    // 60% max LTV, 75% liquidation LTV, 10% premium, 6 decimals
    update_supported_collateral(STX, 60000000, 75000000, 10000000, 6, deployer);
  });

  it("reports supply from the runtime, and balance tracks the native account", () => {
    const supply = simnet.callReadOnlyFn(STX, "get-total-supply", [], deployer);
    const reported = (supply.result as any).value.value as bigint;
    // stx-liquid-supply equals exactly what simnet handed out, with zero slack to spare
    const assets = simnet.getAssetsMap().get("STX")!;
    const handedOut = [...assets.values()].reduce((a, b) => a + b, 0n);
    expect(reported, "get-total-supply must equal stx-liquid-supply exactly").toStrictEqual(
      handedOut
    );

    // and get-balance is the account itself, not a facade-side ledger
    expect(
      stxBalance(borrower),
      "get-balance must read the native account balance"
    ).toStrictEqual(assets.get(borrower));
  });

  it("reports STX's own metadata on the SIP-010 surface", () => {
    // get-decimals is checked separately, against the governance registration path that
    // actually depends on it - see "governance registers STX with the decimals the facade reports".
    expect(
      simnet.callReadOnlyFn(STX, "get-name", [], deployer).result,
      "get-name"
    ).toBeOk(Cl.stringAscii("Stacks"));
    expect(
      simnet.callReadOnlyFn(STX, "get-symbol", [], deployer).result,
      "get-symbol"
    ).toBeOk(Cl.stringAscii("STX"));
    expect(
      simnet.callReadOnlyFn(STX, "get-token-uri", [], deployer).result,
      "get-token-uri"
    ).toBeOk(Cl.none());
  });

  it("governance registers STX with the decimals the facade reports", () => {
    // governance-v1 derives decimals from (contract-call? token get-decimals) at proposal
    // time, so this is the one production path that actually depends on get-decimals.
    const governance_account = accounts.get("wallet_2")!;
    const guardian_account = accounts.get("wallet_3")!;
    initialize_governance(governance_account, guardian_account, deployer);
    state_set_governance_contract(deployer);

    update_supported_collateral_governance(
      STX,
      60000000,
      75000000,
      10000000,
      deployer,
      governance_account
    );

    const c = simnet.callReadOnlyFn(
      "state-v1",
      "get-collateral",
      [Cl.contractPrincipal(deployer, STX)],
      deployer
    );
    expect(
      (c.result as any).value.value["decimals"],
      "governance derives decimals from the facade's get-decimals, not a caller-supplied value"
    ).toStrictEqual(Cl.uint(6));
  });

  it("honours the memo variant rather than discarding it", () => {
    const before = stxBalance(depositor);
    const withMemo = simnet.callPublicFn(
      STX,
      "transfer",
      [
        Cl.uint(ONE_STX),
        Cl.principal(borrower),
        Cl.principal(depositor),
        Cl.some(Cl.bufferFromAscii("granite")),
      ],
      borrower
    );
    expect(withMemo.result, "transfer with a memo succeeds").toBeOk(
      Cl.bool(true)
    );
    expect(
      stxBalance(depositor),
      "balance moves by the transferred amount"
    ).toStrictEqual(before + BigInt(ONE_STX));
    expect(
      (withMemo.events[0].data as any).memo,
      "the memo survives onto the stx_transfer_event, rather than being dropped"
    ).toBe("6772616e697465");

    const withoutMemo = simnet.callPublicFn(
      STX,
      "transfer",
      [
        Cl.uint(ONE_STX),
        Cl.principal(borrower),
        Cl.principal(depositor),
        Cl.none(),
      ],
      borrower
    );
    expect(withoutMemo.result, "transfer without a memo succeeds").toBeOk(
      Cl.bool(true)
    );
    expect(
      (withoutMemo.events[0].data as any).memo,
      "no memo means an empty event memo, not the previous call's memo"
    ).toBe("");
  });

  it("add-collateral moves NATIVE STX from the user into state-v1", () => {
    const userBefore = stxBalance(borrower);
    const stateBefore = stxBalance(STATE);

    add_collateral(STX, STX_COLLATERAL, deployer, borrower);

    expect(
      stxBalance(borrower),
      "the user's native balance drops by the posted amount"
    ).toStrictEqual(userBefore - BigInt(STX_COLLATERAL));
    expect(
      stxBalance(STATE),
      "state-v1's native balance rises by the posted amount"
    ).toStrictEqual(stateBefore + BigInt(STX_COLLATERAL));

    const rec = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-collateral",
      [Cl.principal(borrower), Cl.contractPrincipal(deployer, STX)],
      deployer
    );
    expect(
      (rec.result as any).value.value["amount"],
      "state-v1 records the posted amount against the user"
    ).toStrictEqual(Cl.uint(STX_COLLATERAL));
  });

  it("supports the full borrow / repay / withdraw cycle against STX collateral", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);

    add_collateral(STX, STX_COLLATERAL, deployer, borrower);

    // 100 STX at $2 = $200, 60% max LTV -> $100 sits inside the limit
    borrow(BORROW, borrower);
    const usdc = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower)],
      borrower
    );
    expect(
      (usdc.result as any).value.value,
      "borrow pays out the market token, unaffected by the collateral being STX"
    ).toStrictEqual(BigInt(BORROW));

    mint_token("mock-usdc", 10 * ONE_USD_DEBT, borrower); // interest headroom
    repay(BORROW + ONE_USD_DEBT, borrower);

    const beforeWithdraw = stxBalance(borrower);
    remove_collateral(STX, STX_COLLATERAL, deployer, borrower);
    expect(
      stxBalance(borrower),
      "full repayment unlocks the full STX collateral back to the user"
    ).toStrictEqual(beforeWithdraw + BigInt(STX_COLLATERAL));
    expect(
      stxBalance(STATE),
      "state-v1 holds no leftover STX once the position is fully unwound"
    ).toStrictEqual(0n);
  });

  it("liquidation pays the liquidator in native STX", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);

    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    borrow(BORROW, borrower);

    // STX drops to $1.30: $200 collateral -> $130, so the 75% liquidation mark
    // ($130 * 75% = $97.50) sits below the ~$100 debt, but $130 still covers it -
    // solvent, so this liquidation never reaches socialize-bad-debt.
    await set_price_without_scaling(STX, 130000000n, deployer);
    simnet.mineEmptyBlocks(6); // MINIMUM-LIQUIDATION-BLOCK-GAP, liquidator-v1.clar:17

    mint_token("mock-usdc", 100 * ONE_USD_DEBT, liquidator);
    const liqStxBefore = stxBalance(liquidator);
    const stateStxBefore = stxBalance(STATE);

    // $10 repaid at the 10% premium is $11 of value; at $1.30/STX that's
    // 11 / 1.30 STX, floored through the 8-to-6-decimal conversion: 8461538 microSTX.
    const EXPECTED_SEIZURE = 8_461_538;

    const res = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        Cl.contractPrincipal(deployer, STX),
        Cl.principal(borrower),
        Cl.uint(10 * ONE_USD_DEBT), // repay $10 of the debt
        Cl.uint(EXPECTED_SEIZURE), // min-collateral-expected: a real, working slippage guard
      ],
      liquidator
    );
    expect(res.result, "liquidation succeeds").toBeOk(Cl.bool(true));

    expect(
      stxBalance(liquidator) - liqStxBefore,
      "the liquidator is paid the exact seized STX"
    ).toStrictEqual(BigInt(EXPECTED_SEIZURE));
    expect(
      stateStxBefore - stxBalance(STATE),
      "state-v1's native balance drops by exactly the seized amount"
    ).toStrictEqual(BigInt(EXPECTED_SEIZURE));

    const remaining = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-collateral",
      [Cl.principal(borrower), Cl.contractPrincipal(deployer, STX)],
      deployer
    );
    expect(
      (remaining.result as any).value.value["amount"],
      "the borrower's recorded collateral drops by exactly the seized amount"
    ).toStrictEqual(Cl.uint(STX_COLLATERAL - EXPECTED_SEIZURE));

    const liquidateEvent = res.events.find(
      (e: any) =>
        e.event === "print_event" &&
        e.data?.value?.value?.action?.value === "liquidate-collateral"
    );
    expect(
      liquidateEvent?.data?.value?.value?.["bad-debt"]?.type,
      "the position stays solvent, so bad-debt is false on the liquidation event"
    ).toBe("false");
  });

  it("cannot post more STX than the user holds", () => {
    const held = stxBalance(borrower);
    const res = simnet.callPublicFn(
      "borrower-v1",
      "add-collateral",
      [
        Cl.contractPrincipal(deployer, STX),
        Cl.uint(Number(held) + ONE_STX),
        Cl.none(),
      ],
      borrower
    );
    // u1: native stx-transfer? rejects a sender with insufficient balance
    expect(
      res.result,
      "insufficient STX balance fails with the native transfer error, not some other rejection"
    ).toBeErr(Cl.uint(1));
  });

  it("maybe-user must be the tx-sender on both add and remove", () => {
    const added = simnet.callPublicFn(
      "borrower-v1",
      "add-collateral",
      [
        Cl.contractPrincipal(deployer, STX),
        Cl.uint(ONE_STX),
        Cl.some(Cl.principal(depositor)),
      ],
      borrower
    );
    expect(
      added.result,
      "add-collateral on behalf of another maybe-user is ERR-NOT-TX-SENDER"
    ).toBeErr(Cl.uint(20010));

    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    const removed = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [
        Cl.buffer(build_price_update()),
        Cl.contractPrincipal(deployer, STX),
        Cl.uint(ONE_STX),
        Cl.some(Cl.principal(depositor)),
      ],
      borrower
    );
    expect(
      removed.result,
      "remove-collateral on behalf of another maybe-user is ERR-NOT-TX-SENDER"
    ).toBeErr(Cl.uint(20010));
  });

  it("a collateral cap rate-limits STX withdrawals once set", () => {
    const cap = simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-collateral-cap",
      [Cl.contractPrincipal(deployer, STX), Cl.uint(10_000_000)], // 10% of 1e8
      deployer
    );
    expect(cap.result, "governance sets the collateral cap factor").toBeOk(
      Cl.bool(true)
    );

    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    // decay-time-window is u10800 (withdrawal-caps-v1.clar:33); 20 empty blocks
    // fully decays the bucket to its max, same as tests/modules/withdrawal-caps.test.ts.
    simnet.mineEmptyBlocks(20);

    const tooBig = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [
        Cl.buffer(build_price_update()),
        Cl.contractPrincipal(deployer, STX),
        Cl.uint(50 * ONE_STX),
        Cl.none(),
      ],
      borrower
    );
    expect(
      tooBig.result,
      "a withdrawal over the decayed cap is ERR-WITHDRAWAL-COLLATERAL-CAP-EXCEEDED"
    ).toBeErr(Cl.uint(120004));

    // inside the bucket it goes through, in native STX
    const before = stxBalance(borrower);
    remove_collateral(STX, 5 * ONE_STX, deployer, borrower);
    expect(
      stxBalance(borrower),
      "a withdrawal inside the cap succeeds in native STX"
    ).toStrictEqual(before + BigInt(5 * ONE_STX));
  });

  it("accumulates across repeated deposits rather than overwriting", () => {
    add_collateral(STX, 10 * ONE_STX, deployer, borrower);
    add_collateral(STX, 10 * ONE_STX, deployer, borrower);

    const rec = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-collateral",
      [Cl.principal(borrower), Cl.contractPrincipal(deployer, STX)],
      deployer
    );
    expect(
      (rec.result as any).value.value["amount"],
      "repeated deposits sum rather than overwrite"
    ).toStrictEqual(Cl.uint(20 * ONE_STX));
    expect(
      stxBalance(STATE),
      "state-v1's native balance reflects both deposits"
    ).toStrictEqual(BigInt(20 * ONE_STX));

    const pos = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower)],
      deployer
    );
    expect(
      (pos.result as any).value.value["collaterals"].value,
      "the second deposit merges into the existing entry, not a new one"
    ).toHaveLength(1);
  });

  it("keeps two providers' STX collateral separate", () => {
    add_collateral(STX, 30 * ONE_STX, deployer, borrower);
    add_collateral(STX, 70 * ONE_STX, deployer, depositor);

    const amountFor = (who: string) =>
      (
        simnet.callReadOnlyFn(
          "state-v1",
          "get-user-collateral",
          [Cl.principal(who), Cl.contractPrincipal(deployer, STX)],
          deployer
        ).result as any
      ).value.value["amount"];

    expect(
      amountFor(borrower),
      "the first provider's recorded amount is unaffected by the second's deposit"
    ).toStrictEqual(Cl.uint(30 * ONE_STX));
    expect(
      amountFor(depositor),
      "the second provider's recorded amount is unaffected by the first's deposit"
    ).toStrictEqual(Cl.uint(70 * ONE_STX));
    expect(
      stxBalance(STATE),
      "state-v1's native balance is the sum of both providers' deposits"
    ).toStrictEqual(BigInt(100 * ONE_STX));
  });

  it("allows a partial removal that stays inside max LTV", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);
    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    borrow(BORROW, borrower);

    // $200 collateral against $100 debt at 60% max LTV leaves room for ~16 STX
    const before = stxBalance(borrower);
    remove_collateral(STX, 10 * ONE_STX, deployer, borrower);
    expect(
      stxBalance(borrower),
      "a within-limit partial removal succeeds in native STX"
    ).toStrictEqual(before + BigInt(10 * ONE_STX));
    expect(
      stxBalance(STATE),
      "state-v1 retains exactly what wasn't withdrawn"
    ).toStrictEqual(BigInt(STX_COLLATERAL - 10 * ONE_STX));
  });

  it("sits alongside an 8-decimal collateral in one position", async () => {
    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    await set_initial_price("mock-btc", 1n, deployer);

    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);

    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    mint_token("mock-btc", 100_000_000, borrower);
    add_collateral("mock-btc", 100_000_000, deployer, borrower);

    const pos = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower)],
      deployer
    );
    const collaterals = (pos.result as any).value.value["collaterals"].value;
    expect(
      collaterals,
      "the 6-decimal and 8-decimal collaterals both land in the same position"
    ).toHaveLength(2);

    // the combined position still borrows correctly with a 6-decimal collateral present
    borrow(BORROW, borrower);
    const usdc = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower)],
      borrower
    );
    expect(
      (usdc.result as any).value.value,
      "borrow still pays out the correct market-token amount"
    ).toStrictEqual(BigInt(BORROW));

    expect(stxBalance(STATE), "the STX leg is unaffected by the borrow").toStrictEqual(
      BigInt(STX_COLLATERAL)
    );
  });

  it("state-v1's pooled STX is not reachable through the facade's permissionless sender", () => {
    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    const stateBefore = stxBalance(STATE);

    const res = simnet.callPublicFn(
      STX,
      "transfer",
      [Cl.uint(ONE_STX), Cl.principal(STATE), Cl.principal(borrower), Cl.none()],
      borrower // an EOA, not state-v1 itself
    );
    expect(
      res.result,
      "an EOA can't move state-v1's pooled STX by naming it as the sender"
    ).toBeErr(Cl.uint(4));
    expect(
      stxBalance(STATE),
      "state-v1's pooled STX is untouched by the attempted drain"
    ).toStrictEqual(stateBefore);
  });
});
