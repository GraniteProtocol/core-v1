import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  initialize_ir,
  set_allowed_contracts,
  set_asset_cap,
  deposit,
  initialize_staking_reward,
  initialize_lp,
  mint_token,
} from "./utils";
import { init_pyth, set_pyth_time_delta } from "./pyth";

const accounts = simnet.getAccounts();
const depositor1 = accounts.get("wallet_1")!;
const depositor2 = accounts.get("wallet_2")!;
const depositor3 = accounts.get("wallet_3")!;
const gifter = accounts.get("wallet_4")!;
const deployer = accounts.get("deployer")!;

describe("liquidity-provider tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n); // 100k USDC
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
  });

  it("should fail when depositing 0 assets", async () => {
    // Attempt to deposit 0 assets
    const deposit = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(0), Cl.principal(depositor1)],
      depositor1
    );
    // Post H-01: deposit() owns its zero-amount invariant locally via an
    // explicit ERR-INPUT-ZERO assert (defense-in-depth, doesn't delegate
    // to state-v1.transfer-from).
    expect(deposit.result).toBeErr(Cl.uint(10004)); // ERR-INPUT-ZERO

    // Attempt to withdraw 0 assets — symmetric ERR-INPUT-ZERO guard.
    const withdraw = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(0), Cl.principal(depositor1)],
      depositor1
    );
    expect(withdraw.result).toBeErr(Cl.uint(10004)); // ERR-INPUT-ZERO

    // Attempt to redeem 0 shares — symmetric ERR-INPUT-ZERO guard.
    const redeem = simnet.callPublicFn(
      "liquidity-provider-v1",
      "redeem",
      [Cl.uint(0), Cl.principal(depositor1)],
      depositor1
    );
    expect(redeem.result).toBeErr(Cl.uint(10004)); // ERR-INPUT-ZERO
  });

  it("should fail when depositing more than asset cap", async () => {
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(10000000000001), Cl.principal(depositor1)],
      depositor1
    );

    // Attempt to deposit max assets should succeed.
    // Cap is 10000000000000; H-01 dust burn already consumed 1000 of it during
    // initialize_lp, so the largest user deposit that fits is cap - dust.
    deposit(9999999999000, depositor1);

    // Attempt to another more than cap
    const depositRes = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(1), Cl.principal(depositor1)],
      depositor1
    );
    expect(depositRes.result).toBeErr(Cl.uint(116)); // ERR-ASSET-CAP
  });

  it("should handle deposits and withdrawals correctly with zero interest accrued", async () => {
    // Mint asset tokens for depositor1
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(2000), Cl.principal(depositor1)],
      depositor1
    );

    /* Deposit flow */
    const depositResult = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(1000), Cl.principal(depositor1)],
      depositor1
    );
    expect(depositResult.result).toBeOk(Cl.bool(true));

    // Assertions for balances after deposit
    const userBalancePostDeposit = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(userBalancePostDeposit.result.value.value).toBe(1000n);
    const userLpBalancePostDeposit = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    // User should have 1000 LP tokens after deposit
    expect(userLpBalancePostDeposit.result.value.value).toBe(1000n);

    /* Withdrawal flow */
    const withdrawalResult = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(1000), Cl.principal(depositor1)],
      depositor1
    );
    expect(withdrawalResult.result).toBeOk(Cl.bool(true));

    // Assertions for balances after withdrawal
    const userBalancePostWithdrawal = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(userBalancePostWithdrawal.result.value.value).toBe(2000n);
    const userLpBalancePostWithdrawal = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    // User should have 1 LP token after withdrawal
    expect(userLpBalancePostWithdrawal.result.value.value).toBe(0n);
  });

  it("should correctly handle deposits and withdrawals with multiple users", async () => {
    // Mint asset tokens for all depositors
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(1000), Cl.principal(depositor1)],
      depositor1
    );
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(2000), Cl.principal(depositor2)],
      depositor2
    );
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(3000), Cl.principal(depositor3)],
      depositor3
    );

    // Perform multiple deposits
    simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(1000), Cl.principal(depositor1)],
      depositor1
    );
    simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(2000), Cl.principal(depositor2)],
      depositor2
    );
    simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(3000), Cl.principal(depositor3)],
      depositor3
    );

    // Gift assets
    const interestAmount = Cl.uint(2000);
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [interestAmount, Cl.principal(gifter)],
      gifter
    );
    const giftResult = simnet.callPublicFn(
      "test-gifter",
      "gift",
      [interestAmount],
      gifter
    );
    expect(giftResult.result).toBeOk(Cl.bool(true));

    // Check token balances after deposits
    let assetBalanceAfterDeposit = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(assetBalanceAfterDeposit.result.value.value).toBe(0n);
    assetBalanceAfterDeposit = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor2)],
      depositor2
    );
    expect(assetBalanceAfterDeposit.result.value.value).toBe(0n);
    assetBalanceAfterDeposit = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor3)],
      depositor3
    );
    expect(assetBalanceAfterDeposit.result.value.value).toBe(0n);

    // Check LP token balances after deposit
    let lpBalanceAfterDeposit = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(lpBalanceAfterDeposit.result.value.value).toBe(1000n);
    lpBalanceAfterDeposit = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor2)],
      depositor2
    );
    expect(lpBalanceAfterDeposit.result.value.value).toBe(2000n);
    lpBalanceAfterDeposit = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor3)],
      depositor3
    );
    expect(lpBalanceAfterDeposit.result.value.value).toBe(3000n);

    let redeemResult = simnet.callPublicFn(
      "liquidity-provider-v1",
      "redeem",
      [Cl.uint(1000), Cl.principal(depositor1)],
      depositor1
    );
    expect(redeemResult.result).toBeOk(Cl.bool(true));
    redeemResult = simnet.callPublicFn(
      "liquidity-provider-v1",
      "redeem",
      [Cl.uint(2000), Cl.principal(depositor2)],
      depositor2
    );
    expect(redeemResult.result).toBeOk(Cl.bool(true));
    redeemResult = simnet.callPublicFn(
      "liquidity-provider-v1",
      "redeem",
      [Cl.uint(3000), Cl.principal(depositor3)],
      depositor3
    );
    expect(redeemResult.result).toBeOk(Cl.bool(true));

    // Check redeeming shares brings profits to LPs.
    // Post H-01: pool starts with 1000 burn shares / 1000 burn assets. After
    // user deposits (1000 + 2000 + 3000 = 6000 user shares / 6000 user assets)
    // and the 2000 gift, the pool sits at 9000 assets / 7000 shares — share
    // price 9/7. Each user's redemption reflects that diluted price; the
    // 1000-asset / 1000-share burn floor remains permanently locked.
    let assetBalanceAfterWithdrawal = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(assetBalanceAfterWithdrawal.result.value.value).toBe(1285n);
    assetBalanceAfterWithdrawal = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor2)],
      depositor2
    );
    expect(assetBalanceAfterWithdrawal.result.value.value).toBe(2571n);
    assetBalanceAfterWithdrawal = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor3)],
      depositor3
    );
    expect(assetBalanceAfterWithdrawal.result.value.value).toBe(3858n);
  });
});

