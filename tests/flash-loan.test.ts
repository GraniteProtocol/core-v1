import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityValue } from "@stacks/transactions";
import {
  deposit,
  set_allowed_contracts,
  initialize_ir,
  mint_token,
  set_asset_cap,
  initialize_staking_reward,
} from "./utils";

const accounts = simnet.getAccounts();
const depositor = accounts.get("wallet_1")!;
const user1 = accounts.get("wallet_2")!;
const deployer = accounts.get("deployer")!;
const callbackContract = Cl.contractPrincipal(
  deployer,
  "mock-flash-loan-callback"
);

const getUserUSDCBalance = (user: ClarityValue) => {
  const result = simnet.callReadOnlyFn(
    "mock-usdc",
    "get-balance",
    [user],
    deployer
  );

  return result.result.value.value;
};

const expectUserUSDCBalance = (user: ClarityValue, amount: bigint) => {
  expect(getUserUSDCBalance(user)).toBe(amount);
};

const setCallbackAllowed = () => {
  const result = simnet.callPublicFn(
    "flash-loan-v1",
    "set-allowed-contract",
    [callbackContract],
    deployer
  );

  expect(result.result).toBeOk(Cl.bool(true));
};

const setCallbackResult = (res: ClarityValue) => {
  const result = simnet.callPublicFn(
    "mock-flash-loan-callback",
    "set-result",
    [res],
    deployer
  );

  expect(result.result).toBeOk(Cl.bool(true));
};

describe("Flash loan tests", () => {
  beforeEach(async () => {
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n); // 100k USDC
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
  });

  it("Disallow not allowed contracts", async () => {
    const amount = 100000 * Math.pow(10, 8);
    const res = simnet.callPublicFn(
      "flash-loan-v1",
      "flash-loan",
      [Cl.uint(amount), callbackContract, Cl.none()],
      user1
    );

    expect(res.result).toBeErr(Cl.uint(110000)); // ERR_CONTRACT_NOT_ALLOWED
  });

  it("Not enough USDC on state contract", async () => {
    const amount = 100000 * Math.pow(10, 8);
    setCallbackAllowed();

    const res = simnet.callPublicFn(
      "flash-loan-v1",
      "flash-loan",
      [Cl.uint(amount), callbackContract, Cl.none()],
      user1
    );

    expect(res.result).toBeErr(Cl.uint(1)); // Not enough balance
  });

  it("Successful flash loan", async () => {
    const amount = 100000 * Math.pow(10, 8);
    setCallbackAllowed();

    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);

    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      BigInt(amount)
    );

    const expectedFee = 10 * Math.pow(10, 8); // 0.01% of 100k
    mint_token("mock-usdc", expectedFee, user1);
    expectUserUSDCBalance(Cl.principal(user1), BigInt(expectedFee));

    const res = simnet.callPublicFn(
      "flash-loan-v1",
      "flash-loan",
      [Cl.uint(amount), callbackContract, Cl.none()],
      user1
    );

    expect(res.result).toBeOk(Cl.bool(true));

    const totalBalanceWithFee = amount + expectedFee;
    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      BigInt(totalBalanceWithFee)
    );

    expectUserUSDCBalance(Cl.principal(user1), BigInt(0));
  });

  it("Failed flash loan callback", async () => {
    const amount = 100000 * Math.pow(10, 8);
    setCallbackAllowed();
    setCallbackResult(Cl.error(Cl.uint(2000)));

    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);

    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      BigInt(amount)
    );

    const expectedFee = 10 * Math.pow(10, 8); // 0.01% of 100k
    mint_token("mock-usdc", expectedFee, user1);
    expectUserUSDCBalance(Cl.principal(user1), BigInt(expectedFee));

    const res = simnet.callPublicFn(
      "flash-loan-v1",
      "flash-loan",
      [Cl.uint(amount), callbackContract, Cl.none()],
      user1
    );

    expect(res.result).toBeErr(Cl.uint(2000)); // error from callback

    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      BigInt(amount)
    );

    expectUserUSDCBalance(Cl.principal(user1), BigInt(expectedFee));
  });

  it("Failed flash loan not enough fee to cover", async () => {
    const amount = 100000 * Math.pow(10, 8);
    setCallbackAllowed();

    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);

    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      BigInt(amount)
    );

    const expectedFee = 9 * Math.pow(10, 8); // 0.01% of 100k is 10
    mint_token("mock-usdc", expectedFee, user1);
    expectUserUSDCBalance(Cl.principal(user1), BigInt(expectedFee));

    const res = simnet.callPublicFn(
      "flash-loan-v1",
      "flash-loan",
      [Cl.uint(amount), callbackContract, Cl.none()],
      user1
    );

    expect(res.result).toBeErr(Cl.uint(1)); // error from token transfer

    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      BigInt(amount)
    );

    expectUserUSDCBalance(Cl.principal(user1), BigInt(expectedFee));
  });

  it("Successful flash loan with one unit fee", async () => {
    const amount = 10000;
    setCallbackAllowed();

    mint_token("mock-usdc", amount, depositor);
    deposit(amount, depositor);

    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      BigInt(amount)
    );

    const expectedFee = 1; // 0.01% of 10k
    mint_token("mock-usdc", expectedFee, user1);
    expectUserUSDCBalance(Cl.principal(user1), BigInt(expectedFee));

    const res = simnet.callPublicFn(
      "flash-loan-v1",
      "flash-loan",
      [Cl.uint(amount), callbackContract, Cl.none()],
      user1
    );

    expect(res.result).toBeOk(Cl.bool(true));
    const totalBalanceWithFee = amount + expectedFee;
    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      BigInt(totalBalanceWithFee)
    );

    expectUserUSDCBalance(Cl.principal(user1), BigInt(0));
  });
});
