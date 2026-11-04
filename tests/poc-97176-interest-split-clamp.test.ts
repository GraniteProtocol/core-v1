// Immunefi 97176: the raw interest split parts were never bounded by the buckets they
// are subtracted from in state-v1, so a denominator squeezed by dust repayments made
// repay, liquidation and socialization underflow and revert.
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
const victim = accounts.get("wallet_1")!;
const attacker = accounts.get("wallet_2")!;
const liquidator = accounts.get("wallet_3")!;
const depositor = accounts.get("wallet_4")!;
const btc = contractPrincipalCV(deployer, "mock-btc");

const PROTOCOL_RESERVE_PERCENTAGE = 25_000_000n; // 25%

const openInterest = () => {
  const oi: any = simnet.callReadOnlyFn("state-v1", "get-open-interest", [], deployer).result;
  return {
    lp: oi.value["lp-open-interest"].value as bigint,
    staked: oi.value["staked-open-interest"].value as bigint,
    protocol: oi.value["protocol-open-interest"].value as bigint,
  };
};

const dustRepayments = (count: number) =>
  Array.from({ length: count }, () =>
    tx.callPublicFn("borrower-v1", "repay", [Cl.uint(1), Cl.some(Cl.principal(victim))], attacker)
  );

// Twelve one-unit repayments on the victim's behalf drive the split denominator below
// the victim's interest part; the attacker's borrow and the dust repayments share one block.
const squeezeDenominator = () => {
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
};

describe("Immunefi 97176: interest split is clamped to its buckets", () => {
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

  it("control: a full repayment succeeds without the dust repayments", async () => {
    mint_token("mock-btc", 20_000_000, victim);
    add_collateral("mock-btc", 20_000_000, deployer, victim);
    borrow(10_000_000, victim);
    simnet.mineEmptyBlocks(500);
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);
    mint_token("mock-usdc", 20_000_000, victim);

    const res = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(20_000_000), Cl.none()],
      victim
    );
    expect(res.result).toBeOk(Cl.bool(true));
  });

  it("leg 1: a full repayment does not underflow update-repay-state", async () => {
    mint_token("mock-btc", 20_000_000, victim);
    add_collateral("mock-btc", 20_000_000, deployer, victim);
    borrow(10_000_000, victim);

    simnet.mineEmptyBlocks(500);
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);
    mint_token("mock-usdc", 20_000_000, victim);

    squeezeDenominator();

    const res = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(20_000_000), Cl.none()],
      victim
    );
    expect(res.result).toBeOk(Cl.bool(true));
    // All three clamps bind: the repay consumes the lp interest above principal
    // (20,015,522 - 20,000,000 borrowed = 15,522) and the entire staked and protocol buckets.
    expect(openInterest()).toStrictEqual({ lp: 10_000_000n, staked: 0n, protocol: 0n });
  });

  it("leg 2: a full liquidation does not underflow update-liquidate-collateral-state", async () => {
    mint_token("mock-btc", 15_000_000, victim);
    add_collateral("mock-btc", 15_000_000, deployer, victim);
    borrow(10_000_000, victim);

    simnet.mineEmptyBlocks(500);
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);

    squeezeDenominator();

    await set_price_without_scaling("mock-btc", 73_542_794n, deployer);
    mint_token("mock-usdc", 20_000_000, liquidator);

    const res = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [Cl.buffer(build_price_update()), btc, Cl.principal(victim), Cl.uint(20_000_000), Cl.uint(0)],
      liquidator
    );
    expect(res.result).toBeOk(Cl.bool(true));
    // The liquidation split binds the same three clamps.
    expect(openInterest()).toStrictEqual({ lp: 10_000_000n, staked: 0n, protocol: 0n });
  });

  it("leg 3: bad-debt socialization does not underflow socialize-user-bad-debt", async () => {
    mint_token("mock-btc", 15_000_000, victim);
    add_collateral("mock-btc", 15_000_000, deployer, victim);
    borrow(10_000_000, victim);

    simnet.mineEmptyBlocks(500);
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);

    squeezeDenominator();

    await set_price_without_scaling("mock-btc", 10_000_000n, deployer);
    mint_token("mock-usdc", 20_000_000, liquidator);

    const res = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [Cl.buffer(build_price_update()), btc, Cl.principal(victim), Cl.uint(20_000_000), Cl.uint(0)],
      liquidator
    );
    expect(res.result).toBeOk(Cl.bool(true));
    // The liquidation and socialization splits together consume the same buckets.
    expect(openInterest()).toStrictEqual({ lp: 10_000_000n, staked: 0n, protocol: 0n });
  });
});