// H-01: LP inflation safeguard via burn-share floor at initialize()
describe("H-01 initialize burn-floor", () => {
  // Burn principal — c32check encoding of (testnet version byte 0x1a, 20-byte
  // zero hash). Must match NULL_ADDRESS in liquidity-provider-v1.clar when
  // is-in-mainnet=false (simnet/devnet uses testnet version byte).
  const NULL_ADDRESS = "ST000000000000000000002AMW42H";

  describe("auth + idempotence (no init in beforeEach)", () => {
    beforeEach(async () => {
      init_pyth(deployer);
      set_pyth_time_delta(7200, deployer);
      set_allowed_contracts(deployer);
      set_asset_cap(deployer, 10000000000000n);
      initialize_ir(deployer);
      initialize_staking_reward(deployer);
      // intentionally NOT calling initialize_lp here
    });

    it("rejects deposit before initialize", async () => {
      simnet.callPublicFn(
        "mock-usdc",
        "mint",
        [Cl.uint(2000), Cl.principal(depositor1)],
        depositor1
      );
      const res = simnet.callPublicFn(
        "liquidity-provider-v1",
        "deposit",
        [Cl.uint(1000), Cl.principal(depositor1)],
        depositor1
      );
      expect(res.result).toBeErr(Cl.uint(10001)); // ERR-NOT-INITIALIZED
    });

    it("rejects withdraw before initialize", async () => {
      const res = simnet.callPublicFn(
        "liquidity-provider-v1",
        "withdraw",
        [Cl.uint(1000), Cl.principal(depositor1)],
        depositor1
      );
      expect(res.result).toBeErr(Cl.uint(10001)); // ERR-NOT-INITIALIZED
    });

    it("rejects redeem before initialize", async () => {
      const res = simnet.callPublicFn(
        "liquidity-provider-v1",
        "redeem",
        [Cl.uint(1000), Cl.principal(depositor1)],
        depositor1
      );
      expect(res.result).toBeErr(Cl.uint(10001)); // ERR-NOT-INITIALIZED
    });

    it("any caller can initialize; second call rejected", async () => {
      mint_token("mock-usdc", 1000, depositor1);
      const res = simnet.callPublicFn(
        "liquidity-provider-v1",
        "initialize",
        [],
        depositor1
      );
      expect(res.result).toBeOk(Cl.bool(true));
      const second = simnet.callPublicFn(
        "liquidity-provider-v1",
        "initialize",
        [],
        depositor1
      );
      expect(second.result).toBeErr(Cl.uint(10003));
    });

    it("rejects second initialize call", async () => {
      // First init succeeds (also mints + spends the burn dust).
      initialize_lp(deployer);

      // Second init must reject regardless of total-supply state.
      const res = simnet.callPublicFn(
        "liquidity-provider-v1",
        "initialize",
        [],
        deployer
      );
      expect(res.result).toBeErr(Cl.uint(10003)); // ERR-ALREADY-INITIALIZED
    });
  });

  describe("post-init invariants", () => {
    beforeEach(async () => {
      init_pyth(deployer);
      set_pyth_time_delta(7200, deployer);
      set_allowed_contracts(deployer);
      set_asset_cap(deployer, 10000000000000n);
      initialize_ir(deployer);
      initialize_staking_reward(deployer);
      initialize_lp(deployer);
    });

    it("locks MINIMUM_INITIAL_DEPOSIT shares to the burn principal", async () => {
      const burnBalance = simnet.callReadOnlyFn(
        "state-v1",
        "get-balance",
        [Cl.principal(NULL_ADDRESS)],
        deployer
      );
      expect(burnBalance.result.value.value).toBe(1000n);

      const totalSupply = simnet.callReadOnlyFn(
        "state-v1",
        "get-total-supply",
        [],
        deployer
      );
      expect(totalSupply.result.value.value).toBe(1000n);
    });

    it("inflation attack regression: redeem cannot collapse share supply below floor", async () => {
      // Auditor PoC reduced: depositor deposits, redeems everything they hold,
      // and total-supply must remain >= MINIMUM_INITIAL_DEPOSIT (1000) so the
      // pool never returns to a fresh-share manipulable state.
      simnet.callPublicFn(
        "mock-usdc",
        "mint",
        [Cl.uint(1000), Cl.principal(depositor1)],
        depositor1
      );
      deposit(1000, depositor1);

      // Total supply = 1000 (burn) + 1000 (depositor1) = 2000.
      let supply = simnet.callReadOnlyFn(
        "state-v1",
        "get-total-supply",
        [],
        deployer
      );
      expect(supply.result.value.value).toBe(2000n);

      // Depositor1 redeems all of their shares.
      const userShares = simnet.callReadOnlyFn(
        "state-v1",
        "get-balance",
        [Cl.principal(depositor1)],
        depositor1
      );
      const sharesHeld = userShares.result.value.value as bigint;

      const redeemRes = simnet.callPublicFn(
        "liquidity-provider-v1",
        "redeem",
        [Cl.uint(sharesHeld), Cl.principal(depositor1)],
        depositor1
      );
      expect(redeemRes.result).toBeOk(Cl.bool(true));

      // The burn floor must still hold on both axes — supply AND assets.
      // Asset-side check is the actual security property: a future bug that
      // drained pool assets while leaving share count intact would still
      // re-open the inflation vector.
      supply = simnet.callReadOnlyFn(
        "state-v1",
        "get-total-supply",
        [],
        deployer
      );
      expect(supply.result.value.value).toBe(1000n);

      const lpParams = simnet.callReadOnlyFn(
        "state-v1",
        "get-lp-params",
        [],
        deployer
      );
      expect(
        lpParams.result.data["total-assets"].value as bigint
      ).toBeGreaterThanOrEqual(1000n);

      // Burn principal still owns the floor shares.
      const burnBalance = simnet.callReadOnlyFn(
        "state-v1",
        "get-balance",
        [Cl.principal(NULL_ADDRESS)],
        deployer
      );
      expect(burnBalance.result.value.value).toBe(1000n);
    });

    it("accepts sub-MINIMUM deposits after initialize (M-8 floor retired)", async () => {
      // The pre-H-01 M-8 guard rejected first deposits below 1000. H-01
      // moved the floor to a one-shot burn at init, so user deposits of
      // any positive size are legal afterwards. Verify three boundary
      // sizes: 1, 999, 1000.
      simnet.callPublicFn(
        "mock-usdc",
        "mint",
        [Cl.uint(3000), Cl.principal(depositor1)],
        depositor1
      );

      for (const amount of [1, 999, 1000]) {
        const res = simnet.callPublicFn(
          "liquidity-provider-v1",
          "deposit",
          [Cl.uint(amount), Cl.principal(depositor1)],
          depositor1
        );
        expect(res.result).toBeOk(Cl.bool(true));
      }
    });
  });
});
