import { Cl, ClarityType } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  init_pyth,
  set_initial_price,
  set_price,
  set_pyth_time_delta,
  build_price_update,
} from "../pyth";
import {
  add_collateral,
  deposit,
  initialize_governance,
  initialize_ir,
  initialize_lp,
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
  const proposal_id = response.result.value.value;
  simnet.mineEmptyBlocks(21600);
  const res = simnet.callPublicFn(
    "governance-v1",
    "execute",
    [Cl.bufferFromHex(proposal_id)],
    deployer
  );
  expect(res.result).toBeOk(Cl.bool(true));
}

function lpBucketMax() {
  const factor = simnet.callReadOnlyFn(
    "withdrawal-caps-v1",
    "get-lp-cap-factor",
    [],
    deployer
  ).result.value as bigint;
  const balance = simnet.callReadOnlyFn(
    "mock-usdc",
    "get-balance",
    [Cl.contractPrincipal(deployer, "state-v1")],
    deployer
  ).result.value.value as bigint;
  return (balance * factor) / 100_000_000n;
}

function stateTokenBalance(token: string) {
  return simnet.callReadOnlyFn(
    token,
    "get-balance",
    [Cl.contractPrincipal(deployer, "state-v1")],
    deployer
  ).result.value.value as bigint;
}

function lpExcessAboveMax() {
  const bucket = simnet.callReadOnlyFn("withdrawal-caps-v1", "get-lp-bucket", [], deployer).result.value as bigint;
  const max = lpBucketMax();
  return bucket > max ? bucket - max : 0n;
}

// One block of decay is under a hundredth of the excess at this window length.
function decayDriftBound() {
  return (lpExcessAboveMax() / 100n) + 2n;
}

// A very long decay window keeps the per-block drift negligible, while 4,000 blocks
// still leave the excess well inside the window, so the gross-up genuinely matters.
function primeLpExcessMidWindow() {
  setDecayWindow(10_000_000);
  setLpCap(0.8);

  const base = 1_000_000_000;
  mint_token("mock-usdc", base, depositor);
  deposit(base, depositor);

  simnet.mineEmptyBlocks(4_000);
}

function debtBucketMax() {
  const factor = simnet.callReadOnlyFn("withdrawal-caps-v1", "get-debt-cap-factor", [], deployer).result.value as bigint;
  const liquidity = simnet.callReadOnlyFn("state-v1", "get-borrowable-balance", [], deployer).result.value as bigint;
  return (liquidity * factor) / 100_000_000n;
}

function collateralBucketMax(token: string) {
  const cv = Cl.contractPrincipal(deployer, token);
  const factor = simnet.callReadOnlyFn("withdrawal-caps-v1", "get-collateral-cap-factor", [cv], deployer).result.value as bigint;
  return (stateTokenBalance(token) * factor) / 100_000_000n;
}

function setDebtCap(factor: number) {
  const res = simnet.callPublicFn(
    "governance-v1",
    "initiate-proposal-to-update-withdrawal-caps-param",
    [Cl.uint(ACTION_SET_DEBT_CAP), Cl.tuple({ collateral: Cl.none(), factor: Cl.uint(factor * SCALING_FACTOR) }), Cl.uint(1)],
    deployer
  );
  expect(res.result.type).toBe(ClarityType.ResponseOk);
  execute_proposal(res);
}

function setDecayWindow(window: number) {
  const res = simnet.callPublicFn(
    "governance-v1",
    "initiate-proposal-to-update-withdrawal-caps-param",
    [Cl.uint(ACTION_SET_DECAY_TIME_WINDOW), Cl.tuple({ collateral: Cl.none(), factor: Cl.uint(window) }), Cl.uint(1)],
    deployer
  );
  expect(res.result.type).toBe(ClarityType.ResponseOk);
  execute_proposal(res);
}

function setRefillWindow(window: number) {
  const res = simnet.callPublicFn(
    "governance-v1",
    "initiate-proposal-to-update-withdrawal-caps-param",
    [Cl.uint(ACTION_SET_REFILL_TIME_WINDOW), Cl.tuple({ collateral: Cl.none(), factor: Cl.uint(window) }), Cl.uint(1)],
    deployer
  );
  expect(res.result.type).toBe(ClarityType.ResponseOk);
  execute_proposal(res);
}

function setLpCap(factor: number) {
  const res = simnet.callPublicFn(
    "governance-v1",
    "initiate-proposal-to-update-withdrawal-caps-param",
    [
      Cl.uint(ACTION_SET_LP_CAP),
      Cl.tuple({
        collateral: Cl.none(),
        factor: Cl.uint(factor * SCALING_FACTOR),
      }),
      Cl.uint(1),
    ],
    deployer
  );
  expect(res.result.type).toBe(ClarityType.ResponseOk);
  execute_proposal(res);
}

