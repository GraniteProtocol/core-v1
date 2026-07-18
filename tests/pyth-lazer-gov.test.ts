import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { TEST_PUBKEY } from "./lazer";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const member = accounts.get("wallet_1")!; // meta-governance multisig member
const guardian = accounts.get("wallet_2")!;
const outsider = accounts.get("wallet_3")!; // not a governance member / guardian

const SHIM = "pyth-lazer-gov";
const ORACLE = "pyth-lazer-oracle";
const ROLE_GOVERNANCE = Cl.bufferFromHex("00");
const ROLE_PAUSE = Cl.bufferFromHex("01");
const FAR_FUTURE = 100_000_000_000n;
const TIMELOCK = 21600;

const shimPrincipal = Cl.contractPrincipal(deployer, SHIM);
const decoderPrincipal = Cl.contractPrincipal(deployer, "pyth-lazer-decoder-v1");

const proposalId = (res: any): Uint8Array => res.result.value.buffer;

const signers = (pubkey: Uint8Array) =>
  Cl.list([Cl.tuple({ pubkey: Cl.buffer(pubkey), "expires-at": Cl.uint(FAR_FUTURE) })]);

const initMetaGov = () =>
  simnet.callPublicFn(
    "meta-governance-v1",
    "initialize-governance",
    [Cl.list([Cl.some(Cl.principal(member)), Cl.none(), Cl.none(), Cl.none(), Cl.none()])],
    deployer
  );

// The deployer holds both oracle roles by default and grants them to the shim.
const grantShimRoles = () => {
  simnet.callPublicFn(ORACLE, "set-role", [shimPrincipal, ROLE_GOVERNANCE, Cl.bool(true)], deployer);
  simnet.callPublicFn(ORACLE, "set-role", [shimPrincipal, ROLE_PAUSE, Cl.bool(true)], deployer);
};

const guardianList = (...addrs: string[]) =>
  Cl.list([...addrs.map((a) => Cl.some(Cl.principal(a))), ...Array(5 - addrs.length).fill(Cl.none())]);

const initShim = (guardians = guardianList(guardian)) =>
  simnet.callPublicFn(SHIM, "initialize", [guardians], deployer);

// Deploy order: grant the shim its oracle roles, then initialize (which asserts it holds them).
const setup = () => {
  initMetaGov();
  grantShimRoles();
  initShim();
};

describe("pyth-lazer-gov instant actions", () => {
  beforeEach(setup);

  it("set-fee executes immediately for a single-member multisig", () => {
    const res = simnet.callPublicFn(SHIM, "initiate-proposal-to-set-fee", [Cl.uint(500), Cl.uint(10)], member);
    expect(res.result.type).toBe("ok");
    expect(simnet.callReadOnlyFn(ORACLE, "get-fee", [], deployer).result).toBeUint(500);
  });

  it("set-fee-recipient executes immediately", () => {
    simnet.callPublicFn(SHIM, "initiate-proposal-to-set-fee-recipient", [Cl.principal(outsider), Cl.uint(10)], member);
    expect(simnet.callReadOnlyFn(ORACLE, "get-fee-recipient", [], deployer).result).toBePrincipal(outsider);
  });

  it("set-trusted-signers executes immediately (stays callable while paused)", () => {
    simnet.callPublicFn(SHIM, "initiate-proposal-to-set-trusted-signers", [signers(TEST_PUBKEY), Cl.uint(10)], member);
    const got = simnet.callReadOnlyFn(ORACLE, "get-trusted-signers", [], deployer);
    expect(got.result).toBeList([Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(FAR_FUTURE) })]);
  });

  it("non-member cannot propose", () => {
    const res = simnet.callPublicFn(SHIM, "initiate-proposal-to-set-fee", [Cl.uint(500), Cl.uint(10)], outsider);
    expect(res.result.type).toBe("err"); // meta-governance rejects a non-member
  });
});

describe("pyth-lazer-gov timelocked actions", () => {
  beforeEach(setup);

  it("set-stale-threshold is time-locked: immediate execute fails, executes after the delay", () => {
    const res = simnet.callPublicFn(SHIM, "initiate-proposal-to-set-stale-threshold", [Cl.uint(3600), Cl.uint(50000)], member);
    const id = proposalId(res);
    // not applied yet
    expect(simnet.callReadOnlyFn(ORACLE, "get-stale-price-threshold", [], deployer).result).not.toBeUint(3600);
    expect(simnet.callPublicFn(SHIM, "execute", [Cl.buffer(id)], member).result).toBeErr(Cl.uint(140017)); // TIME-LOCKED
    simnet.mineEmptyBlocks(TIMELOCK);
    expect(simnet.callPublicFn(SHIM, "execute", [Cl.buffer(id)], member).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(ORACLE, "get-stale-price-threshold", [], deployer).result).toBeUint(3600);
  });

  it("set-role is time-locked and grants an oracle role after the delay", () => {
    const res = simnet.callPublicFn(
      SHIM,
      "initiate-proposal-to-set-role",
      [Cl.principal(outsider), ROLE_PAUSE, Cl.bool(true), Cl.uint(50000)],
      member
    );
    const id = proposalId(res);
    simnet.mineEmptyBlocks(TIMELOCK);
    expect(simnet.callPublicFn(SHIM, "execute", [Cl.buffer(id)], member).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(ORACLE, "has-role", [Cl.principal(outsider), ROLE_PAUSE], deployer).result).toBeBool(true);
  });

  it("set-decoder must run through execute-set-decoder with a matching decoder", () => {
    const res = simnet.callPublicFn(SHIM, "initiate-proposal-to-set-decoder", [decoderPrincipal, Cl.uint(50000)], member);
    const id = proposalId(res);
    simnet.mineEmptyBlocks(TIMELOCK);
    // the generic executor rejects the decoder action
    expect(simnet.callPublicFn(SHIM, "execute", [Cl.buffer(id)], member).result).toBeErr(Cl.uint(140000)); // INVALID-ACTION
    expect(
      simnet.callPublicFn(SHIM, "execute-set-decoder", [Cl.buffer(id), decoderPrincipal], member).result
    ).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(ORACLE, "get-decoder", [], deployer).result).toBePrincipal(`${deployer}.pyth-lazer-decoder-v1`);
  });
});

