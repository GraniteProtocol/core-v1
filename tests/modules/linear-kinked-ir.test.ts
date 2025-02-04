import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { state_set_governance_contract } from "../utils";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const address1 = accounts.get("wallet_1")!;

describe("linear kinked interest rate module update-ir-params tests", () => {
  it("calling update-ir-params once correctly working", () => {
    const slope1 = Cl.uint(750000000000); // 0.75
    const slope2 = Cl.uint(1500000000000); // 1.5
    const utilizationKink = Cl.uint(700000000000); // 0.7
    const baseIR = Cl.uint(5000000000); // 0.5%

    const constructorArgs = [slope1, slope2, utilizationKink, baseIR];
    const init = simnet.callPublicFn(
      "linear-kinked-ir-v1",
      "update-ir-params",
      constructorArgs,
      deployer
    );
    const res = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "get-ir-params",
      [],
      address1
    );
    const returnedBaseIR = res.result.data["base-ir"];
    expect(init.result).toBeOk(Cl.bool(true)); // SUCCESS code

    expect(returnedBaseIR).toStrictEqual(baseIR);
  });

  it("calling update-ir-params with invalid utilisation kink", () => {
    const slope1 = Cl.uint(750000000000); // 0.75
    const slope2 = Cl.uint(1500000000000); // 1.5
    const utilizationKink = Cl.uint(1000000000000); // 1
    const baseIR = Cl.uint(5000000000); // 0.5%

    const constructorArgs = [slope1, slope2, utilizationKink, baseIR];
    const init = simnet.callPublicFn(
      "linear-kinked-ir-v1",
      "update-ir-params",
      constructorArgs,
      deployer
    );
    expect(init.result).toBeErr(Cl.uint(70004));
  });

  it("calling update-ir-params from non launch prinicipal should fail as expected", () => {
    const slope1 = Cl.uint(750000000000); // 0.75
    const slope2 = Cl.uint(1500000000000); // 1.5
    const utilizationKink = Cl.uint(700000000000); // 0.7
    const baseIR = Cl.uint(5000000000); // 0.5%

    const constructorArgs = [slope1, slope2, utilizationKink, baseIR];
    const init = simnet.callPublicFn(
      "linear-kinked-ir-v1",
      "update-ir-params",
      constructorArgs,
      address1
    );

    expect(init.result).toBeErr(Cl.uint(70001)); // FAILURE code
  });

  it("calling update-ir-params twice failing as expected", () => {
    const slope1 = Cl.uint(750000000000); // 0.75
    const slope2 = Cl.uint(1500000000000); // 1.5
    const utilizationKink = Cl.uint(700000000000); // 0.7
    const baseIR = Cl.uint(5000000000); // 0.5%

    const constructorArgs = [slope1, slope2, utilizationKink, baseIR];
    let init = simnet.callPublicFn(
      "linear-kinked-ir-v1",
      "update-ir-params",
      constructorArgs,
      deployer
    );
    expect(init.result).toBeOk(Cl.bool(true)); // SUCCESS code

    state_set_governance_contract(deployer);

    init = simnet.callPublicFn(
      "linear-kinked-ir-v1",
      "update-ir-params",
      constructorArgs,
      deployer
    );
    expect(init.result).toBeErr(Cl.uint(70000)); // FAILURE code
  });
});

