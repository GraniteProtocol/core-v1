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

// meta-governance-v1 membership + shim guardians + grant the shim the oracle roles it holds in production.
const setup = () => {
  simnet.callPublicFn(
    "meta-governance-v1",
    "initialize-governance",
    [Cl.list([Cl.some(Cl.principal(member)), Cl.none(), Cl.none(), Cl.none(), Cl.none()])],
    deployer
  );
  simnet.callPublicFn(
    SHIM,
    "initialize",
    [Cl.list([Cl.some(Cl.principal(guardian)), Cl.none(), Cl.none(), Cl.none(), Cl.none()])],
    deployer
  );
  simnet.callPublicFn(ORACLE, "set-role", [shimPrincipal, ROLE_GOVERNANCE, Cl.bool(true)], deployer);
  simnet.callPublicFn(ORACLE, "set-role", [shimPrincipal, ROLE_PAUSE, Cl.bool(true)], deployer);
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
