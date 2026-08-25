import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  set_allowed_contracts,
  initialize_ir,
  mint_token,
  remove_collateral,
  repay,
  update_supported_collateral,
  set_asset_cap,
  initialize_staking_reward,
  initialize_lp,
} from "./utils";
import {
  build_price_update,
  init_pyth,
  set_initial_price,
  set_price,
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
    // stx-liquid-supply, so it must be at least everything simnet handed out
    const assets = simnet.getAssetsMap().get("STX")!;
    const handedOut = [...assets.values()].reduce((a, b) => a + b, 0n);
    expect(reported).toBeGreaterThanOrEqual(handedOut);

    // and get-balance is the account itself, not a facade-side ledger
    expect(stxBalance(borrower)).toStrictEqual(assets.get(borrower));
  });

  it("reports STX's own metadata on the SIP-010 surface", () => {
    expect(
      simnet.callReadOnlyFn(STX, "get-name", [], deployer).result
    ).toBeOk(Cl.stringAscii("Stacks"));
    expect(
      simnet.callReadOnlyFn(STX, "get-symbol", [], deployer).result
    ).toBeOk(Cl.stringAscii("STX"));
    expect(
      simnet.callReadOnlyFn(STX, "get-decimals", [], deployer).result
    ).toBeOk(Cl.uint(6));
    expect(
      simnet.callReadOnlyFn(STX, "get-token-uri", [], deployer).result
    ).toBeOk(Cl.none());
  });

  it("cannot be used to move a third party's STX", () => {
    const victim = stxBalance(depositor);
    const res = simnet.callPublicFn(
      STX,
      "transfer",
      [
        Cl.uint(ONE_STX),
        Cl.principal(depositor),
        Cl.principal(borrower),
        Cl.none(),
      ],
      borrower // tx-sender is not the sender
    );
    expect(res.result).toBeErr(Cl.uint(4));
    expect(stxBalance(depositor)).toStrictEqual(victim);
  });

  it("honours the memo variant rather than discarding it", () => {
    const before = stxBalance(depositor);
    const res = simnet.callPublicFn(
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
    expect(res.result).toBeOk(Cl.bool(true));
    expect(stxBalance(depositor)).toStrictEqual(before + BigInt(ONE_STX));
  });

  it("registers as a supported collateral with 6 decimals", () => {
    const c = simnet.callReadOnlyFn(
      "state-v1",
      "get-collateral",
      [Cl.contractPrincipal(deployer, STX)],
      deployer
    );
    expect((c.result as any).value.value["decimals"]).toStrictEqual(Cl.uint(6));
  });

  it("add-collateral moves NATIVE STX from the user into state-v1", () => {
    const userBefore = stxBalance(borrower);
    const stateBefore = stxBalance(STATE);

    add_collateral(STX, STX_COLLATERAL, deployer, borrower);

    expect(stxBalance(borrower)).toStrictEqual(
      userBefore - BigInt(STX_COLLATERAL)
    );
    expect(stxBalance(STATE)).toStrictEqual(stateBefore + BigInt(STX_COLLATERAL));

    const rec = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-collateral",
      [Cl.principal(borrower), Cl.contractPrincipal(deployer, STX)],
      deployer
    );
    expect((rec.result as any).value.value["amount"]).toStrictEqual(
      Cl.uint(STX_COLLATERAL)
    );
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
    expect((usdc.result as any).value.value).toStrictEqual(BigInt(BORROW));

    mint_token("mock-usdc", 10 * ONE_USD_DEBT, borrower); // interest headroom
    repay(BORROW + ONE_USD_DEBT, borrower);

    const beforeWithdraw = stxBalance(borrower);
    remove_collateral(STX, STX_COLLATERAL, deployer, borrower);
    expect(stxBalance(borrower)).toStrictEqual(
      beforeWithdraw + BigInt(STX_COLLATERAL)
    );
    expect(stxBalance(STATE)).toStrictEqual(0n);
  });

  it("liquidation pays the liquidator in native STX", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);

    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    borrow(BORROW, borrower);

    // STX halves: $200 collateral -> $100 against $100 debt, past the 75% mark
    await set_price(STX, 1n, deployer);
    simnet.mineEmptyBlocks(6); // state-v1 refuses a liquidation in the borrow block

    mint_token("mock-usdc", 100 * ONE_USD_DEBT, liquidator);
    const liqStxBefore = stxBalance(liquidator);
    const stateStxBefore = stxBalance(STATE);

    const res = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        Cl.contractPrincipal(deployer, STX),
        Cl.principal(borrower),
        Cl.uint(10 * ONE_USD_DEBT), // repay $10 of the debt
        Cl.uint(1), // min-collateral-expected
      ],
      liquidator
    );
    expect(res.result).toBeOk(Cl.bool(true));

    // seized collateral left state-v1 as real STX and landed on the liquidator
    expect(stxBalance(liquidator)).toBeGreaterThan(liqStxBefore);
    expect(stxBalance(STATE)).toBeLessThan(stateStxBefore);
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
    expect((res.result as any).type).not.toBe("ok");
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
    expect(added.result).toBeErr(Cl.uint(20010)); // ERR-NOT-TX-SENDER

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
    expect(removed.result).toBeErr(Cl.uint(20010));
  });

  it("refuses a removal that would breach max LTV", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);
    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    borrow(BORROW, borrower);

    // pulling half the collateral leaves $100 backing $100 of debt at 60% max LTV
    const res = simnet.callPublicFn(
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
    expect(res.result).toBeErr(Cl.uint(20002)); // ERR-MAX-LTV
    // and the STX stayed put
    expect(stxBalance(STATE)).toStrictEqual(BigInt(STX_COLLATERAL));
  });

  it("withdrawal is UNCAPPED while no cap factor is set", () => {
    // Documents the bypass at withdrawal-caps-v1: a zero cap factor is an early
    // SUCCESS, not a block, so omitting the cap ships an unlimited rate.
    const factor = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-cap-factor",
      [Cl.contractPrincipal(deployer, STX)],
      deployer
    );
    expect(factor.result).toStrictEqual(Cl.uint(0));

    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    remove_collateral(STX, STX_COLLATERAL, deployer, borrower); // all of it, one go
    expect(stxBalance(STATE)).toStrictEqual(0n);
  });

  it("a collateral cap rate-limits STX withdrawals once set", () => {
    const cap = simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-collateral-cap",
      [Cl.contractPrincipal(deployer, STX), Cl.uint(10_000_000)], // 10% of 1e8
      deployer
    );
    expect(cap.result).toBeOk(Cl.bool(true));

    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    // decay window is 10800s at 5s/block, so the bucket settles to the 10% max
    simnet.mineEmptyBlocks(2500);

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
    expect(tooBig.result).toBeErr(Cl.uint(120004)); // CAP-EXCEEDED

    // inside the bucket it goes through, in native STX
    const before = stxBalance(borrower);
    remove_collateral(STX, 5 * ONE_STX, deployer, borrower);
    expect(stxBalance(borrower)).toStrictEqual(before + BigInt(5 * ONE_STX));
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
    expect((rec.result as any).value.value["amount"]).toStrictEqual(
      Cl.uint(20 * ONE_STX)
    );
    expect(stxBalance(STATE)).toStrictEqual(BigInt(20 * ONE_STX));

    // one collateral entry, not two
    const pos = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower)],
      deployer
    );
    expect((pos.result as any).value.value["collaterals"].value).toHaveLength(1);
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

    expect(amountFor(borrower)).toStrictEqual(Cl.uint(30 * ONE_STX));
    expect(amountFor(depositor)).toStrictEqual(Cl.uint(70 * ONE_STX));
    // state-v1's native balance is the pooled total
    expect(stxBalance(STATE)).toStrictEqual(BigInt(100 * ONE_STX));
  });

  it("allows a partial removal that stays inside max LTV", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);
    add_collateral(STX, STX_COLLATERAL, deployer, borrower);
    borrow(BORROW, borrower);

    // $200 collateral against $100 debt at 60% max LTV leaves room for ~16 STX
    const before = stxBalance(borrower);
    remove_collateral(STX, 10 * ONE_STX, deployer, borrower);
    expect(stxBalance(borrower)).toStrictEqual(before + BigInt(10 * ONE_STX));
    expect(stxBalance(STATE)).toStrictEqual(
      BigInt(STX_COLLATERAL - 10 * ONE_STX)
    );
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
    expect(collaterals).toHaveLength(2);

    // borrowing draws on both, priced through their own decimals
    borrow(BORROW, borrower);
    const usdc = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower)],
      borrower
    );
    expect((usdc.result as any).value.value).toStrictEqual(BigInt(BORROW));

    // and the STX leg is still redeemable as native STX
    expect(stxBalance(STATE)).toStrictEqual(BigInt(STX_COLLATERAL));
  });
});
