import { Cl, ClarityType } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  init_pyth,
  set_initial_price,
  set_price,
  set_pyth_time_delta,
} from "../pyth";
import {
  add_collateral,
  deposit,
  initialize_governance,
  initialize_ir,
  initialize_staking_reward,
  mint_token,
  set_allowed_contracts,
  set_asset_cap,
  state_set_governance_contract,
  update_supported_collateral,
} from "../utils";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const depositor = accounts.get("wallet_1")!;
const borrower = accounts.get("wallet_2")!;

const ACTION_SET_LP_CAP = 30;
const ACTION_SET_DEBT_CAP = 31;
const ACTION_SET_COLLATERAL_CAP = 32;
const ACTION_SET_REFILL_TIME_WINDOW = 33;
const ACTION_SET_DECAY_TIME_WINDOW = 34;

const SCALING_FACTOR = 100000000;

function execute_proposal(response: any) {
  const proposal_id = response.result.value.buffer;
  simnet.mineEmptyBlocks(21600);
  const res = simnet.callPublicFn(
    "governance-v1",
    "execute",
    [Cl.buffer(proposal_id)],
    deployer
  );
  expect(res.result).toBeOk(Cl.bool(true));
}

describe("withdrawal caps tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(100000000, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 2n ** 128n - 1n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_governance(deployer, deployer, deployer);
    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    update_supported_collateral(
      "mock-eth",
      50000000,
      70000000,
      10000000,
      8,
      deployer
    );
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 10n, deployer);
    await set_initial_price("mock-eth", 1n, deployer);
    state_set_governance_contract(deployer);
  });

  it("public functions should be gated", () => {
    let res = simnet.callPublicFn(
      "withdrawal-caps-v1",
      "check-withdrawal-debt-cap",
      [Cl.uint(0)],
      deployer
    );
    expect(res.result).toBeErr(Cl.uint(120000)); // ERR-RESTRICTED

    res = simnet.callPublicFn(
      "withdrawal-caps-v1",
      "check-withdrawal-collateral-cap",
      [Cl.contractPrincipal(deployer, "mock-btc"), Cl.uint(0)],
      deployer
    );
    expect(res.result).toBeErr(Cl.uint(120000)); // ERR-RESTRICTED
  });

  it("lp cap should block withdrawing above the limit", () => {
    const res = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_LP_CAP),
        Cl.tuple({
          collateral: Cl.none(),
          factor: Cl.uint(0.8 * SCALING_FACTOR),
        }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(res.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(res);

    const lp_cap_factor = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-cap-factor",
      [],
      deployer
    ).result;
    expect(lp_cap_factor).toEqual(Cl.uint(0.8 * SCALING_FACTOR));

    let lp_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-bucket",
      [],
      deployer
    ).result;
    expect(lp_bucket).toBeUint(0);

    // Deposit 500 USDC
    let amount = 500_000_000_00;
    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);

    lp_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-bucket",
      [],
      deployer
    ).result;
    expect(lp_bucket).toBeUint(50000000000);

    // let the extra amount to decay to bring to max bucket
    simnet.mineEmptyBlocks(20);

    // Withdraw 410 USDC, it should be bloked
    let resp = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(410_000_000_00), Cl.principal(depositor)],
      depositor
    ).result;
    expect(resp).toBeErr(Cl.uint(120002));

    resp = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(150_000_000_00), Cl.principal(depositor)],
      depositor
    ).result;
    expect(resp).toBeOk(Cl.bool(true));
  });

  it("debt cap should allow & block borrowing & update itself correctly", async () => {
    let res = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_DEBT_CAP),
        Cl.tuple({
          collateral: Cl.none(),
          factor: Cl.uint(0.8 * SCALING_FACTOR),
        }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(res.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(res);

    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 10n, deployer);
    await set_price("mock-eth", 1n, deployer);

    // Deposit 500 USDC
    let amount = 500_000_000_00;
    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);

    let debt_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-debt-bucket",
      [],
      deployer
    ).result;
    expect(debt_bucket).toBeUint(0);

    // Add collateral
    mint_token("mock-btc", 800_000_000_0, borrower);
    add_collateral("mock-btc", 800_000_000_0, deployer, borrower);

    // Borrow 410 USDC. It should be bloked
    res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(410_000_000_00), Cl.none()],
      borrower
    );
    expect(res.result).toBeErr(Cl.uint(120003));

    // Borrow 150 USDC
    res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(150_000_000_00), Cl.none()],
      borrower
    );
    expect(res.result).toBeOk(Cl.bool(true));

    debt_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-debt-bucket",
      [],
      deployer
    ).result;
    expect(debt_bucket).toBeUint(25000000000n);

    // Borrow 200 USDC
    res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(200_000_000_00), Cl.none()],
      borrower
    );
    expect(res.result).toBeOk(Cl.bool(true));

    debt_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-debt-bucket",
      [],
      deployer
    ).result;
    expect(debt_bucket).toBeUint(5003240740n);

    // Borrow 51 USDC. It should be blocked bc debt bucker is aroun ~50 USDC
    res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(51_000_000_00), Cl.none()],
      borrower
    );
    expect(res.result).toBeErr(Cl.uint(120003));

    // Mine some blocks enlarge debt bucket
    for (let x = 0; x < 100; x++) {
      simnet.mineBlock([]);
    }

    // Borrow 51 USDC. This time it should work
    res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(51_000_000_00), Cl.none()],
      borrower
    );

    expect(res.result).toBeOk(Cl.bool(true));

    debt_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-debt-bucket",
      [],
      deployer
    ).result;
    expect(debt_bucket).toBeUint(44907406n);
  });

  it("collateral cap should allow / block removing collateral & update itself correctly", async () => {
    const btcCV = Cl.contractPrincipal(deployer, "mock-btc");

    const res = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_COLLATERAL_CAP),
        Cl.tuple({
          collateral: Cl.some(btcCV),
          factor: Cl.uint(0.8 * SCALING_FACTOR),
        }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(res.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(res);

    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 10n, deployer);
    await set_price("mock-eth", 1n, deployer);

    const collateral_cap_factor = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-cap-factor",
      [btcCV],
      deployer
    ).result;
    expect(collateral_cap_factor).toEqual(Cl.uint(0.8 * SCALING_FACTOR));

    // Add collateral
    const amount = 800_000_000_0; // 80 btc
    mint_token("mock-btc", amount, depositor);
    add_collateral("mock-btc", amount, deployer, depositor);

    let collateral_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-bucket",
      [btcCV],
      deployer
    ).result;
    expect(collateral_bucket).toBeUint(8000000000);

    simnet.mineEmptyBlocks(20);

    // Remove 70 btc. It should be bloked
    let resp = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), btcCV, Cl.uint(700_000_000_0), Cl.none()],
      depositor
    ).result;
    expect(resp).toBeErr(Cl.uint(120004));

    // Remove 50 btc (while 64 btc can be removed)
    resp = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), btcCV, Cl.uint(500_000_000_0), Cl.none()],
      depositor
    ).result;
    expect(resp).toBeOk(Cl.bool(true));

    collateral_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-bucket",
      [btcCV],
      deployer
    ).result;
    expect(collateral_bucket).toBeUint(1400000000n); // 14 btc

    // Remove 10 btc (while 14 btc can be removed)
    resp = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), btcCV, Cl.uint(100_000_000_0), Cl.none()],
      depositor
    ).result;
    expect(resp).toBeOk(Cl.bool(true));

    collateral_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-bucket",
      [btcCV],
      deployer
    ).result;
    expect(collateral_bucket).toBeUint(400277777n); // ~4 btc

    // Remove 4.1 btc (while 4 btc can be removed) Should be blocked
    resp = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), btcCV, Cl.uint(41_000_000_0), Cl.none()],
      depositor
    ).result;
    expect(resp).toBeErr(Cl.uint(120004));

    // Mine some blocks enlarge the bucket
    for (let x = 0; x < 100; x++) {
      simnet.mineBlock([]);
    }

    // Now it should remove 4.1 btc
    resp = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), btcCV, Cl.uint(41_000_000_0), Cl.none()],
      depositor
    ).result;
    expect(resp).toBeOk(Cl.bool(true));

    collateral_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-bucket",
      [btcCV],
      deployer
    ).result;
    expect(collateral_bucket).toBeUint(9166665n); // ~0.091 btc
  });

  it("non governance members should fail to propose a change", () => {
    const response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_DEBT_CAP),
        Cl.tuple({
          collateral: Cl.none(),
          factor: Cl.uint(0.01 * SCALING_FACTOR),
        }),
        Cl.uint(1),
      ],
      borrower
    );
    expect(response.result).toBeErr(Cl.uint(50000)); // ERR-NOT-GOVERNANCE
  });

  it("correctly update the lp cap", () => {
    let value = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-cap-factor",
      [],
      deployer
    );
    expect(value.result.value).toBe(0n);

    const response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_LP_CAP),
        Cl.tuple({
          collateral: Cl.none(),
          factor: Cl.uint(0.05 * SCALING_FACTOR),
        }),
        Cl.uint(100),
      ],
      deployer
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    value = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-cap-factor",
      [],
      deployer
    );
    expect(value.result.value).toBe(BigInt(0.05 * SCALING_FACTOR));
  });

  it("correctly update the debt cap", () => {
    let value = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-debt-cap-factor",
      [],
      deployer
    );
    expect(value.result.value).toBe(0n);

    const response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_DEBT_CAP),
        Cl.tuple({
          collateral: Cl.none(),
          factor: Cl.uint(0.05 * SCALING_FACTOR),
        }),
        Cl.uint(100),
      ],
      deployer
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    value = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-debt-cap-factor",
      [],
      deployer
    );
    expect(value.result.value).toBe(BigInt(0.05 * SCALING_FACTOR));
  });

  it("correctly update the refill time window", () => {
    let value = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-refill-time-window",
      [],
      deployer
    );
    expect(value.result.value).toBe(86400n);

    const response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_REFILL_TIME_WINDOW),
        Cl.tuple({
          collateral: Cl.none(),
          factor: Cl.uint(100),
        }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    value = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-refill-time-window",
      [],
      deployer
    );
    expect(value.result.value).toBe(100n);
  });

  it("correctly update the decay time window", () => {
    let value = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-decay-time-window",
      [],
      deployer
    );
    expect(value.result.value).toBe(10800n);

    const response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_DECAY_TIME_WINDOW),
        Cl.tuple({
          collateral: Cl.none(),
          factor: Cl.uint(100),
        }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    value = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-decay-time-window",
      [],
      deployer
    );
    expect(value.result.value).toBe(100n);
  });

  it("correctly update the collateral cap", () => {
    const mockBtc = Cl.contractPrincipal(deployer, "mock-btc");

    let value = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-cap-factor",
      [Cl.contractPrincipal(deployer, "mock-btc")],
      deployer
    );
    expect(value.result.value).toBe(0n);

    const response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_COLLATERAL_CAP),
        Cl.tuple({
          collateral: Cl.some(mockBtc),
          factor: Cl.uint(0.05 * SCALING_FACTOR),
        }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    value = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-cap-factor",
      [mockBtc],
      deployer
    );
    expect(value.result.value).toBe(BigInt(0.05 * SCALING_FACTOR));
  });

  // overflow
  it("lp cap should not overflow", () => {
    const res = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_LP_CAP),
        Cl.tuple({
          collateral: Cl.none(),
          factor: Cl.uint(0.1 * SCALING_FACTOR),
        }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(res.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(res);

    const factor = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-cap-factor",
      [],
      deployer
    ).result;
    expect(factor).toBeUint(0.1 * SCALING_FACTOR);

    // Initial liquidity 1bn USDC
    const amount = 1_000_000_000_000_000;
    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);

    let bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-bucket",
      [],
      deployer
    ).result;
    expect(bucket).toBeUint(1000000000000000);

    simnet.mineEmptyBlocks(20);

    // Withdraw 10% of the USDC balance
    let withdraw = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(amount / 10), Cl.principal(depositor)],
      depositor
    );
    expect(withdraw.result).toBeOk(Cl.bool(true));

    bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-bucket",
      [],
      deployer
    ).result;
    expect(bucket).toBeUint(0n);

    // Mine a large number of blocks
    for (let x = 0; x < 1_000_000; x++) {
      simnet.mineBlock([]);
    }

    const balance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      deployer
    );
    expect(balance.result.value.value).toBe(BigInt((amount * 9) / 10));

    // Withdraw full cap again
    withdraw = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint((amount * 9) / 10 / 10), Cl.principal(depositor)],
      depositor
    );
    expect(withdraw.result).toBeOk(Cl.bool(true));

    bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-bucket",
      [],
      deployer
    ).result;
    expect(bucket).toBeUint(0);
  });

  it("should handle maximum Clarity uint values without overflow", () => {
    const balance = 2n ** 65n;
    const amount = balance / 10n;

    let response = simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(amount), Cl.principal(depositor)],
      depositor
    );
    expect(response.result).toBeOk(Cl.bool(true));
    response = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(amount), Cl.principal(depositor)],
      depositor
    );
    expect(response.result).toBeOk(Cl.bool(true));
    response = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_LP_CAP),
        Cl.tuple({
          collateral: Cl.none(),
          factor: Cl.uint(0.99 * SCALING_FACTOR),
        }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(response.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(response);

    let bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-bucket",
      [],
      deployer
    );
    expect(bucket.result).toBeUint(0);

    let withdraw = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint((amount * 99n) / 100n), Cl.principal(depositor)],
      depositor
    );
    expect(withdraw.result).toBeOk(Cl.bool(true));

    bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-bucket",
      [],
      deployer
    );
    expect(bucket.result).toBeUint(0);

    for (let x = 0; x < 100; x++) {
      simnet.mineBlock([]);
    }

    withdraw = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(100), Cl.principal(depositor)],
      depositor
    );
    expect(withdraw.result).toBeOk(Cl.bool(true));
  });
});