describe("linear kinked interest rate module tests", () => {
  beforeEach(() => {
    simnet.callPublicFn(
      "linear-kinked-ir-v1",
      "update-ir-params",
      [
        Cl.uint(750000000000), // 0.75
        Cl.uint(1500000000000), // 1.5
        Cl.uint(700000000000), // 0.7
        Cl.uint(5000000000), // 0.5%
      ],
      deployer
    );
  });

  it("utilization should be 0 when 0 open interest", () => {
    const totalAssets = Cl.uint(50000000000); // 500 * 10^8 = 500 usd
    const openInterest = Cl.uint(0);

    const args = [totalAssets, openInterest];
    const ur = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "utilization-calc",
      args,
      address1
    );

    expect(ur.result).toStrictEqual(Cl.uint(0));
  });

  it("utilization should be 100 when open interest is equal to total assets", () => {
    const totalAssets = Cl.uint(50000000000); // 500 * 10^8 = 500 usd
    const openInterest = Cl.uint(50000000000); // 500 * 10^8 = 500 usd

    const args = [totalAssets, openInterest];
    const ur = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "utilization-calc",
      args,
      address1
    );

    expect(ur.result).toStrictEqual(Cl.uint(1000000000000)); // 100 ^ 10^12
  });

  it("utilization should be more than 100 when open interest is greater than total assets", () => {
    const totalAssets = Cl.uint(50000000000); // 500 * 10^8 = 500 usd
    const openInterest = Cl.uint(70000000000); // 700 * 10^8 = 700 usd

    const args = [totalAssets, openInterest];
    const ur = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "utilization-calc",
      args,
      address1
    );

    expect(ur.result).toStrictEqual(Cl.uint(1400000000000)); // 140 ^ 10^12
  });

  it("interest rate with 0 utilization should be zero ir", () => {
    const totalAssets = Cl.uint(50000000000); // 500 * 10^8 = 500 usd
    const openInterest = Cl.uint(0);

    const args = [totalAssets, openInterest];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "get-ir",
      args,
      address1
    );

    expect(IR.result).toBeOk(Cl.uint(0));
  });

  it("interest rate with 100 utilization", () => {
    const totalAssets = Cl.uint(50000000000); // 500 * 10^8 = 500 usd
    const openInterest = Cl.uint(50000000000); // 500 usd

    // utilisation rate
    const args = [totalAssets, openInterest];
    const ur = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "utilization-calc",
      args,
      address1
    );
    expect(ur.result).toStrictEqual(Cl.uint(1000000000000)); // 100% = utilisation-kink

    // ((slope-1 * utilisation-kink) + (slope-2 * (utlisation - utilisation-kink))) + base_ir = ((0.75 * 0.7) + (1.5 * 0.3)) + (0.5%/100) = 0.97 * 10^12
    const interestRateArgs = [totalAssets, openInterest];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "get-ir",
      interestRateArgs,
      address1
    );
    expect(IR.result).toBeOk(Cl.uint(980000000000));
  });

  it("interest rate above 100 utilization", () => {
    const totalAssets = Cl.uint(50000000000); // 500 * 10^8 = 500 usd
    const openInterest = Cl.uint(70000000000); // 700 usd

    // utilisation rate
    const args = [totalAssets, openInterest];
    const ur = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "utilization-calc",
      args,
      address1
    );
    expect(ur.result).toStrictEqual(Cl.uint(1400000000000)); // 140% = utilisation-kink

    // ((slope-1 * utilisation-kink) + (slope-2 * (utlisation - utilisation-kink))) + base_ir = ((0.75 * 0.7) + (1.5 * 0.7)) + (0.5%/100) = 0.97 * 10^12
    const interestRateArgs = [totalAssets, openInterest];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "get-ir",
      interestRateArgs,
      address1
    );
    expect(IR.result).toBeOk(Cl.uint(1580000000000));
  });

  it("interest rate for utilization below kink percent correctly working", () => {
    const totalAssets = Cl.uint(50000000000); // 500 * 10^8 = 500 usd
    const openInterest = Cl.uint(34000000000); // 340 usd

    // utilisation rate
    const args = [totalAssets, openInterest];
    const ur = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "utilization-calc",
      args,
      address1
    );
    expect(ur.result).toStrictEqual(Cl.uint(680000000000)); // 68%

    const interestRateArgs = [totalAssets, openInterest];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "get-ir",
      interestRateArgs,
      address1
    );

    // (slope-1 * utilisation) + base_ir = (0.75 * 0.68) + (0.5%/100) = 0.515 * 10^12
    expect(IR.result).toBeOk(Cl.uint(515000000000));
  });

  it("interest rate for utilization equal to kink percent correctly working", () => {
    const totalAssets = Cl.uint(50000000000); // 500 * 10^8 = 500 usd
    const openInterest = Cl.uint(35000000000); // 350 usd

    // utilisation rate
    const args = [totalAssets, openInterest];
    const ur = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "utilization-calc",
      args,
      address1
    );
    expect(ur.result).toStrictEqual(Cl.uint(700000000000)); // 70% = utilisation-kink

    // ((slope-1 * utilisation-kink) + (slope-2 * (utlisation - utilisation-kink))) + base_ir = ((0.75 * 0.7) + (1.5 * 0)) + (0.5%/100) = 0.53 * 10^12
    const interestRateArgs = [totalAssets, openInterest];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "get-ir",
      interestRateArgs,
      address1
    );
    expect(IR.result).toBeOk(Cl.uint(530000000000));
  });

  it("interest rate for utilization above kink percent correctly working", () => {
    const totalAssets = Cl.uint(50000000000); // 500 * 10^8 = 500 usd
    const openInterest = Cl.uint(40000000000); // 400 usd

    // utilisation rate
    const args = [totalAssets, openInterest];
    const ur = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "utilization-calc",
      args,
      address1
    );
    expect(ur.result).toStrictEqual(Cl.uint(800000000000)); // 80% = utilisation-kink

    // ((slope-1 * utilisation-kink) + (slope-2 * (utlisation - utilisation-kink))) + base_ir = ((0.75 * 0.7) + (1.5 * 0.1)) + (0.5%/100) = 0.68 * 10^12
    const interestRateArgs = [totalAssets, openInterest];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "get-ir",
      interestRateArgs,
      address1
    );
    expect(IR.result).toBeOk(Cl.uint(680000000000));
  });

  it("calculate interest accrual with no elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(0);

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // 1*(1 + 0.15/31,536,000)^(31,536,000*(0/31,536,000)) = 100000000
    expect(IR.result).toBeOk(Cl.uint(1000000000000));
  });

  it("calculate interest accrual with one elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(6); // 6 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // ((1 + (0.15/365/24/60/60))^(6)) * 10^8 = 10,00,00,002.8538813125
    expect(IR.result).toBeOk(Cl.uint(1000000028538));
  });

  it("calculate interest accrual with 10 elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(60); // 60 seconds
    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // ((1 + (0.15/365/24/60/60))^(60)) * 10^8 = 10,00,00,028.5388167898
    expect(IR.result).toBeOk(Cl.uint(1000000285388));
  });

  it("calculate interest accrual with 100 elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(600); // 600 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // (((1 + (0.15/365/24/60/60))^(600)) - 1) * 100 = 0.0002853885344%
    // ((1 + (0.15/365/24/60/60))^(600)) * 10^8 = 10,00,00,285.3885344075
    expect(IR.result).toBeOk(Cl.uint(1000002853885));
  });

  it("calculate interest accrual with 500 elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(3000); // 3000 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // (((1 + (0.15/365/24/60/60))^(3000)) - 1) * 100 = 0.001426950817%
    // ((1 + (0.15/365/24/60/60))^(3000)) * 10^8 = 10,00,01,426.9508167221
    expect(IR.result).toBeOk(Cl.uint(1000014269508));
  });

  it("calculate interest accrual with 1000 elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(6000); // 6000 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // (((1 + (0.15/365/24/60/60))^(6000)) - 1) * 100 = 0.002853921995%
    // ((1 + (0.15/365/24/60/60))^(6000)) * 10^8 = 10,00,02,853.9219953306
    expect(IR.result).toBeOk(Cl.uint(1000028539219));
  });

  it("calculate interest accrual with 5000 elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(30000); // 30,000 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // (((1 + (0.15/365/24/60/60))^(30000)) - 1) * 100 = 0.01427042449%
    // ((1 + (0.15/365/24/60/60))^(30000)) * 10^8 = 10,00,14,270.4244869736
    expect(IR.result).toBeOk(Cl.uint(1000142704245));
  });

  it("calculate interest accrual with 10000 elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(60000); // 60,000 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // (((1 + (0.15/365/24/60/60))^(60000)) - 1) * 100 = 0.02854288542%
    // ((1 + (0.15/365/24/60/60))^(60000)) * 10^8 = 10,00,28,542.8854240976
    expect(IR.result).toBeOk(Cl.uint(1000285428854));
  });

  it("calculate interest accrual with 50000 elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(300000); // 3,00,000 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // (((1 + (0.15/365/24/60/60))^(300000)) - 1) * 100 = 0.14279592%
    // ((1 + (0.15/365/24/60/60))^(300000)) * 10^8 = 10,01,42,795.9200084235
    expect(IR.result).toBeOk(Cl.uint(1001427959203));
  });

  it("calculate interest accrual with 100000 elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(600000); // 6,00,000 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // (((1 + (0.15/365/24/60/60))^(600000)) - 1) * 100 = 0.2857957468%
    // ((1 + (0.15/365/24/60/60))^(600000)) * 10^8 = 10,02,85,795.7467645575
    expect(IR.result).toBeOk(Cl.uint(1002857957474));
  });

  it("calculate interest accrual with 1000000 elapsed blocks", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(6000000); // 60,00,000 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // (((1 + (0.15/365/24/60/60))^(6000000)) - 1) * 100 = 2.8949946403%
    // ((1 + (0.15/365/24/60/60))^(6000000)) * 10^8 = 10,28,94,994.6403122908
    expect(IR.result).toBeOk(Cl.uint(1028949946474));
  });

  it("calculate interest accrual with 26,28,000 elapsed blocks, 6 months", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(15768000); // 1,57,68,000 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // (((1 + (0.15/365/24/60/60))^(15768000)) - 1) * 100 = 7.7884150692%
    // ((1 + (0.15/365/24/60/60))^(15768000)) * 10^8 = 10,77,88,415.06923719489
    expect(IR.result).toBeOk(Cl.uint(1077884150881));
  });

  it("calculate interest accrual with 52,56,000 elapsed blocks, 1 year, APY", () => {
    const ir = Cl.uint(150000000000); // 15%
    const elapsedBlockTime = Cl.uint(31536000); // 3,15,36,000 seconds

    const args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );

    // (((1 + (0.15/365/24/60/60))^(31536000)) - 1) * 100 = 16.1834242314%
    // ((1 + (0.15/365/24/60/60))^(31536000)) * 10^8 = 11,61,83,424.2313816
    expect(IR.result).toBeOk(Cl.uint(1161834242383));
  });

  it("minimum interest rate for 1 block to acrcue", () => {
    const ir = Cl.uint(5000000000); // 0.5%
    const elapsedBlockTime = Cl.uint(6); // 6 seconds

    let args = [ir, elapsedBlockTime];
    const IR = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "compounded-interest",
      args,
      address1
    );
    expect(IR.result).toBeOk(Cl.uint(1000000000951));

    const open_ir = Cl.uint(100000000); // 1 USDC
    args = [Cl.uint(IR.result.value.value), open_ir];
    const interestFactor = simnet.callReadOnlyFn(
      "linear-kinked-ir-v1",
      "calc-total-interest",
      args,
      address1
    );
    expect(interestFactor.result).toStrictEqual(Cl.uint(1));
  });
});

