// state-v1::socialize-user-bad-debt subtracts all three split parts with a plain `-`,
// so a part above its bucket aborts the whole liquidation. These tests pin both sides of
// that boundary: the LP part at its exact maximum (the entire LP bucket) through the real
// liquidation path, and the fact that state-v1 adds no guard of its own, so a caller that
// passes an oversized part aborts without moving state.
import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType, ClarityVersion, contractPrincipalCV } from "@stacks/transactions";
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
  set_price_without_scaling,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const victim = accounts.get("wallet_1")!;
const liquidator = accounts.get("wallet_2")!;
const depositor = accounts.get("wallet_3")!;
const governor = accounts.get("wallet_4")!;
const btc = contractPrincipalCV(deployer, "mock-btc");

const ro = (contract: string, fn: string, args: any[] = []) =>
  simnet.callReadOnlyFn(contract, fn, args, deployer).result as any;

const buckets = () => {
  const oi = ro("state-v1", "get-open-interest").value;
  return {
    lp: oi["lp-open-interest"].value as bigint,
    staked: oi["staked-open-interest"].value as bigint,
    protocol: oi["protocol-open-interest"].value as bigint,
  };
};

const totalBorrowed = (user: string) =>
  ro("state-v1", "get-borrow-repay-params", [Cl.principal(user)]).value[
    "total-borrowed-amount"
  ].value as bigint;

const totalDebtShares = () =>
  ro("state-v1", "get-debt-params").value["total-debt-shares"].value as bigint;

const positionOf = (user: string) =>
  ro("state-v1", "get-user-position", [Cl.principal(user)]).value.value as any;

const eventValue = (events: any[], action: string) =>
  events.map((e: any) => e.data?.value?.value).find((e: any) => e?.["action"]?.value === action);

const handOverGovernance = () =>
  expect(
    simnet.callPublicFn("state-v1", "update-governance", [Cl.principal(governor)], deployer)
      .result
  ).toBeOk(Cl.bool(true));

const freezeInterestAccrual = () =>
  expect(
    simnet.callPublicFn(
      "linear-kinked-ir-v1",
      "update-ir-params",
      [Cl.uint(0), Cl.uint(0), Cl.uint(0), Cl.uint(0)],
      governor
    ).result
  ).toBeOk(Cl.bool(true));

// One position, and a zero curve frozen before any position exists, so every bucket
// value is exact: the LP bucket holds the borrower's principal and nothing else.
const openZeroInterestMarket = async () => {
  init_pyth(deployer);
  set_pyth_time_delta(7200, deployer);
  set_allowed_contracts(deployer);
  set_asset_cap(deployer, 100_000_000_000_000n);
  initialize_ir(deployer);
  initialize_staking_reward(deployer);
  initialize_lp(deployer);
  await set_initial_price("mock-usdc", 1n, deployer);
  await set_initial_price("mock-btc", 1n, deployer);
  expect(
    simnet.callPublicFn(
      "state-v1",
      "set-protocol-reserve-percentage",
      [Cl.uint(25_000_000n)],
      deployer
    ).result
  ).toBeOk(Cl.bool(true));
  update_supported_collateral("mock-btc", 80_000_000, 90_000_000, 10_000_000, 8, deployer);

  handOverGovernance();
  freezeInterestAccrual();

  mint_token("mock-usdc", 100_000_000_000, depositor);
  deposit(100_000_000_000, depositor);
  initialize_staking(deployer);
  expect(
    simnet.callPublicFn("staking-v1", "stake", [Cl.uint(5_000_000_000)], depositor).result
  ).toBeOk(Cl.bool(true));

  mint_token("mock-btc", 20_000_000, victim);
  add_collateral("mock-btc", 20_000_000, deployer, victim);
  borrow(10_000_000, victim);
};

