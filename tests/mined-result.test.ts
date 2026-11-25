import { describe, expect, it } from "vitest";
import { Cl, ClarityType, ClarityVersion, Pc } from "@stacks/transactions";
import { tx } from "@stacks/clarinet-sdk";
import { minedExecution, minedResult } from "./utils";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const user = accounts.get("wallet_1")!;

const BOOM = `(define-public (boom) (ok (/ u1 u0)))`;

describe("mined helpers", () => {
  it("throws for a rejected entry and returns the next entry's result", () => {
    const block = simnet.mineBlock([
      tx.transferSTX(0, user, deployer),
      tx.callPublicFn("mock-usdc", "mint", [Cl.uint(1), Cl.principal(deployer)], deployer),
    ]);

    expect(() => minedResult(block[0])).toThrow(/transaction rejected/);
    expect(minedResult(block[1])).toBeOk(Cl.bool(true));
  });

  it("returns the contract's (err ...) from an abort_by_response entry", () => {
    const block = simnet.mineBlock([
      tx.callPublicFn(
        "mock-usdc",
        "transfer",
        [Cl.uint(1), Cl.principal(user), Cl.principal(deployer), Cl.none()],
        user,
      ),
    ]);

    expect(block[0].status).toBe("included_failure");
    if (block[0].status === "included_failure") expect(block[0].kind).toBe("abort_by_response");
    expect(minedResult(block[0])).toBeErr(Cl.uint(1));
  });

  it("throws for a post-condition abort instead of returning its rolled-back result", () => {
    const postCondition = Pc.principal(deployer).willSendEq(1n).ft(`${deployer}.mock-usdc`, "mock-usdc");
    const block = simnet.mineBlock([
      tx.callPublicFn("mock-usdc", "mint", [Cl.uint(1), Cl.principal(user)], deployer, {
        postConditions: [postCondition],
      }),
    ]);

    expect(block[0].status).toBe("included_failure");
    if (block[0].status === "included_failure") expect(block[0].kind).toBe("abort_by_post_condition");
    expect(() => minedExecution(block[0])).toThrow(/abort_by_post_condition/);
  });

  it("throws for a runtime error entry", () => {
    const deployed = simnet.deployContract("mined-boom", BOOM, { clarityVersion: ClarityVersion.Clarity3 }, deployer);
    expect(deployed.result.type).not.toBe(ClarityType.ResponseErr);

    const block = simnet.mineBlock([tx.callPublicFn("mined-boom", "boom", [], deployer)]);
    expect(block[0].status).toBe("included_failure");
    if (block[0].status === "included_failure") expect(block[0].kind).toBe("runtime_error");
    expect(() => minedExecution(block[0])).toThrow(/runtime_error/);
  });
});