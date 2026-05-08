import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType } from "@stacks/transactions";
import {
  add_collateral,
  deposit,
  initialize_governance,
  initialize_ir,
  initialize_staking_reward,
  mint_token,
  mint_token_to_contract,
  remove_collateral,
  set_allowed_contracts,
  set_asset_cap,
  state_set_governance_contract,
  update_supported_collateral,
  update_supported_collateral_governance,
} from "./utils";
import {
  init_pyth,
  set_initial_price,
  set_price,
  set_pyth_time_delta,
} from "./pyth";
import { increaseLpTokensOfStakingContract } from "./staking.test";

const accounts = simnet.getAccounts();
const governance_account = accounts.get("wallet_1")!;
const guardian_account = accounts.get("wallet_2")!;
const deployer = accounts.get("deployer")!;

function execute_proposal(response: any) {
  const proposal_id = response.result.value.buffer;
  simnet.mineEmptyBlocks(21600);
  const res = simnet.callPublicFn(
    "governance-v1",
    "execute",
    [Cl.buffer(proposal_id)],
    governance_account
  );
  expect(res.result).toBeOk(Cl.bool(true));
}

function execute_proposal_failed(response: any, error: any) {
  const proposal_id = response.result.value.buffer;
  simnet.mineEmptyBlocks(21600);
  const res = simnet.callPublicFn(
    "governance-v1",
    "execute",
    [Cl.buffer(proposal_id)],
    governance_account
  );
  expect(res.result).toBeErr(Cl.uint(error));
}

