import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  deposit,
  initialize_ir,
  initialize_lp,
  initialize_staking,
  initialize_staking_reward,
  mint_token,
  set_allowed_contracts,
  set_asset_cap,
  MINIMUM_INITIAL_STAKE,
} from "./utils";
import { init_pyth, set_pyth_time_delta, set_initial_price } from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const staker = accounts.get("wallet_1")!;

describe("PoC E-L-01: staking share-inflation guard", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10_000_000_000_000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
  });

  it("stake is blocked until initialize seeds the dead shares", () => {
    mint_token("mock-usdc", 5000, staker);
    deposit(5000, staker);

    const beforeInit = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(1000)], staker);
    expect(beforeInit.result).toBeErr(Cl.uint(60012));

    initialize_staking(deployer, MINIMUM_INITIAL_STAKE);

    const afterInit = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(1000)], staker);
    expect(afterInit.result).toBeOk(Cl.bool(true));
  });

  it("initialize is deployer-only, seeds the dead-share floor, and rejects a second call", () => {
    const byStaker = simnet.callPublicFn("staking-v1", "initialize", [Cl.none()], staker);
    expect(byStaker.result).toBeErr(Cl.uint(60013));

    initialize_staking(deployer, MINIMUM_INITIAL_STAKE);

    const supply = simnet.callReadOnlyFn("staking-v1", "get-total-supply", [], deployer);
    expect(supply.result).toBeOk(Cl.uint(Number(MINIMUM_INITIAL_STAKE)));

    const second = simnet.callPublicFn("staking-v1", "initialize", [Cl.none()], deployer);
    expect(second.result).toBeErr(Cl.uint(60011));
  });
});