describe("linear kinked interest rate window tests", () => {
  beforeEach(() => {
    simnet.callPublicFn(
      "linear-kinked-ir-v1",
      "update-ir-params",
      [
        Cl.uint(750000000000), // 0.75
        Cl.uint(1500000000000), // 1.5
        Cl.uint(700000000000), // 0.7
        Cl.uint(5000000000), // 0.5%
      ],
      deployer
    );
  });

  it("Max accrual windows for 10,000% APR", () => {
    const ir = Cl.uint(100000000000000); // 10,000%

    let elapsedBlocks = 1;
    for (let index = 0; ; index++) {
      elapsedBlocks += elapsedBlocks * 10;
      try {
        let args = [ir, Cl.uint(elapsedBlocks)];
        const IR = simnet.callReadOnlyFn(
          "linear-kinked-ir-v1",
          "compounded-interest",
          args,
          address1
        );

        const open_ir = Cl.uint(9900000000000000000n); // 99,00,00,00,000.00000000 USDC
        args = [Cl.uint(IR.result.value.value), open_ir];
        simnet.callReadOnlyFn(
          "linear-kinked-ir-v1",
          "calc-total-interest",
          args,
          address1
        );
      } catch (err) {
        console.log("Failed to accrue interest for window: ", elapsedBlocks);
        break;
      }
    }
  });

  it("Max accrual windows for 100,000% APR", () => {
    const ir = Cl.uint(1000000000000000); // 100,000%

    let elapsedBlocks = 1;
    for (let index = 0; ; index++) {
      elapsedBlocks += elapsedBlocks * 10;
      try {
        let args = [ir, Cl.uint(elapsedBlocks)];
        const IR = simnet.callReadOnlyFn(
          "linear-kinked-ir-v1",
          "compounded-interest",
          args,
          address1
        );

        const open_ir = Cl.uint(9900000000000000000n); // 99,00,00,00,000.00000000 USDC
        args = [Cl.uint(IR.result.value.value), open_ir];
        simnet.callReadOnlyFn(
          "linear-kinked-ir-v1",
          "calc-total-interest",
          args,
          address1
        );
      } catch (err) {
        console.log("Failed to accrue interest for window: ", elapsedBlocks);
        break;
      }
    }
  });
});