describe("governance tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    await set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n); // 100k USDC
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    initialize_governance(governance_account, guardian_account, deployer);
  });

  it("should successfully update governance principal", async () => {
    let governance = simnet.callReadOnlyFn(
      "state-v1",
      "get-governance",
      [],
      deployer
    );
    expect(governance.result).toStrictEqual(Cl.principal(deployer));

    const governance_contract = Cl.contractPrincipal(deployer, "governance-v1");

    // make "governance-v1" the new governance
    state_set_governance_contract(deployer);

    governance = simnet.callReadOnlyFn(
      "state-v1",
      "get-governance",
      [],
      deployer
    );
    expect(governance.result).toStrictEqual(governance_contract);

    // "deployer" is not the governance anymore
    const response = simnet.callPublicFn(
      "state-v1",
      "update-governance",
      [Cl.principal(governance_account)],
      deployer
    );
    expect(response.result).toBeErr(Cl.uint(100));
  });

  it("should fail adding a collateral if not governance", async () => {
    const response = simnet.callPublicFn(
      "state-v1",
      "update-collateral-settings",
      [
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(1),
        Cl.uint(1),
        Cl.uint(1),
        Cl.uint(1),
      ],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(100));
  });

  it("should fail adding and removing a collateral if action is disabled", async () => {
    state_set_governance_contract(deployer);
    update_supported_collateral_governance(
      "mock-btc",
      70,
      80,
      10,
      deployer,
      governance_account
    );

    mint_token("mock-btc", 1000, governance_account);

    // disable liquidations first to disable add collateral
    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(8), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-liquidation-enabled",
      [],
      governance_account
    );
    expect(response.result).toStrictEqual(Cl.bool(false));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(4), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-add-collateral-enabled",
      [],
      governance_account
    );
    expect(response.result).toStrictEqual(Cl.bool(false));

    response = simnet.callPublicFn(
      "borrower-v1",
      "add-collateral",
      [Cl.contractPrincipal(deployer, "mock-btc"), Cl.uint(1), Cl.none()],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(102));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(4), Cl.bool(true), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    add_collateral("mock-btc", 1000, deployer, governance_account);

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(5), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [
        Cl.none(),
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(1),
        Cl.none(),
      ],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(102));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(5), Cl.bool(true), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    // refresh prices after mining blocks for governance proposals
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);

    remove_collateral("mock-btc", 1000, deployer, governance_account);
  });

  it("should be able to disable deposits", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(2), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    // Use amount >= MINIMUM_INITIAL_DEPOSIT (u1000) to bypass M-8 guard and test the deposit-disabled flag
    mint_token("mock-usdc", 1000, governance_account);
    response = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(1000), Cl.principal(governance_account)],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(102));

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-deposit-asset-enabled",
      [],
      deployer
    );
    expect(response.result).toStrictEqual(Cl.bool(false));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(2), Cl.bool(true), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(1000), Cl.principal(governance_account)],
      governance_account
    );

    response = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(1000), Cl.principal(governance_account)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-deposit-asset-enabled",
      [],
      deployer
    );
    expect(response.result).toStrictEqual(Cl.bool(true));
  });

  it("should be able to disable interest accrual", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(23), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-interest-accrual-enabled",
      [],
      deployer
    );
    expect(response.result).toStrictEqual(Cl.bool(false));
  });

  it("should reject out-of-range actions for market feature proposals (M-18)", async () => {
    state_set_governance_contract(deployer);

    // Action u9 (market pause) is no longer valid for set-market-feature
    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(9), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(40000)); // ERR-INVALID-ACTION

    // Action u22 (remove collateral) is no longer valid for set-market-feature
    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(22), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(40000)); // ERR-INVALID-ACTION

    // Action u8 (liquidation flag, upper bound) should still be accepted
    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(8), Cl.bool(true), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
  });

  it("should reject out-of-range actions for market state proposals (M-18)", async () => {
    state_set_governance_contract(deployer);

    // Action u11 (collateral settings) is no longer valid for set-market-state
    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-state",
      [Cl.uint(11), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(40000)); // ERR-INVALID-ACTION

    // Action u10 (market unpause, upper bound) should still be accepted
    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-state",
      [Cl.uint(10), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
  });

  it("should be able to disable liquidations until a given block", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(8), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-liquidation-enabled",
      [],
      deployer
    );
    expect(response.result).toStrictEqual(Cl.bool(false));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-state",
      [Cl.uint(10), Cl.uint(10), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-liquidation-enabled",
      [],
      deployer
    );
    expect(response.result).toStrictEqual(Cl.bool(false));

    simnet.mineEmptyBlocks(10);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-liquidation-enabled",
      [],
      deployer
    );
    expect(response.result).toStrictEqual(Cl.bool(true));
  });

  it("should be able to update collateral settings", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-collateral-settings",
      [
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(90000000),
        Cl.uint(95000000),
        Cl.uint(5000000),
        Cl.uint(10),
      ],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "get-collateral",
      [Cl.contractPrincipal(deployer, "mock-btc")],
      governance_account
    );
    expect(response.result.value.data["max-ltv"]).toEqual(Cl.uint(90000000));
  });

  it("update collateral settings should fail with incorrect values", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-collateral-settings",
      [
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(90000000),
        Cl.uint(97000000),
        Cl.uint(5000000),
        Cl.uint(10),
      ],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    execute_proposal_failed(response, 104); // invalid params
  });

  it("should be able to disable withdrawals", async () => {
    state_set_governance_contract(deployer);

    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(1000), Cl.principal(governance_account)],
      governance_account
    );
    simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(1000), Cl.principal(governance_account)],
      governance_account
    );

    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(3), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(1000), Cl.principal(governance_account)],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(102));

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-withdraw-asset-enabled",
      [],
      deployer
    );
    expect(response.result).toStrictEqual(Cl.bool(false));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(3), Cl.bool(true), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(1000), Cl.principal(governance_account)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-withdraw-asset-enabled",
      [],
      deployer
    );
    expect(response.result).toStrictEqual(Cl.bool(true));
  });

  it("should be able to deposit and withdraw from protocol reserve", () => {
    state_set_governance_contract(deployer);
    const governance_contract = Cl.contractPrincipal(deployer, "governance-v1");

    mint_token_to_contract("mock-usdc", 1000, governance_contract, deployer);
    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-for-reserve-balance",
      [Cl.uint(12), Cl.uint(1000), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    let balance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      deployer
    );
    expect(balance.result.value.value).toBe(1000n);

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-for-reserve-balance",
      [Cl.uint(13), Cl.uint(1000), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    balance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      deployer
    );
    expect(balance.result.value.value).toBe(0n);

    balance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [governance_contract],
      deployer
    );
    expect(balance.result.value.value).toBe(1000n);

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-for-reserve-balance",
      [Cl.uint(13), Cl.uint(1000), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal_failed(response, 105);
    // 600 = ERR-INSUFFICIENT-BALANCE

    balance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(deployer)],
      deployer
    );
    expect(balance.result.value.value).toBe(0n);

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-transfer-funds",
      [Cl.principal(deployer), Cl.uint(1000), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    balance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(deployer)],
      deployer
    );
    expect(balance.result.value.value).toBe(1000n);

    balance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [governance_contract],
      deployer
    );
    expect(balance.result.value.value).toBe(0n);
  });

  it("should be able to freeze upgrades", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "state-v1",
      "are-upgrades-enabled",
      [],
      governance_account
    );
    expect(response.result).toBeBool(true);

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-freeze-upgrades",
      [Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "are-upgrades-enabled",
      [],
      governance_account
    );
    expect(response.result).toBeBool(false);
  });

  it("should be to reconcile staking balance", async () => {
    state_set_governance_contract(deployer);
    // mint lp tokens to staking contract to increase the share price
    increaseLpTokensOfStakingContract(1000);

    let currentStakedLp = simnet.callReadOnlyFn(
      "staking-v1",
      "get-active-staked-lp-tokens",
      [],
      deployer
    );
    expect(currentStakedLp.result).toEqual(Cl.uint(0));

    // reconcile staked token balance
    const response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-reconcile-staking-lp-balance",
      [Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    currentStakedLp = simnet.callReadOnlyFn(
      "staking-v1",
      "get-active-staked-lp-tokens",
      [],
      deployer
    );
    expect(currentStakedLp.result).toEqual(Cl.uint(1000));
  });

  it("guardian can pause market and governance can unpause it", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "state-v1",
      "is-repay-enabled",
      [],
      governance_account
    );
    expect(response.result).toBeBool(true);

    response = simnet.callPublicFn(
      "governance-v1",
      "guardian-pause-market",
      [],
      guardian_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-repay-enabled",
      [],
      governance_account
    );
    expect(response.result).toBeBool(false);

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-state",
      [Cl.uint(10), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-repay-enabled",
      [],
      governance_account
    );
    expect(response.result).toBeBool(true);
  });

  it("governace can pause market and governance can unpause it", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "state-v1",
      "is-repay-enabled",
      [],
      governance_account
    );
    expect(response.result).toBeBool(true);

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-state",
      [Cl.uint(9), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-repay-enabled",
      [],
      governance_account
    );
    expect(response.result).toBeBool(false);

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-state",
      [Cl.uint(10), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-repay-enabled",
      [],
      governance_account
    );
    expect(response.result).toBeBool(true);
  });

  it("guardian can be upgraded", async () => {
    state_set_governance_contract(deployer);
    const new_guardian_account = accounts.get("wallet_3")!;

    let response = simnet.callReadOnlyFn(
      "governance-v1",
      "is-guardian",
      [Cl.principal(new_guardian_account)],
      deployer
    );
    expect(response.result).toBeErr(Cl.uint(40001));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-guardians",
      [Cl.uint(16), Cl.principal(new_guardian_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "governance-v1",
      "is-guardian",
      [Cl.principal(new_guardian_account)],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));
  });

  it("interest rate params can be upgraded", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "get-ir-params",
      [],
      deployer
    );
    expect(response.result.data["base-ir"]).toEqual(Cl.uint(300000000000));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-interest-params",
      [
        Cl.uint(750000000000), // 0.75
        Cl.uint(1500000000000), // 1.5
        Cl.uint(700000000000), // 0.7
        Cl.uint(500000000000), // 50%
        Cl.uint(10),
      ],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "get-ir-params",
      [],
      deployer
    );
    expect(response.result.data["base-ir"]).toEqual(Cl.uint(500000000000));
  });

  it("staking reward rate params can be upgraded", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "staking-reward-v1",
      "get-reward-params",
      [],
      deployer
    );
    expect(response.result.data["base-reward"]).toEqual(Cl.uint(30000000n));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-reward-params",
      [
        Cl.int(-90000000), // -0.9
        Cl.int(-120000000), // -1.2
        Cl.uint(50000000), // 0.5
        Cl.uint(15000000), // 15%
        Cl.uint(10),
      ],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "staking-reward-v1",
      "get-reward-params",
      [],
      deployer
    );
    expect(response.result.data["base-reward"]).toEqual(Cl.uint(15000000));
  });

  it("staking reward window can be upgraded", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "staking-v1",
      "get-withdrawal-finalization-period",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(100));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-finalization-period",
      [Cl.uint(5000), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "staking-v1",
      "get-withdrawal-finalization-period",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(5000));
  });

  it("governance can update pyth price feeds", async () => {
    state_set_governance_contract(deployer);

    const priceIdentifier = Cl.bufferFromHex(
      "b0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd"
    );
    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-pyth-feed",
      [
        Cl.contractPrincipal(deployer, "mock-usdc"),
        priceIdentifier,
        Cl.uint(100),
        Cl.uint(10),
      ],
      governance_account
    );
    // M-02: proposal-id hash now includes the `token` parameter, so the
    // expected hash is the keccak256 of the consensus buffer including
    // the mock-usdc principal.
    expect(response.result).toBeOk(
      Cl.bufferFromHex(
        "8a12529c357ba3d294fd399cb799125badb2b1864e37c9aab31a6bd48f280f14"
      )
    );
  });

  // M-02 regression: ACTION_UPDATE_PYTH_TOKEN_FEED was missing from the
  // time-locked map, so a >= threshold of compromised governance signers
  // could swap a collateral token's oracle feed in the same block as the
  // proposal threshold was met -- no community detection window. Plus the
  // proposal-id hash didn't include the `token`, so signers couldn't
  // cryptographically verify which token's feed they were approving.
  it("M-02 timelock: pyth feed update cannot execute in the same block", async () => {
    state_set_governance_contract(deployer);

    const priceIdentifier = Cl.bufferFromHex(
      "b0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd"
    );
    const usdcPrincipal = Cl.contractPrincipal(deployer, "mock-usdc");

    // Snapshot the pre-update price-feed entry to verify behavioral change.
    const feedBefore = simnet.getMapEntry(
      "pyth-adapter-v1",
      "price-feeds",
      usdcPrincipal
    );

    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-pyth-feed",
      [usdcPrincipal, priceIdentifier, Cl.uint(100), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    const proposal_id = response.result.value.buffer;

    // Immediate execute attempt must fail with ERR-PROPOSAL-TIME-LOCKED.
    let exec = simnet.callPublicFn(
      "governance-v1",
      "execute",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(exec.result).toBeErr(Cl.uint(40017)); // ERR-PROPOSAL-TIME-LOCKED

    // After the time-lock period, execution succeeds AND the feed actually
    // changes in pyth-adapter-v1's price-feeds map. Without this assertion
    // a regression that auto-executes the proposal but never reaches
    // pyth-adapter-v1 would still pass the (ok bool) check.
    simnet.mineEmptyBlocks(21600);
    exec = simnet.callPublicFn(
      "governance-v1",
      "execute",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(exec.result).toBeOk(Cl.bool(true));

    const feedAfter = simnet.getMapEntry(
      "pyth-adapter-v1",
      "price-feeds",
      usdcPrincipal
    );
    expect(feedAfter).not.toEqual(feedBefore);
  });

  it("M-02 timelock (auditor-missed): pyth time-delta update cannot execute in the same block", async () => {
    // ACTION_UPDATE_TIME_DELTA was missing from the time-locked map alongside
    // the M-02 feed-update finding. Same threat model: a compromised governance
    // multisig could extend the staleness window in one block, making
    // manipulated stale prices appear fresh. Same fix shape (one map-set
    // entry); guarded here with a parallel timelock test.
    state_set_governance_contract(deployer);

    // Use a delta above the minimum (read at runtime to avoid hardcoding).
    const minDelta = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "get-pyth-minimum-time-delta",
      [],
      deployer
    );
    const newDelta = (minDelta.result.value as bigint) + 1000n;

    const response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-pyth-time-delta",
      [Cl.uint(10), Cl.uint(newDelta)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    const proposal_id = response.result.value.buffer;

    let exec = simnet.callPublicFn(
      "governance-v1",
      "execute",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(exec.result).toBeErr(Cl.uint(40017)); // ERR-PROPOSAL-TIME-LOCKED

    simnet.mineEmptyBlocks(21600);
    exec = simnet.callPublicFn(
      "governance-v1",
      "execute",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(exec.result).toBeOk(Cl.bool(true));

    const deltaAfter = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "get-pyth-time-delta",
      [],
      deployer
    );
    expect(deltaAfter.result.value).toBe(newDelta);
  });

  it("M-02 hash-includes-token: distinct tokens with same feed produce distinct proposal-ids", async () => {
    state_set_governance_contract(deployer);

    const sameFeed = Cl.bufferFromHex(
      "b0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd"
    );
    const sameMaxConfidence = Cl.uint(100);
    const sameExpiresIn = Cl.uint(10);

    // Proposal A: token = mock-usdc.
    const respA = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-pyth-feed",
      [
        Cl.contractPrincipal(deployer, "mock-usdc"),
        sameFeed,
        sameMaxConfidence,
        sameExpiresIn,
      ],
      governance_account
    );
    expect(respA.result.type).toBe(ClarityType.ResponseOk);
    const idA = respA.result.value.buffer;

    // Proposal B: same feed + max-confidence-ratio + expires-in, but a
    // different token. Pre-fix this collided on the same proposal-id and
    // the second proposal silently overwrote the first's stored feed
    // metadata in the update-pyth-feed map. Post-fix the hash differs.
    const respB = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-pyth-feed",
      [
        Cl.contractPrincipal(deployer, "mock-btc"),
        sameFeed,
        sameMaxConfidence,
        sameExpiresIn,
      ],
      governance_account
    );
    expect(respB.result.type).toBe(ClarityType.ResponseOk);
    const idB = respB.result.value.buffer;

    expect(Buffer.from(idA).toString("hex")).not.toEqual(
      Buffer.from(idB).toString("hex")
    );
  });

  it("governance multisigs can be upgraded", async () => {
    const new_governance_account = accounts.get("wallet_3")!;

    let response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeErr(Cl.uint(50000));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(1));

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(1), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id = response.result.value.buffer;

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "approve",
      [Cl.buffer(proposal_id)],
      new_governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeErr(Cl.uint(50000));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(1));
  });

  it("governance multisigs can become zero", async () => {
    let response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(1));

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(1), Cl.principal(governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(50007));
  });

  it("governance multisigs cannot add exisiting members or remove non existing members", async () => {
    let response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(50008));

    const new_governance_account = accounts.get("wallet_3")!;
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(1), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(50009));
  });

  it("two parallel add multisigs with same account should not succeed", async () => {
    const new_governance_account = accounts.get("wallet_3")!;

    let response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    const new_governance_account_1 = accounts.get("wallet_4")!;

    // create proposal 1
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account_1), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id_1 = response.result.value.buffer;

    // create proposal 2
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account_1), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id_2 = response.result.value.buffer;

    // approve and execute proposal 2
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "approve",
      [Cl.buffer(proposal_id_2)],
      new_governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    // approve and execute proposal 1 should fail since same account cannot be added again
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "approve",
      [Cl.buffer(proposal_id_1)],
      new_governance_account
    );
    expect(response.result).toBeErr(Cl.uint(50008));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(3));
  });

  it("two parallel remove multisigs with same account should not succeed", async () => {
    const new_governance_account = accounts.get("wallet_3")!;

    let response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    // create proposal 1
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(1), Cl.principal(new_governance_account), Cl.uint(10)],
      new_governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id_1 = response.result.value.buffer;

    // create proposal 2
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(1), Cl.principal(new_governance_account), Cl.uint(10)],
      new_governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id_2 = response.result.value.buffer;

    // approve and execute proposal 2
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "approve",
      [Cl.buffer(proposal_id_2)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    // approve and execute proposal 1 should fail since same account cannot be removed again
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "approve",
      [Cl.buffer(proposal_id_1)],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(50009));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(1));
  });

  it("multisig proposal can be denied", async () => {
    const new_governance_account = accounts.get("wallet_3")!;

    let response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    const new_governance_account_1 = accounts.get("wallet_4")!;

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account_1), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id = response.result.value.buffer;

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "approve",
      [Cl.buffer(proposal_id)],
      new_governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(3));

    // create proposal to remove multisig
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(1), Cl.principal(governance_account), Cl.uint(10)],
      new_governance_account_1
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    proposal_id = response.result.value.buffer;

    // rest of multisigs denies and closes the proposal
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "deny",
      [Cl.buffer(proposal_id)],
      new_governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "deny",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(3));

    // proposal should be closed
    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["completed"]).toEqual(Cl.bool(true));
  });

  it("protocol reserve percentage can be upgraded", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "state-v1",
      "get-protocol-reserve-percentage",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(0));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-protocol-reserve-percentage",
      [Cl.uint(100000000), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "get-protocol-reserve-percentage",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(100000000));
  });

  it("asset cap can be updated", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "state-v1",
      "get-asset-cap",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(10000000000000n));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-asset-cap",
      [Cl.uint(100000000000000n), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn("state-v1", "get-asset-cap", [], deployer);
    expect(response.result).toEqual(Cl.uint(100000000000000n));
  });

  it("protocol reserve percentage cannot be more than 100%", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "state-v1",
      "get-protocol-reserve-percentage",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(0));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-protocol-reserve-percentage",
      [Cl.uint(100000001), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal_failed(response, 111);
  });

  it("staking can be enabled/disabled by governance", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "state-v1",
      "is-staking-enabled",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.bool(true));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-staking-flag",
      [Cl.uint(100000001), Cl.bool(false)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-staking-enabled",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.bool(false));
  });

  it("update pyth time delta by governance", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "get-pyth-time-delta",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(7200));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-pyth-time-delta",
      [Cl.uint(100000001), Cl.uint(450)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    // M-02: ACTION_UPDATE_TIME_DELTA is now time-locked, so the proposal
    // doesn't auto-execute on initiation. Mine the timelock period and
    // execute explicitly.
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "get-pyth-time-delta",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(450));
  });

  it("market governance proposals can be denied", async () => {
    state_set_governance_contract(deployer);

    const new_governance_account = accounts.get("wallet_3")!;

    let response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    const new_governance_account_1 = accounts.get("wallet_4")!;
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account_1), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id = response.result.value.buffer;

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "approve",
      [Cl.buffer(proposal_id)],
      new_governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(3));

    response = simnet.callReadOnlyFn("state-v1", "get-asset-cap", [], deployer);
    expect(response.result).toEqual(Cl.uint(10000000000000n));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-asset-cap",
      [Cl.uint(10n), Cl.uint(10)],
      new_governance_account_1
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    proposal_id = response.result.value.buffer;

    response = simnet.callPublicFn(
      "governance-v1",
      "deny",
      [Cl.buffer(proposal_id)],
      new_governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callPublicFn(
      "governance-v1",
      "deny",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    // proposal should be closed
    response = simnet.callReadOnlyFn(
      "governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["closed"]).toEqual(Cl.bool(true));

    response = simnet.callReadOnlyFn("state-v1", "get-asset-cap", [], deployer);
    expect(response.result).toEqual(Cl.uint(10000000000000n));
  });

  it("market governance proposals can be closed when everyone voted and no threshold is met", async () => {
    state_set_governance_contract(deployer);

    const new_governance_account = accounts.get("wallet_3")!;

    let response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    response = simnet.callReadOnlyFn("state-v1", "get-asset-cap", [], deployer);
    expect(response.result).toEqual(Cl.uint(10000000000000n));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-asset-cap",
      [Cl.uint(10n), Cl.uint(10)],
      new_governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id = response.result.value.buffer;

    response = simnet.callPublicFn(
      "governance-v1",
      "deny",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    // proposal should be not closed
    response = simnet.callReadOnlyFn(
      "governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["closed"]).toEqual(Cl.bool(false));

    // close the proposal since of there 50% threshold met for both approval and denial and everyone voted
    response = simnet.callPublicFn(
      "governance-v1",
      "close",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    // proposal should be closed
    response = simnet.callReadOnlyFn(
      "governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["closed"]).toEqual(Cl.bool(true));

    response = simnet.callReadOnlyFn("state-v1", "get-asset-cap", [], deployer);
    expect(response.result).toEqual(Cl.uint(10000000000000n));
  });

  it("market governance proposals can be expired and closed", async () => {
    state_set_governance_contract(deployer);

    const new_governance_account = accounts.get("wallet_3")!;

    let response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    response = simnet.callReadOnlyFn("state-v1", "get-asset-cap", [], deployer);
    expect(response.result).toEqual(Cl.uint(10000000000000n));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-asset-cap",
      [Cl.uint(10n), Cl.uint(10)],
      new_governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id = response.result.value.buffer;

    simnet.mineEmptyBlocks(15);

    response = simnet.callPublicFn(
      "governance-v1",
      "deny",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(response.result).toBeErr(Cl.uint(40013)); // proposal expired

    // proposal should be not closed
    response = simnet.callReadOnlyFn(
      "governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["closed"]).toEqual(Cl.bool(false));

    // close the proposal since its expired even if voting is incomplete
    response = simnet.callPublicFn(
      "governance-v1",
      "close",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    // proposal should be closed
    response = simnet.callReadOnlyFn(
      "governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["closed"]).toEqual(Cl.bool(true));

    response = simnet.callReadOnlyFn("state-v1", "get-asset-cap", [], deployer);
    expect(response.result).toEqual(Cl.uint(10000000000000n));
  });

  it("multisig proposal can be closed", async () => {
    const new_governance_account = accounts.get("wallet_3")!;

    let response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    const new_governance_account_1 = accounts.get("wallet_4")!;

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account_1), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id = response.result.value.buffer;

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "deny",
      [Cl.buffer(proposal_id)],
      new_governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    // proposal should be not closed
    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["completed"]).toEqual(Cl.bool(false));

    // close the proposal since of there 50% threshold met for both approval and denial and everyone voted
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "close",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    // proposal should be closed
    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["completed"]).toEqual(Cl.bool(true));
  });

  it("multisig proposal can be expired and closed", async () => {
    const new_governance_account = accounts.get("wallet_3")!;

    let response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "is-governance-member",
      [Cl.principal(new_governance_account)],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    const new_governance_account_1 = accounts.get("wallet_4")!;

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "initiate-proposal-to-update-governance-multisig",
      [Cl.uint(0), Cl.principal(new_governance_account_1), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id = response.result.value.buffer;

    // mine blocks so that proposal is expired
    simnet.mineEmptyBlocks(15);

    response = simnet.callPublicFn(
      "meta-governance-v1",
      "deny",
      [Cl.buffer(proposal_id)],
      new_governance_account
    );
    expect(response.result).toBeErr(Cl.uint(50015)); // proposal expired

    // proposal should be not closed
    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["completed"]).toEqual(Cl.bool(false));

    // close proposal since its expired even if the voting is incomplete
    response = simnet.callPublicFn(
      "meta-governance-v1",
      "close",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "governance-multisig-count",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(2));

    // proposal should be closed
    response = simnet.callReadOnlyFn(
      "meta-governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["completed"]).toEqual(Cl.bool(true));
  });

  it("market timelocked proposal can be expired and closed", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "state-v1",
      "is-repay-enabled",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.bool(true));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(7n), Cl.bool(false), Cl.uint(10), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    let proposal_id = response.result.value.buffer;

    // proposal should be not closed
    response = simnet.callReadOnlyFn(
      "governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["closed"]).toEqual(Cl.bool(false));
    expect(response.result.value.data["executed"]).toEqual(Cl.bool(false));

    let block_number = simnet.blockHeight;
    let execute_at = block_number + 21600;
    let expires_at = execute_at + 151200;
    expect(response.result.value.data["execute-at"]).toEqual(
      Cl.some(Cl.uint(execute_at))
    );
    expect(response.result.value.data["expires-at"]).toEqual(
      Cl.uint(expires_at)
    );

    simnet.mineEmptyBlocks(expires_at);

    // cannot execute expired proposal
    const res = simnet.callPublicFn(
      "governance-v1",
      "execute",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(res.result).toBeErr(Cl.uint(40013)); // ERR-PROPOSAL-EXPIRED

    // close the proposal since its expired
    response = simnet.callPublicFn(
      "governance-v1",
      "close",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(response.result).toBeOk(Cl.bool(true));

    // proposal should be closed
    response = simnet.callReadOnlyFn(
      "governance-v1",
      "get-proposal",
      [Cl.buffer(proposal_id)],
      deployer
    );
    expect(response.result.value.data["closed"]).toEqual(Cl.bool(true));
    expect(response.result.value.data["executed"]).toEqual(Cl.bool(false));

    response = simnet.callReadOnlyFn(
      "state-v1",
      "is-repay-enabled",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.bool(true));
  });

  it("governance can remove collateral", async () => {
    const depositor = accounts.get("wallet_4")!;
    const borrower1 = accounts.get("wallet_2")!;
    await set_initial_price("mock-btc", 1n, deployer);

    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);

    let borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(10000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    // User should have 100 assets after borrow
    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(10000000000n);

    state_set_governance_contract(deployer);
    let response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-remove-collateral",
      [Cl.contractPrincipal(deployer, "mock-btc"), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    // repay should be successful
    mint_token("mock-usdc", 5000000000, borrower1);
    let repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(51000000000), Cl.none()],
      borrower1
    );
    expect(repay.result).toBeOk(Cl.bool(true));

    // user should have zero debt shares
    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(0n);

    // remove collateral should fail
    response = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [
        Cl.none(),
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(10000000000),
        Cl.none(),
      ],
      borrower1
    );
    expect(response.result).toBeErr(Cl.uint(108)); // ERR-COLLATERAL-NOT-SUPPORTED

    // governance adds support for collateral
    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-collateral-settings",
      [
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(70000000),
        Cl.uint(80000000),
        Cl.uint(10000000),
        Cl.uint(10),
      ],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    await set_price("mock-btc", 1n, deployer);
    await set_price("mock-usdc", 1n, deployer);

    // remove collateral should work
    response = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [
        Cl.none(),
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(20000000000),
        Cl.none(),
      ],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));
  });

  it("flash loan fee can be updated", async () => {
    state_set_governance_contract(deployer);

    let response = simnet.callReadOnlyFn(
      "flash-loan-v1",
      "get-fee",
      [],
      deployer
    );
    expect(response.result).toEqual(Cl.uint(10000n));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-flash-loan-fee",
      [Cl.uint(50000n), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn("flash-loan-v1", "get-fee", [], deployer);
    expect(response.result).toEqual(Cl.uint(50000n));
  });

  it("flash loan contract can be updated", async () => {
    state_set_governance_contract(deployer);

    const contract = Cl.contractPrincipal(deployer, "state-v1");
    let response = simnet.callReadOnlyFn(
      "flash-loan-v1",
      "is-contract-allowed",
      [contract],
      deployer
    );
    expect(response.result).toEqual(Cl.bool(false));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-flash-loan-contract",
      [Cl.uint(36), contract, Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "flash-loan-v1",
      "is-contract-allowed",
      [contract],
      deployer
    );
    expect(response.result).toEqual(Cl.bool(true));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-flash-loan-contract",
      [Cl.uint(37), contract, Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "flash-loan-v1",
      "is-contract-allowed",
      [contract],
      deployer
    );
    expect(response.result).toEqual(Cl.bool(false));
  });

  it("flash loan allow any can be updated", async () => {
    state_set_governance_contract(deployer);

    const contract = Cl.contractPrincipal(deployer, "state-v1");
    let response = simnet.callReadOnlyFn(
      "flash-loan-v1",
      "is-contract-allowed",
      [contract],
      deployer
    );
    expect(response.result).toEqual(Cl.bool(false));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-allow-any-flash-loan",
      [Cl.bool(true), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "flash-loan-v1",
      "is-contract-allowed",
      [contract],
      deployer
    );
    expect(response.result).toEqual(Cl.bool(true));

    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-allow-any-flash-loan",
      [Cl.bool(false), Cl.uint(10)],
      governance_account
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    response = simnet.callReadOnlyFn(
      "flash-loan-v1",
      "is-contract-allowed",
      [contract],
      deployer
    );
    expect(response.result).toEqual(Cl.bool(false));
  });
});
