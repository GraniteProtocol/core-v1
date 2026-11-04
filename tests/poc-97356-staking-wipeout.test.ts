// Immunefi 97356: unit slashes drain the active bucket while the unbonding queue
// holds, and the wipe-out latch fired on an empty active bucket alone, bricking
// stake/initiate-unstake/reconcile with the queue still populated. The latch now
// needs both buckets empty.
import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  initialize_ir,
  set_allowed_contracts,
  set_asset_cap,
  deposit,
  mint_token,
  initialize_staking_reward,
  initialize_lp,
  initialize_staking,
  update_supported_collateral,
  add_collateral,
  borrow,
} from "./utils";
import {
  init_pyth,
  set_initial_price,
  set_pyth_time_delta,
  set_price,
  build_price_update,
} from "./pyth";

const accounts = simnet.getAccounts();
const user1 = accounts.get("wallet_1")!;
const user2 = accounts.get("wallet_2")!;
const user3 = accounts.get("wallet_3")!;
const harness = accounts.get("wallet_4")!;
const deployer = accounts.get("deployer")!;

const btc = Cl.contractPrincipal(deployer, "mock-btc");

const readUint = (contract: string, fn: string, args: any[] = []) => {
  const res = simnet.callReadOnlyFn(contract, fn, args, deployer);
  return res.result.value;
};

const readBool = (contract: string, fn: string, args: any[] = []) => {
  const res = simnet.callReadOnlyFn(contract, fn, args, deployer);
  return res.result;
};

// Register a harness principal as an allowed contract so it can drive
// slash-total-staked-lp-tokens exactly as liquidator-v1 does.
const allowHarness = () => {
  const res = simnet.callPublicFn(
    "state-v1",
    "set-allowed-contract",
    [Cl.standardPrincipal(harness)],
    deployer
  );
  expect(res.result).toBeOk(Cl.bool(true));
};

// Stake `total` LP tokens as user1, then unstake all but `active` of them, so the
// queue holds `total - active` and active keeps `active`.
const seedActiveAndQueue = (total: bigint, active: bigint) => {
  mint_token("mock-usdc", Number(total), user1);
  deposit(Number(total), user1);

  let res = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(total)], user1);
  expect(res.result).toBeOk(Cl.bool(true));

  res = simnet.callPublicFn("staking-v1", "initiate-unstake", [Cl.uint(total - active)], user1);
  expect(res.result).toBeOk(Cl.uint(0));
};

const slash = (amount: bigint) => {
  const res = simnet.callPublicFn(
    "staking-v1",
    "slash-total-staked-lp-tokens",
    [Cl.uint(amount)],
    harness
  );
  expect(res.result).toBeOk(Cl.bool(true));
};

const grind = (slashes: number) => {
  for (let i = 0; i < slashes; i++) slash(1n);
};

// The three entry points gated on the wipe-out latch.
const expectStakingEnabled = () => {
  mint_token("mock-usdc", 1000, user2);
  deposit(1000, user2);

  let res = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(1)], user2);
  expect(res.result).toBeOk(Cl.bool(true));

  res = simnet.callPublicFn("staking-v1", "initiate-unstake", [Cl.uint(1)], user2);
  expect(res.result).toBeOk(Cl.uint(0));

  res = simnet.callPublicFn("staking-v1", "reconcile-lp-token-balance", [], deployer);
  expect(res.result).toBeOk(Cl.bool(true));
};

const expectStakingWiped = () => {
  let res = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(1)], user2);
  expect(res.result).toBeErr(Cl.uint(60010));

  res = simnet.callPublicFn("staking-v1", "initiate-unstake", [Cl.uint(1)], user2);
  expect(res.result).toBeErr(Cl.uint(60010));

  res = simnet.callPublicFn("staking-v1", "reconcile-lp-token-balance", [], deployer);
  expect(res.result).toBeErr(Cl.uint(60010));
};