describe("bad-debt socialization keeps lp-part inside lp-open-interest", () => {
  beforeEach(async () => {
    await openZeroInterestMarket();
  });

  it("drives lp-part to exactly the whole LP bucket without underflowing", async () => {
    // The market holds one position only and its debt is the entire LP bucket, so
    // lp-part equals lp-open-interest exactly at the socialization call: one unit
    // more would abort the liquidation.
    const before = buckets();
    expect(before.lp).toBe(totalBorrowed(victim));
    expect(before.lp).toBeGreaterThan(0n);
    expect(before.staked + before.protocol, "no interest can have accrued").toBe(0n);
    expect(positionOf(victim)["borrowed-amount"].value).toBe(before.lp);

    simnet.mineEmptyBlocks(500);
    await set_price_without_scaling("mock-btc", 10_000_000n, deployer);
    mint_token("mock-usdc", 20_000_000, liquidator);

    const liquidation = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [Cl.buffer(build_price_update()), btc, Cl.principal(victim), Cl.uint(20_000_000), Cl.uint(0)],
      liquidator
    );
    expect(liquidation.result, "the boundary socialization must not revert").toBeOk(Cl.bool(true));

    const liquidateEvent = eventValue(liquidation.events as any[], "liquidate-collateral");
    const socializeEvent = eventValue(liquidation.events as any[], "socialized-bad-debt");
    expect(liquidateEvent, "the liquidation print").toBeDefined();
    expect(socializeEvent, "the position must reach socialization").toBeDefined();

    const repaid = liquidateEvent["repaid-amount"].value as bigint;
    const amount = socializeEvent["amount"].value as bigint;
    const lpPart = socializeEvent["lp-part"].value as bigint;
    const stakedPart = socializeEvent["staked-part"].value as bigint;
    const protocolPart = socializeEvent["protocol-part"].value as bigint;

    // Zero interest: the liquidation's own LP part is its principal part (= repaid),
    // so the LP bucket the socialization subtracts from is exactly this.
    const lpBucketAtSocialize = before.lp - repaid;
    expect(amount, "the socialized amount is the whole remaining debt").toBe(lpBucketAtSocialize);
    expect(lpPart, "lp-part must consume the LP bucket exactly, not less").toBe(lpBucketAtSocialize);
    expect(stakedPart).toBe(0n);
    expect(protocolPart).toBe(0n);

    // All four state-v1 subtractions landed on their exact terminal value.
    expect(buckets()).toStrictEqual({ lp: 0n, staked: 0n, protocol: 0n });
    expect(totalBorrowed(victim)).toBe(0n);
    expect(totalDebtShares()).toBe(0n);
    expect(positionOf(victim)["debt-shares"].value).toBe(0n);
  });
});

// Test-only caller: forwards arbitrary parts into state-v1's socialization, which is
// gated on is-allowed-contract. Deployed inside the test so the repo's real contracts
// stay untouched.
const PROBE = `;; test-only probe
(define-public (socialize (user principal) (amount uint) (lp-part uint) (staked-part uint) (protocol-part uint) (updated-total-borrowed-amount uint) (staking-contract principal) (staked-lp-tokens uint))
  (contract-call? .state-v1 socialize-user-bad-debt user amount lp-part staked-part protocol-part updated-total-borrowed-amount staking-contract staked-lp-tokens)
)`;

describe("state-v1::socialize-user-bad-debt bounds no part itself", () => {
  beforeEach(async () => {
    // Minimal live market; governance stays with the deployer so it can allow the probe.
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 100_000_000_000_000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);
    update_supported_collateral("mock-btc", 80_000_000, 90_000_000, 10_000_000, 8, deployer);
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);
    initialize_staking(deployer);
    mint_token("mock-btc", 20_000_000, victim);
    add_collateral("mock-btc", 20_000_000, deployer, victim);
    borrow(10_000_000, victim);

    const deployed = simnet.deployContract(
      "socialize-probe",
      PROBE,
      { clarityVersion: ClarityVersion.Clarity3 },
      deployer
    );
    expect(deployed.result.type, "the probe contract must deploy").not.toBe(
      ClarityType.ResponseErr
    );
    expect(
      simnet.callPublicFn(
        "state-v1",
        "set-allowed-contract",
        [Cl.contractPrincipal(deployer, "socialize-probe")],
        deployer
      ).result
    ).toBeOk(Cl.bool(true));
  });

  it("aborts on an oversized lp-part and leaves state untouched", () => {
    const before = buckets();
    const sharesBefore = totalDebtShares();
    const positionSharesBefore = positionOf(victim)["debt-shares"].value as bigint;
    expect(before.lp).toBeGreaterThan(0n);

    let error: any = null;
    try {
      simnet.callPublicFn(
        "socialize-probe",
        "socialize",
        [
          Cl.principal(victim),
          Cl.uint(1),
          Cl.uint(before.lp + 1n), // one above the bucket: the verification target
          Cl.uint(0),
          Cl.uint(0),
          Cl.uint(totalBorrowed(victim)),
          Cl.contractPrincipal(deployer, "staking-v1"),
          Cl.uint(0),
        ],
        depositor
      );
    } catch (e) {
      error = e;
    }

    const message = String(error?.message ?? error);
    expect(error, "an oversized lp-part must abort, not settle").not.toBeNull();
    expect(message, "the abort must be the uint subtraction in state-v1").toContain(
      "ArithmeticUnderflow"
    );
    expect(message).toContain("state-v1:socialize-user-bad-debt");

    // Atomic revert: nothing moved.
    expect(buckets()).toStrictEqual(before);
    expect(totalDebtShares()).toBe(sharesBefore);
    expect(positionOf(victim)["debt-shares"].value).toBe(positionSharesBefore);
  });

  it("settles when the caller passes exactly the bucket size", () => {
    const before = buckets();
    const probe = simnet.callPublicFn(
      "socialize-probe",
      "socialize",
      [
        Cl.principal(victim),
        Cl.uint(before.lp),
        Cl.uint(before.lp),
        Cl.uint(0),
        Cl.uint(0),
        Cl.uint(0),
        Cl.contractPrincipal(deployer, "staking-v1"),
        Cl.uint(0),
      ],
      depositor
    );
    expect(probe.result, "the exact-bucket part must settle").toBeOk(Cl.uint(0));
    expect(buckets().lp).toBe(0n);
    expect(totalBorrowed(victim)).toBe(0n);
  });
});