describe("pyth-lazer-gov guardian pause", () => {
  beforeEach(setup);

  it("guardian pauses and unpauses the oracle directly", () => {
    expect(simnet.callPublicFn(SHIM, "guardian-pause", [], guardian).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(ORACLE, "is-paused", [], deployer).result).toBeBool(true);
    expect(simnet.callPublicFn(SHIM, "guardian-unpause", [], guardian).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(ORACLE, "is-paused", [], deployer).result).toBeBool(false);
  });

  it("non-guardian cannot pause", () => {
    expect(simnet.callPublicFn(SHIM, "guardian-pause", [], outsider).result).toBeErr(Cl.uint(140001)); // NOT-GUARDIAN
  });
});

const ACTION_ADD_GUARDIAN = 6;
const ACTION_REMOVE_GUARDIAN = 7;

describe("pyth-lazer-gov guardian rotation", () => {
  beforeEach(setup);

  it("adds a guardian through a time-locked proposal", () => {
    const res = simnet.callPublicFn(
      SHIM,
      "initiate-proposal-to-update-guardian",
      [Cl.uint(ACTION_ADD_GUARDIAN), Cl.principal(outsider), Cl.uint(50000)],
      member
    );
    const id = proposalId(res);
    expect(simnet.callReadOnlyFn(SHIM, "is-guardian", [Cl.principal(outsider)], deployer).result).toBeErr(Cl.uint(140001));
    simnet.mineEmptyBlocks(TIMELOCK);
    expect(simnet.callPublicFn(SHIM, "execute", [Cl.buffer(id)], member).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(SHIM, "is-guardian", [Cl.principal(outsider)], deployer).result).toBeOk(Cl.bool(true));
  });

  it("removes a compromised guardian instantly", () => {
    const res = simnet.callPublicFn(
      SHIM,
      "initiate-proposal-to-update-guardian",
      [Cl.uint(ACTION_REMOVE_GUARDIAN), Cl.principal(guardian), Cl.uint(50000)],
      member
    );
    expect(res.result.type).toBe("ok"); // single-member multisig executes on propose
    expect(simnet.callReadOnlyFn(SHIM, "is-guardian", [Cl.principal(guardian)], deployer).result).toBeErr(Cl.uint(140001));
  });
});

describe("pyth-lazer-gov deployer handover", () => {
  beforeEach(setup);

  it("revokes the deployer's oracle roles through the shim after the time-lock", () => {
    // deployer still holds both roles after granting them to the shim
    expect(simnet.callReadOnlyFn(ORACLE, "has-role", [Cl.principal(deployer), ROLE_GOVERNANCE], deployer).result).toBeBool(true);

    const revoke = (role: any) => {
      const res = simnet.callPublicFn(
        SHIM,
        "initiate-proposal-to-set-role",
        [Cl.principal(deployer), role, Cl.bool(false), Cl.uint(50000)],
        member
      );
      const id = proposalId(res);
      simnet.mineEmptyBlocks(TIMELOCK);
      expect(simnet.callPublicFn(SHIM, "execute", [Cl.buffer(id)], member).result).toBeOk(Cl.bool(true));
    };
    revoke(ROLE_GOVERNANCE);
    revoke(ROLE_PAUSE);

    // deployer holds neither, the shim holds both
    expect(simnet.callReadOnlyFn(ORACLE, "has-role", [Cl.principal(deployer), ROLE_GOVERNANCE], deployer).result).toBeBool(false);
    expect(simnet.callReadOnlyFn(ORACLE, "has-role", [Cl.principal(deployer), ROLE_PAUSE], deployer).result).toBeBool(false);
    expect(simnet.callReadOnlyFn(ORACLE, "has-role", [shimPrincipal, ROLE_GOVERNANCE], deployer).result).toBeBool(true);
    expect(simnet.callReadOnlyFn(ORACLE, "has-role", [shimPrincipal, ROLE_PAUSE], deployer).result).toBeBool(true);
  });
});

describe("pyth-lazer-gov initialize guards", () => {
  it("fails when the shim has not been granted the oracle roles", () => {
    initMetaGov();
    expect(initShim().result).toBeErr(Cl.uint(140022)); // MISSING-ORACLE-ROLE
  });

  it("fails when no guardian is supplied", () => {
    initMetaGov();
    grantShimRoles();
    expect(initShim(guardianList()).result).toBeErr(Cl.uint(140023)); // NO-GUARDIANS
  });
});
