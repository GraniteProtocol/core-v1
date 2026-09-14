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
    const returnedBaseIR = res.result.value["base-reward"];
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

  it("calling update-reward-params with a slope outside the magnitude bound", () => {
    const slope2 = Cl.int(-100000000); // -1, inside the bound and ordered below slope-1
    const utilizationKink = Cl.uint(70000000); // 0.7
    const baseReward = Cl.uint(50000000); // 0.5%

    let init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      [Cl.int(100000000000001), slope2, utilizationKink, baseReward],
      deployer
    );
    expect(
      init.result,
      "slope-1 above the magnitude bound must be rejected"
    ).toBeErr(Cl.uint(90005));

    init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      [slope2, Cl.int(-100000000000002), utilizationKink, baseReward],
      deployer
    );
    expect(
      init.result,
      "slope-2 below the magnitude bound must be rejected"
    ).toBeErr(Cl.uint(90005));
  });

  it("calling update-reward-params with a curve that exceeds 100% at the kink", () => {
    const slope1 = Cl.int(110000000); // 1.1, above the 100% mark
    const slope2 = Cl.int(-100000000); // -1
    const utilizationKink = Cl.uint(70000000); // 0.7
    const baseReward = Cl.uint(50000000); // 0.5%

    const constructorArgs = [slope1, slope2, utilizationKink, baseReward];
    const init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      constructorArgs,
      deployer
    );
    expect(
      init.result,
      "a curve reaching 127% at the kink must be rejected rather than clamped"
    ).toBeErr(Cl.uint(90008));
  });

  it("calling update-reward-params with a curve that exceeds 100% only at full stake", () => {
    const slope1 = Cl.int(100000000); // 1.0
    const slope2 = Cl.int(40000000); // 0.4, ordered below slope-1
    const utilizationKink = Cl.uint(10000000); // 0.1
    const baseReward = Cl.uint(55000000); // 0.55

    const constructorArgs = [slope1, slope2, utilizationKink, baseReward];
    const init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      constructorArgs,
      deployer
    );
    expect(
      init.result,
      "a curve reaching 101% at one-8 must be rejected even though it is only 65% at the kink"
    ).toBeErr(Cl.uint(90008));
  });

  it("calling update-reward-params with a curve that reaches exactly 100% at the kink", () => {
    const slope1 = Cl.int(100000000); // 1.0
    const slope2 = Cl.int(-100000000); // -1
    const utilizationKink = Cl.uint(70000000); // 0.7
    const baseReward = Cl.uint(30000000); // 0.3

    const constructorArgs = [slope1, slope2, utilizationKink, baseReward];
    const init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      constructorArgs,
      deployer
    );
    expect(
      init.result,
      "a curve reaching exactly 100% at the kink is safe and must be accepted, not rejected"
    ).toBeOk(Cl.bool(true));
  });

  it("calling update-reward-params with a kink above half and a curve that exceeds 100% only at full stake", () => {
    const slope1 = Cl.int(105000000); // 1.05, 99.5% at the kink
    const slope2 = Cl.int(50000000); // 0.5, ordered below slope-1
    const utilizationKink = Cl.uint(90000000); // 0.9, above half so the pre-kink carry dominates
    const baseReward = Cl.uint(5000000); // 0.05

    const constructorArgs = [slope1, slope2, utilizationKink, baseReward];
    const init = simnet.callPublicFn(
      "staking-reward-v1",
      "update-reward-params",
      constructorArgs,
      deployer
    );
    expect(
      init.result,
      "a curve reaching 104.5% at one-8 above a kink of 0.9 must be rejected"
    ).toBeErr(Cl.uint(90008));
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
