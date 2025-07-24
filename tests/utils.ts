import { expect } from "vitest";
import { Cl, ClarityType, ClarityValue } from "@stacks/transactions";

export const scalingFactor = 100000000n;

export const update_supported_collateral = (
  collateral: string,
  max_ltv: number,
  liq_ltv: number,
  liq_discount: number,
  decimals: number,
  deployer: any
) => {
  const response = simnet.callPublicFn(
    "state-v1",
    "update-collateral-settings",
    [
      Cl.contractPrincipal(deployer, collateral),
      Cl.uint(max_ltv),
      Cl.uint(liq_ltv),
      Cl.uint(liq_discount),
      Cl.uint(decimals),
    ],
    deployer
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const update_supported_collateral_governance = (
  collateral: string,
  max_ltv: number,
  liq_ltv: number,
  liq_discount: number,
  deployer: any,
  governance_account: any
) => {
  const response = simnet.callPublicFn(
    "governance-v1",
    "initiate-proposal-to-update-collateral-settings",
    [
      Cl.contractPrincipal(deployer, collateral),
      Cl.uint(max_ltv),
      Cl.uint(liq_ltv),
      Cl.uint(liq_discount),
      Cl.uint(10),
    ],
    governance_account
  );
  expect(response.result.type).toBe(ClarityType.ResponseOk);
  const proposal_id = response.result.value.buffer;
  simnet.mineEmptyBlocks(21600);
  const res = simnet.callPublicFn(
    "governance-v1",
    "execute",
    [Cl.buffer(proposal_id)],
    governance_account
  );
  expect(res.result).toBeOk(Cl.bool(true));
};

export const mint_token = (token: string, amount: number, to: any) => {
  const response = simnet.callPublicFn(
    token,
    "mint",
    [Cl.uint(amount), Cl.principal(to)],
    to
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const transfer_token = (
  token: string,
  amount: number,
  from: any,
  to: ClarityValue
) => {
  const response = simnet.callPublicFn(
    token,
    "transfer",
    [Cl.uint(amount), Cl.principal(from), to, Cl.none()],
    from
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const mint_token_to_contract = (
  token: string,
  amount: number,
  contract: any,
  to: any
) => {
  const response = simnet.callPublicFn(
    token,
    "mint",
    [Cl.uint(amount), contract],
    to
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const deposit = (amount: number, user: any) => {
  const response = simnet.callPublicFn(
    "liquidity-provider-v1",
    "deposit",
    [Cl.uint(amount), Cl.principal(user)],
    user
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const borrow = (amount: number, user: any) => {
  const response = simnet.callPublicFn(
    "borrower-v1",
    "borrow",
    [Cl.none(), Cl.uint(amount), Cl.none()],
    user
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const repay = (amount: number, user: any) => {
  const response = simnet.callPublicFn(
    "borrower-v1",
    "repay",
    [Cl.uint(amount), Cl.none()],
    user
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const add_collateral = (
  collateral: string,
  amount: number,
  deployer: any,
  user: any
) => {
  const response = simnet.callPublicFn(
    "borrower-v1",
    "add-collateral",
    [Cl.contractPrincipal(deployer, collateral), Cl.uint(amount), Cl.none()],
    user
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const remove_collateral = (
  collateral: string,
  amount: number,
  deployer: any,
  user: any
) => {
  const response = simnet.callPublicFn(
    "borrower-v1",
    "remove-collateral",
    [
      Cl.none(),
      Cl.contractPrincipal(deployer, collateral),
      Cl.uint(amount),
      Cl.none(),
    ],
    user
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const initialize_ir = (deployer: any) => {
  const response = simnet.callPublicFn(
    "linear-kinked-ir-v1",
    "update-ir-params",
    [
      Cl.uint(750000000000), // 0.75
      Cl.uint(1500000000000), // 1.5
      Cl.uint(700000000000), // 0.7
      Cl.uint(300000000000), // 30%
    ],
    deployer
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const initialize_staking_reward = (deployer: any) => {
  const response = simnet.callPublicFn(
    "staking-reward-v1",
    "update-reward-params",
    [
      Cl.int(-50000000), // -0.5
      Cl.int(-70000000), // -0.7
      Cl.uint(70000000), // 0.7
      Cl.uint(30000000), // 30%
    ],
    deployer
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const set_allowed_contracts = (deployer: any) => {
  let contracts = [
    Cl.contractPrincipal(deployer, "liquidity-provider-v1"),
    Cl.contractPrincipal(deployer, "borrower-v1"),
    Cl.contractPrincipal(deployer, "liquidator-v1"),
    Cl.contractPrincipal(deployer, "staking-v1"),
    Cl.contractPrincipal(deployer, "test-gifter"),
    Cl.contractPrincipal(deployer, "flash-loan-v1"),
  ];
  contracts.forEach((contract) => {
    const response = simnet.callPublicFn(
      "state-v1",
      "set-allowed-contract",
      [contract],
      deployer
    );
    expect(response.result).toBeOk(Cl.bool(true));
  });
};

export const set_asset_cap = (deployer: any, cap: bigint) => {
  const response = simnet.callPublicFn(
    "state-v1",
    "update-asset-cap",
    [Cl.uint(cap)],
    deployer
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const initialize_governance = (
  governance: string,
  guardian: string,
  deployer: any
) => {
  let governance_accounts = [
    Cl.some(Cl.principal(governance)),
    Cl.none(),
    Cl.none(),
    Cl.none(),
    Cl.none(),
  ];
  let response = simnet.callPublicFn(
    "meta-governance-v1",
    "initialize-governance",
    [Cl.list(governance_accounts)],
    deployer
  );
  expect(response.result).toBeOk(Cl.bool(true));

  let guardian_accounts = [
    Cl.some(Cl.principal(guardian)),
    Cl.none(),
    Cl.none(),
    Cl.none(),
    Cl.none(),
  ];
  response = simnet.callPublicFn(
    "governance-v1",
    "initialize-governance",
    [Cl.list(guardian_accounts)],
    deployer
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const state_set_governance_contract = (deployer: any) => {
  const governance_contract = Cl.contractPrincipal(deployer, "governance-v1");
  const response = simnet.callPublicFn(
    "state-v1",
    "update-governance",
    [governance_contract],
    deployer
  );
  expect(response.result).toBeOk(Cl.bool(true));
};

export const deposit_and_borrow = (
  deposit_amount: number,
  depositor: string,
  collateral_amount: number,
  borrow_amount: number,
  borrower: string,
  deployer: any
) => {
  mint_token("mock-usdc", deposit_amount, depositor);
  deposit(deposit_amount, depositor);

  /* borrower flow */
  update_supported_collateral(
    "mock-btc",
    70000000,
    80000000,
    10000000,
    8,
    deployer
  );
  mint_token("mock-btc", collateral_amount, borrower);
  add_collateral("mock-btc", collateral_amount, deployer, borrower);
  let contractBalance = simnet.callReadOnlyFn(
    "mock-btc",
    "get-balance",
    [Cl.contractPrincipal(deployer, "state-v1")],
    borrower
  );
  expect(contractBalance.result.value.value).toBe(BigInt(collateral_amount));

  const borrow = simnet.callPublicFn(
    "borrower-v1",
    "borrow",
    [Cl.none(), Cl.uint(borrow_amount), Cl.none()],
    borrower
  );
  expect(borrow.result).toBeOk(Cl.bool(true));

  const userBalancePostBorrow = simnet.callReadOnlyFn(
    "mock-usdc",
    "get-balance",
    [Cl.principal(borrower)],
    borrower
  );
  expect(userBalancePostBorrow.result.value.value).toBe(BigInt(borrow_amount));
};

export const expectUserUSDCBalance = (
  user: ClarityValue,
  amount: bigint,
  deployer: any
) => {
  expect(getUserBalance(user, "mock-usdc", deployer)).toBe(amount);
};

export const expectUserBTCBalance = (
  user: ClarityValue,
  amount: bigint,
  deployer: any
) => {
  expect(getUserBalance(user, "mock-btc", deployer)).toBe(amount);
};

export const getUserBalance = (
  user: ClarityValue,
  token: string,
  deployer: any
) => {
  const result = simnet.callReadOnlyFn(token, "get-balance", [user], deployer);

  return result.result.value.value;
};

export const expectUserBalance = (
  user: ClarityValue,
  amount: bigint,
  token: string,
  deployer: any
) => {
  expect(getUserBalance(user, token, deployer)).toBe(amount);
};
