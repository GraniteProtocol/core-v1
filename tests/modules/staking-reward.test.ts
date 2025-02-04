import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { state_set_governance_contract } from "../utils";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const address1 = accounts.get("wallet_1")!;

describe("update-reward-params tests", () => {
  it("calling update-reward-params once correctly working", () => {
    const slope1 = Cl.int(-75000000); // -0.75
    const slope2 = Cl.int(-150000000); // -1.5
    const utilizationKink = Cl.uint(70000000); // 0.7
    const baseReward = Cl.uint(50000000); // 0.5%

    const constructorArgs = [slope1, slope2, utilizationKink, baseReward];
    const init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      constructorArgs,
      deployer
    );
    expect(init.result).toBeOk(Cl.bool(true)); // SUCCESS code

    const res = simnet.callReadOnlyFn(
      "staking-reward-v1",
      "get-reward-params",
      [],
      address1
    );
    const returnedBaseIR = res.result.data["base-reward"];
    expect(returnedBaseIR).toStrictEqual(baseReward);
  });

  it("calling update-reward-params with invalid utilisation kink", () => {
    const slope1 = Cl.int(-75000000); // -0.75
    const slope2 = Cl.int(-150000000); // -1.5
    const utilizationKink = Cl.uint(1000000000000); // 1
    const baseReward = Cl.uint(50000000); // 0.5%

    const constructorArgs = [slope1, slope2, utilizationKink, baseReward];
    const init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      constructorArgs,
      deployer
    );
    expect(init.result).toBeErr(Cl.uint(90004));
  });

  it("calling update-reward-params with invalid slopes kink", () => {
    const slope1 = Cl.int(-75000000); // -0.75
    const slope2 = Cl.int(-65000000); // -0.65
    const utilizationKink = Cl.uint(70000000); // 0.7
    const baseReward = Cl.uint(50000000); // 0.5%

    const constructorArgs = [slope1, slope2, utilizationKink, baseReward];
    const init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      constructorArgs,
      deployer
    );
    expect(init.result).toBeErr(Cl.uint(90005));
  });

  it("calling update-rewards-params from non launch prinicipal should fail as expected", () => {
    const slope1 = Cl.int(-75000000); // -0.75
    const slope2 = Cl.int(-150000000); // -1.5
    const utilizationKink = Cl.uint(70000000); // 0.7
    const baseReward = Cl.uint(50000000); // 0.5%

    const constructorArgs = [slope1, slope2, utilizationKink, baseReward];
    const init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      constructorArgs,
      address1
    );

    expect(init.result).toBeErr(Cl.uint(90001)); // FAILURE code
  });

  it("calling update-rewards-params twice failing as expected", () => {
    const slope1 = Cl.int(-75000000); // -0.75
    const slope2 = Cl.int(-150000000); // -1.5
    const utilizationKink = Cl.uint(70000000); // 0.7
    const baseReward = Cl.uint(50000000); // 0.5%

    const constructorArgs = [slope1, slope2, utilizationKink, baseReward];
    let init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      constructorArgs,
      deployer
    );
    expect(init.result).toBeOk(Cl.bool(true)); // SUCCESS code

    state_set_governance_contract(deployer);

    init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      constructorArgs,
      deployer
    );
    expect(init.result).toBeErr(Cl.uint(90000)); // FAILURE code
  });
});

describe("staking reward module tests", () => {
  beforeEach(() => {
    simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      [
        Cl.int(-50000000), // -0.5
        Cl.int(-70000000), // -0.7
        Cl.uint(70000000), // 0.7
        Cl.uint(50000000), // 0.5%
      ],
      deployer
    );
  });

  it("reward percentage should be zero when staking percentage is zero", () => {
    const stakedLpTokens = Cl.uint(0);
    const totalLpTokens = Cl.uint(50000000000); // 500 * 10^8 = 500 lp-tokens

    const args = [stakedLpTokens, totalLpTokens];
    const reward = simnet.callReadOnlyFn(
      "staking-reward-v1",
      "get-staking-reward-percentage",
      args,
      address1
    );

    expect(reward.result).toBeOk(Cl.uint(0));
  });

  it("reward percentage should be zero when staking percentage is 100%", () => {
    const stakedLpTokens = Cl.uint(50000000000);
    const totalLpTokens = Cl.uint(50000000000); // 500 * 10^8 = 500 lp-tokens

    const args = [stakedLpTokens, totalLpTokens];
    const reward = simnet.callReadOnlyFn(
      "staking-reward-v1",
      "get-staking-reward-percentage",
      args,
      address1
    );

    expect(reward.result).toBeOk(Cl.uint(0));
  });

  it("reward percentage before kink", () => {
    const stakedLpTokens = Cl.uint(20000000000);
    const totalLpTokens = Cl.uint(50000000000); // 500 * 10^8 = 500 lp-tokens

    const args = [stakedLpTokens, totalLpTokens];
    const reward = simnet.callReadOnlyFn(
      "staking-reward-v1",
      "get-staking-reward-percentage",
      args,
      address1
    );

    expect(reward.result).toBeOk(Cl.uint(30000000)); // 0.3%
  });

  it("reward percentage after kink", () => {
    const stakedLpTokens = Cl.uint(40000000000);
    const totalLpTokens = Cl.uint(50000000000); // 500 * 10^8 = 500 lp-tokens

    const args = [stakedLpTokens, totalLpTokens];
    const reward = simnet.callReadOnlyFn(
      "staking-reward-v1",
      "get-staking-reward-percentage",
      args,
      address1
    );

    expect(reward.result).toBeOk(Cl.uint(8000000)); // 0.08%
  });
});