describe("withdrawal caps tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 2n ** 128n - 1n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
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
    // H-01 burn dust adds to total-assets which feeds the cap-factor scaling.
    expect(lp_bucket).toBeUint(50000000800);

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
      [Cl.buffer(build_price_update()), Cl.uint(410_000_000_00), Cl.none()],
      borrower
    );
    expect(res.result).toBeErr(Cl.uint(120003));

    // Borrow 150 USDC
    res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.buffer(build_price_update()), Cl.uint(150_000_000_00), Cl.none()],
      borrower
    );
    expect(res.result).toBeOk(Cl.bool(true));

    debt_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-debt-bucket",
      [],
      deployer
    ).result;
    // H-01 burn dust adds to total-assets which feeds the cap-factor scaling.
    expect(debt_bucket).toBeUint(25000000800n);

    // Borrow 200 USDC
    res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.buffer(build_price_update()), Cl.uint(200_000_000_00), Cl.none()],
      borrower
    );
    expect(res.result).toBeOk(Cl.bool(true));

    debt_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-debt-bucket",
      [],
      deployer
    ).result;
    // H-01 burn dust adds to total-assets which feeds the cap-factor scaling.
    expect(debt_bucket).toBeUint(5003241540n);

    // Borrow 51 USDC. It should be blocked bc debt bucker is aroun ~50 USDC
    res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.buffer(build_price_update()), Cl.uint(51_000_000_00), Cl.none()],
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
      [Cl.buffer(build_price_update()), Cl.uint(51_000_000_00), Cl.none()],
      borrower
    );

    expect(res.result).toBeOk(Cl.bool(true));

    debt_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-debt-bucket",
      [],
      deployer
    ).result;
    // H-01 burn dust adds to total-assets which feeds the cap-factor scaling.
    expect(debt_bucket).toBeUint(44908216n);
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
      [btcCV, Cl.uint(stateTokenBalance("mock-btc"))],
      deployer
    ).result;
    expect(collateral_bucket).toBeUint(8000000000);

    simnet.mineEmptyBlocks(20);

    // refresh prices after mining blocks
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 10n, deployer);

    // Remove 70 btc. It should be bloked
    let resp = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.buffer(build_price_update()), btcCV, Cl.uint(700_000_000_0), Cl.none()],
      depositor
    ).result;
    expect(resp).toBeErr(Cl.uint(120004));

    // Remove 50 btc (while 64 btc can be removed)
    resp = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.buffer(build_price_update()), btcCV, Cl.uint(500_000_000_0), Cl.none()],
      depositor
    ).result;
    expect(resp).toBeOk(Cl.bool(true));

    collateral_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-bucket",
      [btcCV, Cl.uint(stateTokenBalance("mock-btc"))],
      deployer
    ).result;
    expect(collateral_bucket).toBeUint(1400000000n); // 14 btc

    // Remove 10 btc (while 14 btc can be removed)
    resp = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.buffer(build_price_update()), btcCV, Cl.uint(100_000_000_0), Cl.none()],
      depositor
    ).result;
    expect(resp).toBeOk(Cl.bool(true));

    collateral_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-bucket",
      [btcCV, Cl.uint(stateTokenBalance("mock-btc"))],
      deployer
    ).result;
    expect(collateral_bucket).toBeUint(400277777n); // ~4 btc

    // Remove 4.1 btc (while 4 btc can be removed) Should be blocked
    resp = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.buffer(build_price_update()), btcCV, Cl.uint(41_000_000_0), Cl.none()],
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
      [Cl.buffer(build_price_update()), btcCV, Cl.uint(41_000_000_0), Cl.none()],
      depositor
    ).result;
    expect(resp).toBeOk(Cl.bool(true));

    collateral_bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-bucket",
      [btcCV, Cl.uint(stateTokenBalance("mock-btc"))],
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
    // H-01 burn dust adds to total-assets which feeds the cap-factor scaling.
    expect(bucket).toBeUint(1000000000000100);

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
    // H-01 dust leaves 100 worth of headroom in the bucket here.
    expect(bucket).toBeUint(100n);

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
    // +1000 H-01 burn dust still parked in state-v1.
    expect(balance.result.value.value).toBe(BigInt((amount * 9) / 10 + 1000));

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
    // H-01 dust leaves 100 worth of headroom in the bucket here too.
    expect(bucket).toBeUint(100);
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
    // H-01 dust leaves 990 worth of headroom in the bucket after the test
    // withdraws 10% of the cap.
    expect(bucket.result).toBeUint(990);

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

  it("lp excess decays to max by its original deadline despite a mid-window withdrawal", () => {
    setLpCap(0.8);

    const amount = 500_000_000_00;
    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);

    // Touch inside the window, leaving the read below a touch-relative deadline.
    simnet.mineEmptyBlocks(9);
    const touch = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(1), Cl.principal(depositor)],
      depositor
    );
    expect(touch.result).toBeOk(Cl.bool(true));

    // Past the original deadline, still short of a window measured from the touch.
    simnet.mineEmptyBlocks(15);

    const bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-bucket",
      [],
      deployer
    ).result;
    expect(bucket).toBeUint(lpBucketMax());

    // The enforced cap must agree with the getter, not only the view.
    const over = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(lpBucketMax() + 1n), Cl.principal(depositor)],
      depositor
    );
    expect(over.result).toBeErr(Cl.uint(120002));
  });

  it("lp excess decays to max by its original deadline despite a mid-window deposit", () => {
    setLpCap(0.8);

    const amount = 500_000_000_00;
    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);

    // A one-unit top-up used to re-age the whole excess.
    simnet.mineEmptyBlocks(9);
    mint_token("mock-usdc", 1, depositor);
    deposit(1, depositor);

    simnet.mineEmptyBlocks(15);

    const bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-lp-bucket",
      [],
      deployer
    ).result;
    expect(bucket).toBeUint(lpBucketMax());

    const over = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(lpBucketMax() + 1n), Cl.principal(depositor)],
      depositor
    );
    expect(over.result).toBeErr(Cl.uint(120002));
  });

  it("debt excess decays to max by its original deadline despite a mid-window borrow", async () => {
    setDebtCap(0.8);
    setRefillWindow(3_600);

    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 10n, deployer);

    const amount = 500_000_000_00;
    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);

    mint_token("mock-btc", 800_000_000_0, borrower);
    add_collateral("mock-btc", 800_000_000_0, deployer, borrower);

    // Borrow, refill to max, then repay: the repayment is what pushes the bucket
    // above max in the first place.
    let res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.buffer(build_price_update()), Cl.uint(100_000_000_00), Cl.none()],
      borrower
    );
    expect(res.result).toBeOk(Cl.bool(true));
    simnet.mineEmptyBlocks(6);

    mint_token("mock-usdc", 100_000_000_00, borrower);
    res = simnet.callPublicFn("borrower-v1", "repay", [Cl.uint(100_000_000_00), Cl.none()], borrower);
    expect(res.result).toBeOk(Cl.bool(true));

    // Mid-window debit touch.
    simnet.mineEmptyBlocks(9);
    res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.buffer(build_price_update()), Cl.uint(1), Cl.none()],
      borrower
    );
    expect(res.result).toBeOk(Cl.bool(true));

    simnet.mineEmptyBlocks(15);

    const bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-debt-bucket",
      [],
      deployer
    ).result;
    expect(bucket).toBeUint(debtBucketMax());

    res = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.buffer(build_price_update()), Cl.uint(debtBucketMax() + 1n), Cl.none()],
      borrower
    );
    expect(res.result).toBeErr(Cl.uint(120003));
  });

  it("a mid-window deposit credits exactly its inflow", () => {
    primeLpExcessMidWindow();
    const bucket = () => simnet.callReadOnlyFn("withdrawal-caps-v1", "get-lp-bucket", [], deployer).result.value as bigint;
    const before = bucket();

    const inflow = 100_000_000n;
    mint_token("mock-usdc", inflow, depositor);
    deposit(inflow, depositor);

    const after = bucket();
    expect(after - before).toBeLessThanOrEqual(inflow + 1n);
    expect(after - before).toBeGreaterThanOrEqual(inflow - decayDriftBound());
  });

  it("a mid-window withdrawal removes exactly its amount", () => {
    primeLpExcessMidWindow();
    const bucket = () => simnet.callReadOnlyFn("withdrawal-caps-v1", "get-lp-bucket", [], deployer).result.value as bigint;
    const before = bucket();

    const amount = 100_000_000n;
    const res = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(amount), Cl.principal(depositor)],
      depositor
    );
    expect(res.result).toBeOk(Cl.bool(true));

    const after = bucket();
    const drop = before - after;
    expect(drop).toBeGreaterThanOrEqual(amount - 1n);
    expect(drop).toBeLessThanOrEqual(amount + decayDriftBound());
  });

  // Known limitation, under discussion: the same inflow buys less credit as the deadline
  // nears, so a deposit and a withdrawal one block apart remove more excess than the deposit
  // added. Measured loss on a 100,000,000 round trip late in the window: about 11,400,000.
  it.fails("a wash trade just before the deadline still nets out", () => {
    setLpCap(0.8);
    const base = 1_000_000_000;
    mint_token("mock-usdc", base, depositor);
    deposit(base, depositor);

    // The simnet block length is not fixed, so walk block by block until the excess is
    // down to a fifth of what it was: late in the window, but still alive.
    const created = lpExcessAboveMax();
    const stop = created / 5n;
    let excessBefore = created;
    for (let i = 0; i < 60 && excessBefore > stop; i++) {
      simnet.mineEmptyBlocks(1);
      excessBefore = lpExcessAboveMax();
    }

    const bucket = () => simnet.callReadOnlyFn("withdrawal-caps-v1", "get-lp-bucket", [], deployer).result.value as bigint;
    const before = bucket();
    expect(excessBefore > 0n).toBe(true);

    const amount = 100_000_000n;
    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);
    const res = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(amount), Cl.principal(depositor)],
      depositor
    );
    expect(res.result).toBeOk(Cl.bool(true));

    const after = bucket();
    expect(after).toBeLessThanOrEqual(before + 1n);
    expect(after).toBeGreaterThanOrEqual(before - decayDriftBound());
  });

  it("a deposit and an immediate withdrawal leave the bucket where it was", () => {
    primeLpExcessMidWindow();
    const bucket = () => simnet.callReadOnlyFn("withdrawal-caps-v1", "get-lp-bucket", [], deployer).result.value as bigint;
    const before = bucket();

    // The wash trade the decay window exists to neutralise.
    const amount = 100_000_000n;
    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);
    const res = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(amount), Cl.principal(depositor)],
      depositor
    );
    expect(res.result).toBeOk(Cl.bool(true));

    const after = bucket();
    expect(after).toBeLessThanOrEqual(before + 1n);
    expect(after).toBeGreaterThanOrEqual(before - decayDriftBound());
  });

  it("the bucket never reads above the maximum once the anchor is gone", async () => {
    setLpCap(0.8);

    const base = 500_000_000_00;
    mint_token("mock-usdc", base, depositor);
    deposit(base, depositor);

    // Decay to max, then a unit withdrawal clears the anchor on the sync.
    simnet.mineEmptyBlocks(20);
    const touch = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(1), Cl.principal(depositor)],
      depositor
    );
    expect(touch.result).toBeOk(Cl.bool(true));

    const beforeMax = lpBucketMax();
    const before = simnet.callReadOnlyFn("withdrawal-caps-v1", "get-lp-bucket", [], deployer).result;
    expect(before).toBeUint(beforeMax);

    // A borrow moves the market token out of state-v1, dropping the max.
    await set_price("mock-btc", 10n, deployer);
    mint_token("mock-btc", 800_000_000_0, borrower);
    add_collateral("mock-btc", 800_000_000_0, deployer, borrower);
    const borrowRes = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.buffer(build_price_update()), Cl.uint(100_000_000_00), Cl.none()],
      borrower
    );
    expect(borrowRes.result).toBeOk(Cl.bool(true));

    const afterMax = lpBucketMax();
    expect(afterMax < beforeMax).toBe(true);
    const after = simnet.callReadOnlyFn("withdrawal-caps-v1", "get-lp-bucket", [], deployer).result;
    expect(after).toBeUint(afterMax);
  });

  it("collateral excess decays to max by its original deadline despite a mid-window deposit", async () => {
    const btcCV = Cl.contractPrincipal(deployer, "mock-btc");

    const capResponse = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_COLLATERAL_CAP),
        Cl.tuple({ collateral: Cl.some(btcCV), factor: Cl.uint(0.8 * SCALING_FACTOR) }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(capResponse.result.type).toBe(ClarityType.ResponseOk);
    execute_proposal(capResponse);

    await set_price("mock-btc", 10n, deployer);

    const amount = 800_000_000_0;
    mint_token("mock-btc", amount, depositor);
    add_collateral("mock-btc", amount, deployer, depositor);

    simnet.mineEmptyBlocks(9);
    mint_token("mock-btc", 1, depositor);
    add_collateral("mock-btc", 1, deployer, depositor);

    simnet.mineEmptyBlocks(15);

    const bucket = simnet.callReadOnlyFn(
      "withdrawal-caps-v1",
      "get-collateral-bucket",
      [btcCV, Cl.uint(stateTokenBalance("mock-btc"))],
      deployer
    ).result;
    expect(bucket).toBeUint(collateralBucketMax("mock-btc"));

    const over = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.buffer(build_price_update()), btcCV, Cl.uint(collateralBucketMax("mock-btc") + 1n), Cl.none()],
      depositor
    );
    expect(over.result).toBeErr(Cl.uint(120004));
  });
});
