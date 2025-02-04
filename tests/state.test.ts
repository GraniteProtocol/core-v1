import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { init_pyth } from "./pyth";

const accounts = simnet.getAccounts();
const user = accounts.get("wallet_1")!;
const deployer = accounts.get("deployer")!;

describe("State governance tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
  });

  it("should successfully update governance principal", async () => {
    let governance = simnet.callReadOnlyFn(
      "state-v1",
      "get-governance",
      [],
      deployer
    );
    expect(governance.result).toStrictEqual(Cl.principal(deployer));

    // make "user" the new governance
    simnet.callPublicFn(
      "state-v1",
      "update-governance",
      [Cl.principal(user)],
      deployer
    );

    governance = simnet.callReadOnlyFn(
      "state-v1",
      "get-governance",
      [],
      deployer
    );
    expect(governance.result).toStrictEqual(Cl.principal(user));

    // "deployer" is not the governance anymore
    const response = simnet.callPublicFn(
      "state-v1",
      "update-governance",
      [Cl.principal(user)],
      deployer
    );
    expect(response.result).toBeErr(Cl.uint(100));
  });

  it("should fail adding a collateral if not governance", async () => {
    const response = simnet.callPublicFn(
      "state-v1",
      "update-collateral-settings",
      [
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(1),
        Cl.uint(1),
        Cl.uint(1),
        Cl.uint(1),
      ],
      user
    );
    expect(response.result).toBeErr(Cl.uint(100));
  });
});