describe("Immunefi 97356: the wipe-out latch needs both slash buckets empty", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 10n, deployer);
    allowHarness();
  });

  it("a partial slash takes the queue's floor share and the rest from active", () => {
    initialize_staking(deployer);
    seedActiveAndQueue(1_000_000n, 1_000n);

    // A = 1,000, W = 999,000.
    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(1_000n);
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(1_000_000n);

    slash(500n);

    // floor(500 * 999,000 / 1,000,000) = 499 to the queue, 1 from active.
    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(999n);
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(999_500n);
    expect(readBool("staking-v1", "is-staking-wiped-out")).toStrictEqual(Cl.bool(false));
  });

  it("unit slashes drain active to zero without latching while the queue holds", () => {
    initialize_staking(deployer);
    seedActiveAndQueue(1_000_000n, 100n);

    grind(100);

    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(0n);
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(999_900n);
    expect(readBool("staking-v1", "is-staking-wiped-out")).toStrictEqual(Cl.bool(false));

    // Not a true wipe, but with active at zero there is nothing to stake into:
    // both entry points return the wiped-out error instead of aborting.
    let res = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(1)], user2);
    expect(res.result).toBeErr(Cl.uint(60010));

    res = simnet.callPublicFn("staking-v1", "initiate-unstake", [Cl.uint(1)], user1);
    expect(res.result).toBeErr(Cl.uint(60010));

    res = simnet.callPublicFn("staking-v1", "reconcile-lp-token-balance", [], deployer);
    expect(res.result).toBeOk(Cl.bool(true));
  });

  it("the wind-down state still slashes the queue and does not block the market", async () => {
    initialize_staking(deployer);
    // 1,000 USDC staked, all but 100 LP units unbonding, so the bad debt below slashes
    // the queue only in part and the queued user still has LP to take.
    seedActiveAndQueue(100_000_000_000n, 100n);
    grind(100);

    // A = 0, W = 99,999,999,900, latch false.
    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(0n);
    expect(readBool("staking-v1", "is-staking-wiped-out")).toStrictEqual(Cl.bool(false));

    // LP deposit, LP withdraw, borrow and repay all keep working.
    mint_token("mock-usdc", 10_000_000, user2);
    deposit(10_000_000, user2);
    let res = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(1_000_000), Cl.principal(user2)],
      user2
    );
    expect(res.result).toBeOk(Cl.bool(true));

    update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
    mint_token("mock-btc", 100_000_000_000, user2);
    add_collateral("mock-btc", 20_000_000_000, deployer, user2);
    borrow(1_000_000, user2);
    res = simnet.callPublicFn("borrower-v1", "repay", [Cl.uint(500_000), Cl.none()], user2);
    expect(res.result).toBeOk(Cl.bool(true));

    // A real bad-debt liquidation slashes the live queue while active is zero.
    mint_token("mock-usdc", 100_000_000_000, user3);
    deposit(100_000_000_000, user3);
    mint_token("mock-btc", 100_000_000_000, user3);
    add_collateral("mock-btc", 20_000_000_000, deployer, user3);
    borrow(18_000_000_000, user3);

    simnet.mineEmptyBlocks(500);
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);
    update_supported_collateral("mock-btc", 40_000_000, 50_000_000, 20_000_000, 8, deployer);
    mint_token("mock-usdc", 18_181_818_181, harness);

    // The wind-down state at the call: active zero, queue live.
    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(0n);
    const stakedBefore = readUint("staking-v1", "get-total-staked-lp-tokens");

    const liquidation = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [Cl.buffer(build_price_update()), btc, Cl.principal(user3), Cl.uint(18_181_818_181), Cl.uint(0)],
      harness
    );
    expect(liquidation.result).toBeOk(Cl.bool(true));

    const socialized = liquidation.events.find(
      (e: any) =>
        e.event === "print_event" &&
        e.data?.value?.value?.action?.value === "socialized-bad-debt"
    );
    expect(socialized).toBeDefined();
    const burned = socialized!.data.value.value["burned-staking-lp-tokens"].value as bigint;
    expect(burned).toBeGreaterThan(0n);
    // The queue accounting falls by exactly the amount the liquidation burned.
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(stakedBefore - burned);

    // The queued user still finalizes and takes the remaining LP.
    const before = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(user1)],
      deployer
    ).result;
    const finalize = simnet.callPublicFn("staking-v1", "finalize-unstake", [Cl.uint(0)], user1);
    expect(finalize.result).toBeOk(Cl.bool(true));
    const after = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(user1)],
      deployer
    ).result;
    expect((after as any).value.value).toBeGreaterThan((before as any).value.value);
  });

  it("a slash with an empty queue does not latch while active survives", () => {
    initialize_staking(deployer);
    mint_token("mock-usdc", 1_000_000, user1);
    deposit(1_000_000, user1);
    const staked = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(1_000_000)], user1);
    expect(staked.result).toBeOk(Cl.bool(true));

    slash(1n);

    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(999_999n);
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(999_999n);
    expect(readBool("staking-v1", "is-staking-wiped-out")).toStrictEqual(Cl.bool(false));
    expectStakingEnabled();
  });

  it("staking stays shut when only the queue backs a zero active accounting", () => {
    initialize_staking(deployer);
    mint_token("mock-usdc", 1_000_000, user1);
    deposit(1_000_000, user1);
    let res = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(1_000_000)], user1);
    expect(res.result).toBeOk(Cl.bool(true));
    res = simnet.callPublicFn("staking-v1", "initiate-unstake", [Cl.uint(1_000_000)], user1);
    expect(res.result).toBeOk(Cl.uint(0));

    // A = 0, staked-token supply = 0, queue = 1,000,000.
    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(0n);
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(1_000_000n);

    res = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(1)], user2);
    expect(res.result).toBeErr(Cl.uint(60010));

    res = simnet.callPublicFn("staking-v1", "initiate-unstake", [Cl.uint(1)], user1);
    expect(res.result).toBeErr(Cl.uint(60010));

    // The queued user can still finalize.
    simnet.mineEmptyBlocks(500);
    res = simnet.callPublicFn("staking-v1", "finalize-unstake", [Cl.uint(0)], user1);
    expect(res.result).toBeOk(Cl.bool(true));
  });

  it("clearing both buckets latches and gates the staking entry points", () => {
    initialize_staking(deployer);
    seedActiveAndQueue(1_000_000n, 1_000n);

    slash(1_000_000n);

    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(0n);
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(0n);
    expect(readBool("staking-v1", "is-staking-wiped-out")).toStrictEqual(Cl.bool(true));
    expectStakingWiped();
  });
});
