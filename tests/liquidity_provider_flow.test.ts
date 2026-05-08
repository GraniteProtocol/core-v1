import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  initialize_ir,
  set_allowed_contracts,
  mint_token,
  deposit_and_borrow,
  set_asset_cap,
  initialize_staking_reward,
  initialize_lp,
} from "./utils";
import { init_pyth, set_initial_price, set_pyth_time_delta } from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const depositor1 = accounts.get("wallet_1")!;
const borrower1 = accounts.get("wallet_2")!;

describe("LP User flow tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n); // 100k USDC
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);
    await set_initial_price("mock-eth", 1n, deployer);
  });

  it("Provide asset liquidity", async () => {
    deposit_and_borrow(1000, depositor1, 1000, 700, borrower1, deployer);

    // accrue interest
    simnet.mineEmptyBlocks(250);

    // repay insterest
    mint_token("mock-usdc", 100, borrower1);
    let repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(800), Cl.none()],
      borrower1
    );
    expect(repay.result).toBeOk(Cl.bool(true));

    // redeem lp tokens
    let lpTokens = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(lpTokens.result).toBeOk(Cl.uint(1000));

    const redeem = simnet.callPublicFn(
      "liquidity-provider-v1",
      "redeem",
      [Cl.uint(1000), Cl.principal(depositor1)],
      depositor1
    );
    expect(redeem.result).toBeOk(Cl.bool(true));

    // depositor should have 1000 + interest
    const depositorBalance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    // Post H-01: 1000-dust burn share dilutes interest distribution by ~half.
    expect(depositorBalance.result.value.value).toBe(1001n);
  });

  it("Provide asset liquidity, reserve drawdown", async () => {
    // H-01 burn dust adds 1000 USDC of permanent liquidity into the pool that
    // doesn't belong to any user, so the borrow side is bumped to 1700 (with
    // matching collateral) to bring state-v1's free-liquidity below depositor
    // share value and exercise the reserve-drawdown path.
    deposit_and_borrow(1000, depositor1, 2500, 1700, borrower1, deployer);

    // accrue interest
    simnet.mineEmptyBlocks(5);

    // reserve balance
    mint_token("mock-usdc", 500, deployer);
    let reserveBalance = simnet.callPublicFn(
      "state-v1",
      "deposit-to-reserve",
      [Cl.uint(500)],
      deployer
    );
    expect(reserveBalance.result).toBeOk(Cl.bool(true));
    reserveBalance = simnet.callReadOnlyFn(
      "state-v1",
      "get-reserve-balance",
      [],
      deployer
    );
    expect(reserveBalance.result.value).toBe(500n);

    // State-v1 USDC = 1000 (dust) + 1000 (deposit) - 1700 (borrow) + 500
    // (reserve) = 800. depositor1 holds 1000 LP shares; trying to withdraw
    // their full 1000 fails because free-liq is only 800.
    let withdraw = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(1000), Cl.principal(depositor1)],
      depositor1
    );
    expect(withdraw.result).toBeErr(Cl.uint(103)); // insufficent liquidity

    const freeLiquidity = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      deployer
    );
    expect(freeLiquidity.result.value.value).toBe(800n);

    // LP can withdraw up to free-liq (800 in asset terms), draining into
    // reserve territory. depositor1 holds 1000 shares; after interest the
    // share-price is slightly above 1, so withdrawing 800 assets burns
    // ~800 of those shares and the remaining shares stay in the pool.
    withdraw = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(800), Cl.principal(depositor1)],
      depositor1
    );
    expect(withdraw.result).toBeOk(Cl.bool(true));

    const depositorBalance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(depositorBalance.result.value.value).toBe(800n);

    reserveBalance = simnet.callReadOnlyFn(
      "state-v1",
      "get-reserve-balance",
      [],
      deployer
    );
    expect(reserveBalance.result.value).toBe(500n);
  });
});
