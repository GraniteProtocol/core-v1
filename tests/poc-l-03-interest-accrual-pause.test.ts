// L-03: Disabling interest accrual permanently skipped pending borrower interest.
// state-v1.set-interest-accrual-flag advances last-accrued-block-time to the
// current block without first settling pending interest. Three governance-v1
// callers triggered this:
//   1. guardian-pause-market         -> state-v1.pause-market -> set-interest-accrual-flag(false)
//   2. execute-state-set-market-flag -> state-v1.pause-market -> set-interest-accrual-flag(false)
//   3. execute-state-set-feature-flag(ACTION_SET_INTEREST_ACCRUAL_FLAG=false)
//
// Fix: governance-v1 now calls its private accrue-interest before each path
// (try! on paths 2+3; best-effort match on path 1 to avoid blocking emergency
// pause). These tests verify lp-open-interest grows across each path, which
// would not happen pre-fix.

import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType } from "@stacks/transactions";
import {
  borrow,
  deposit,
  initialize_governance,
  initialize_ir,
  initialize_lp,
  initialize_staking_reward,
  mint_token,
  add_collateral,
  set_allowed_contracts,
  set_asset_cap,
  state_set_governance_contract,
  update_supported_collateral,
} from "./utils";
import {
  init_pyth,
  set_initial_price,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const governance_account = accounts.get("wallet_1")!;
const guardian_account = accounts.get("wallet_2")!;
const depositor = accounts.get("wallet_3")!;
const borrower = accounts.get("wallet_4")!;

const ACTION_SET_MARKET_PAUSE_FLAG = 9;
const ACTION_SET_INTEREST_ACCRUAL_FLAG = 23;

function getLpOpenInterest(): bigint {
  const r = simnet.callReadOnlyFn(
    "state-v1",
    "get-open-interest",
    [],
    deployer
  );
  // get-open-interest returns a tuple
  return (r.result as any).data["lp-open-interest"].value as bigint;
}

function setupBorrowerWithDebt() {
  // Initialise + funding + a live borrow position so interest accrual has
  // something to grow against.
  init_pyth(deployer);
  set_pyth_time_delta(7200, deployer);
  set_allowed_contracts(deployer);
  set_asset_cap(deployer, 10000000000000n);
  initialize_ir(deployer);
  initialize_staking_reward(deployer);
  initialize_lp(deployer);
  set_initial_price("mock-usdc", 1n, deployer);
  set_initial_price("mock-btc", 10n, deployer);
  initialize_governance(governance_account, guardian_account, deployer);

  update_supported_collateral(
    "mock-btc",
    70000000,
    80000000,
    10000000,
    8,
    deployer
  );
  mint_token("mock-usdc", 100000000000, depositor);
  deposit(100000000000, depositor);

  mint_token("mock-btc", 100000000000, borrower);
  add_collateral("mock-btc", 100000000000, deployer, borrower);
  borrow(50000000000, borrower);
}

describe("L-03 — interest-accrual pause settles pending interest", () => {
  // With a single-member governance, initiate-proposal auto-approves and
  // auto-executes on submission — no separate execute call needed.
  beforeEach(() => {
    setupBorrowerWithDebt();
  });

  it("path 1: guardian-pause-market settles pending interest before pausing", () => {
    state_set_governance_contract(deployer);
    // Borrow happened during setup; the checkpoint is fresh. Advance blocks
    // so interest accumulates without any natural settlement.
    simnet.mineEmptyBlocks(100);

    const lpBefore = getLpOpenInterest();

    const r = simnet.callPublicFn(
      "governance-v1",
      "guardian-pause-market",
      [],
      guardian_account
    );
    expect(r.result).toBeOk(Cl.bool(true));

    const lpAfter = getLpOpenInterest();
    expect(lpAfter).toBeGreaterThan(lpBefore);

    // Sanity: accrual flag is now off.
    const flag = simnet.callReadOnlyFn(
      "state-v1",
      "is-interest-accrual-enabled",
      [],
      deployer
    );
    expect(flag.result).toStrictEqual(Cl.bool(false));
  });

  it("path 2: governance market pause settles pending interest", () => {
    state_set_governance_contract(deployer);
    simnet.mineEmptyBlocks(100);

    const lpBefore = getLpOpenInterest();

    const r = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-state",
      [Cl.uint(ACTION_SET_MARKET_PAUSE_FLAG), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(r.result.type).toBe(ClarityType.ResponseOk);

    // initiate-proposal-to-set-market-state does NOT auto-execute on threshold
    // met the way set-market-feature does (existing tests confirm); explicit
    // execute is needed after time-lock window passes.
    const proposal_id = (r.result as any).value.buffer;
    simnet.mineEmptyBlocks(21600);
    const exec = simnet.callPublicFn(
      "governance-v1",
      "execute",
      [Cl.buffer(proposal_id)],
      governance_account
    );
    expect(exec.result).toBeOk(Cl.bool(true));

    // Sanity: pause actually fired (accrual flag flipped off).
    const flag = simnet.callReadOnlyFn(
      "state-v1",
      "is-interest-accrual-enabled",
      [],
      deployer
    );
    expect(flag.result).toStrictEqual(Cl.bool(false));

    const lpAfter = getLpOpenInterest();
    expect(lpAfter).toBeGreaterThan(lpBefore);
  });

  it("path 3: direct accrual-flag disable settles pending interest", () => {
    state_set_governance_contract(deployer);
    simnet.mineEmptyBlocks(100);

    const lpBefore = getLpOpenInterest();

    const r = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(ACTION_SET_INTEREST_ACCRUAL_FLAG), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(r.result.type).toBe(ClarityType.ResponseOk);

    const lpAfter = getLpOpenInterest();
    expect(lpAfter).toBeGreaterThan(lpBefore);

    const flag = simnet.callReadOnlyFn(
      "state-v1",
      "is-interest-accrual-enabled",
      [],
      deployer
    );
    expect(flag.result).toStrictEqual(Cl.bool(false));
  });

  it("guardian-pause-market is best-effort: if accrue-interest is already a no-op (accrual disabled), pause still succeeds", () => {
    // Disable accrual first via direct path, then guardian-pause. The
    // guardian path's accrue-interest is a no-op (accrual already off);
    // pause must still succeed.
    state_set_governance_contract(deployer);

    const r1 = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-set-market-feature",
      [Cl.uint(ACTION_SET_INTEREST_ACCRUAL_FLAG), Cl.bool(false), Cl.uint(10), Cl.uint(0)],
      governance_account
    );
    expect(r1.result.type).toBe(ClarityType.ResponseOk);

    simnet.mineEmptyBlocks(50);

    const r2 = simnet.callPublicFn(
      "governance-v1",
      "guardian-pause-market",
      [],
      guardian_account
    );
    expect(r2.result).toBeOk(Cl.bool(true));
  });
});
