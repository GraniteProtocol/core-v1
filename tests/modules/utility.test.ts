import { Cl, ClarityType } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  add_collateral,
  initialize_governance,
  initialize_ir,
  initialize_lp,
  initialize_staking_reward,
  mint_token,
  set_allowed_contracts,
  set_asset_cap,
  state_set_governance_contract,
  update_supported_collateral,
} from "../utils";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const borrower = accounts.get("wallet_2")!;

const SCALING_FACTOR = 100_000_000;
const ACTION_SET_REFILL_TIME_WINDOW = 33;
const ACTION_SET_DECAY_TIME_WINDOW = 34;
const BTC = Cl.contractPrincipal(deployer, "mock-btc");
const ETH = Cl.contractPrincipal(deployer, "mock-eth");
const STX = Cl.contractPrincipal(deployer, "stx-sip010");

const executeProposal = (response: any) => {
  const proposalId = response.result.value.value;
  simnet.mineEmptyBlocks(21600);
  const executed = simnet.callPublicFn(
    "governance-v1",
    "execute",
    [Cl.bufferFromHex(proposalId)],
    deployer
  );
  expect(executed.result).toBeOk(Cl.bool(true));
};

const read = (fn: string, args: any[]) =>
  simnet.callReadOnlyFn("utility", fn, args, deployer).result;

const tokenBalance = (token: string): bigint => {
  const response = simnet.callReadOnlyFn(
    token,
    "get-balance",
    [Cl.contractPrincipal(deployer, "state-v1")],
    deployer
  ).result;
  expect(response.type).toBe(ClarityType.ResponseOk);
  return (response as any).value.value as bigint;
};

describe("utility per-collateral reads", () => {
  beforeEach(() => {
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 2n ** 128n - 1n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    update_supported_collateral(
      "mock-eth",
      50000000,
      70000000,
      10000000,
      8,
      deployer
    );
  });

  it("reads sBTC balance and collateral config from state-v1", () => {
    const amount = 250_000_000;
    mint_token("mock-btc", amount, borrower);
    add_collateral("mock-btc", amount, deployer, borrower);

    expect(
      read("get-collateral-market-state", [
        BTC,
        Cl.uint(tokenBalance("mock-btc")),
      ])
    ).toBeOk(
      Cl.tuple({
        "collateral-token": BTC,
        "collateral-balance": Cl.uint(amount),
        "collateral-info": Cl.tuple({
          "max-ltv": Cl.uint(70000000),
          "liquidation-ltv": Cl.uint(80000000),
          "liquidation-premium": Cl.uint(10000000),
          decimals: Cl.uint(8),
        }),
      })
    );
  });

  it("reads a second SIP-010 collateral without being pinned to sBTC", () => {
    const amount = 123_450_000;
    mint_token("mock-eth", amount, borrower);
    add_collateral("mock-eth", amount, deployer, borrower);

    expect(
      read("get-collateral-market-state", [
        ETH,
        Cl.uint(tokenBalance("mock-eth")),
      ])
    ).toBeOk(
      Cl.tuple({
        "collateral-token": ETH,
        "collateral-balance": Cl.uint(amount),
        "collateral-info": Cl.tuple({
          "max-ltv": Cl.uint(50000000),
          "liquidation-ltv": Cl.uint(70000000),
          "liquidation-premium": Cl.uint(10000000),
          decimals: Cl.uint(8),
        }),
      })
    );
  });

  it("computes the sBTC bucket and keeps the non-collateral caps separate", () => {
    const capFactor = 0.8 * SCALING_FACTOR;
    const capResponse = simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-collateral-cap",
      [BTC, Cl.uint(capFactor)],
      deployer
    );
    expect(capResponse.result).toBeOk(Cl.bool(true));

    const amount = 100_000_000;
    mint_token("mock-btc", amount, borrower);
    add_collateral("mock-btc", amount, deployer, borrower);

    const inflow = 12_345_678;
    const combined = simnet.callReadOnlyFn(
      "utility",
      "get-withdrawal-caps",
      [Cl.uint(inflow)],
      deployer
    ).result;
    const perToken = read("get-collateral-withdrawal-caps", [
      BTC,
      Cl.uint(tokenBalance("mock-btc")),
      Cl.uint(inflow),
    ]);

    expect(perToken).toBeOk(
      Cl.tuple({
        "cap-factor": Cl.uint(80_000_000),
        "old-bucket": Cl.uint(100_000_000),
        "new-bucket": Cl.uint(112_345_678),
        "max-bucket": Cl.uint(80_000_000),
      })
    );
    expect(combined.type).toBe(ClarityType.ResponseOk);
    expect((combined as any).value.value.collateral).toBeUndefined();
  });

  it("errors u120004 for a token with no collateral config", () => {
    expect(read("get-collateral-market-state", [STX, Cl.uint(0)])).toBeErr(
      Cl.uint(120004)
    );
    expect(
      read("get-collateral-withdrawal-caps", [STX, Cl.uint(0), Cl.uint(0)])
    ).toBeErr(Cl.uint(120004));
  });

  it("adds the inflow on top of the computed bucket", () => {
    const amount = 100_000_000;
    mint_token("mock-btc", amount, borrower);
    add_collateral("mock-btc", amount, deployer, borrower);
    const capResponse = simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-collateral-cap",
      [BTC, Cl.uint(0.5 * SCALING_FACTOR)],
      deployer
    );
    expect(capResponse.result).toBeOk(Cl.bool(true));

    const withoutInflow = read("get-collateral-withdrawal-caps", [
      BTC,
      Cl.uint(tokenBalance("mock-btc")),
      Cl.uint(0),
    ]);
    const inflow = 777_000;
    const withInflow = read("get-collateral-withdrawal-caps", [
      BTC,
      Cl.uint(tokenBalance("mock-btc")),
      Cl.uint(inflow),
    ]);

    expect(withoutInflow).toBeOk(
      Cl.tuple({
        "cap-factor": Cl.uint(50_000_000),
        "old-bucket": Cl.uint(0),
        "new-bucket": Cl.uint(50_000_000),
        "max-bucket": Cl.uint(50_000_000),
      })
    );
    expect(withInflow).toBeOk(
      Cl.tuple({
        "cap-factor": Cl.uint(50_000_000),
        "old-bucket": Cl.uint(0),
        "new-bucket": Cl.uint(50_777_000),
        "max-bucket": Cl.uint(50_000_000),
      })
    );
  });

  it("reads a registered, funded second collateral end to end", () => {
    const capResponse = simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-collateral-cap",
      [ETH, Cl.uint(0.5 * SCALING_FACTOR)],
      deployer
    );
    expect(capResponse.result).toBeOk(Cl.bool(true));

    const amount = 400_000_000;
    mint_token("mock-eth", amount, borrower);
    add_collateral("mock-eth", amount, deployer, borrower);

    expect(
      read("get-collateral-withdrawal-caps", [
        ETH,
        Cl.uint(tokenBalance("mock-eth")),
        Cl.uint(0),
      ])
    ).toBeOk(
      Cl.tuple({
        "cap-factor": Cl.uint(50_000_000),
        "old-bucket": Cl.uint(400_000_000),
        "new-bucket": Cl.uint(400_000_000),
        "max-bucket": Cl.uint(200_000_000),
      })
    );

    simnet.mineEmptyBlocks(9);
    // 9 blocks -> 4,650s elapsed.
    expect(
      read("get-collateral-withdrawal-caps", [
        ETH,
        Cl.uint(tokenBalance("mock-eth")),
        Cl.uint(0),
      ])
    ).toBeOk(
      Cl.tuple({
        "cap-factor": Cl.uint(50_000_000),
        "old-bucket": Cl.uint(400_000_000),
        "new-bucket": Cl.uint(313_888_889),
        "max-bucket": Cl.uint(200_000_000),
      })
    );

    simnet.mineEmptyBlocks(20);
    // 29 blocks -> 16,650s elapsed, past the 10,800s decay window.
    expect(
      read("get-collateral-withdrawal-caps", [
        ETH,
        Cl.uint(tokenBalance("mock-eth")),
        Cl.uint(0),
      ])
    ).toBeOk(
      Cl.tuple({
        "cap-factor": Cl.uint(50_000_000),
        "old-bucket": Cl.uint(400_000_000),
        "new-bucket": Cl.uint(200_000_000),
        "max-bucket": Cl.uint(200_000_000),
      })
    );
  });

  it("clamps a refilled bucket at the maximum", () => {
    const capResponse = simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-collateral-cap",
      [ETH, Cl.uint(0.5 * SCALING_FACTOR)],
      deployer
    );
    expect(capResponse.result).toBeOk(Cl.bool(true));

    mint_token("mock-eth", 1_000_000, borrower);
    add_collateral("mock-eth", 1_000_000, deployer, borrower);

    // Liquidity above the actual balance makes max 50,000,000.
    const liquidity = 100_000_000;

    simnet.mineEmptyBlocks(20);
    // 20 blocks -> 11,250s elapsed, inside the 86,400s refill window.
    expect(
      read("get-collateral-withdrawal-caps", [ETH, Cl.uint(liquidity), Cl.uint(0)])
    ).toBeOk(
      Cl.tuple({
        "cap-factor": Cl.uint(50_000_000),
        "old-bucket": Cl.uint(1_000_000),
        "new-bucket": Cl.uint(7_510_416),
        "max-bucket": Cl.uint(50_000_000),
      })
    );

    simnet.mineEmptyBlocks(130);
    // 150 blocks -> 89,250s elapsed, past the 86,400s refill window.
    expect(
      read("get-collateral-withdrawal-caps", [ETH, Cl.uint(liquidity), Cl.uint(0)])
    ).toBeOk(
      Cl.tuple({
        "cap-factor": Cl.uint(50_000_000),
        "old-bucket": Cl.uint(1_000_000),
        "new-bucket": Cl.uint(50_000_000),
        "max-bucket": Cl.uint(50_000_000),
      })
    );
  });

  it("uses the governance-set refill and decay windows", () => {
    const capResponse = simnet.callPublicFn(
      "withdrawal-caps-v1",
      "set-collateral-cap",
      [ETH, Cl.uint(0.5 * SCALING_FACTOR)],
      deployer
    );
    expect(capResponse.result).toBeOk(Cl.bool(true));

    initialize_governance(deployer, deployer, deployer);
    state_set_governance_contract(deployer);

    let proposal = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_REFILL_TIME_WINDOW),
        Cl.tuple({ collateral: Cl.none(), factor: Cl.uint(22_500) }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(proposal.result.type).toBe(ClarityType.ResponseOk);
    executeProposal(proposal);

    proposal = simnet.callPublicFn(
      "governance-v1",
      "initiate-proposal-to-update-withdrawal-caps-param",
      [
        Cl.uint(ACTION_SET_DECAY_TIME_WINDOW),
        Cl.tuple({ collateral: Cl.none(), factor: Cl.uint(21_600) }),
        Cl.uint(1),
      ],
      deployer
    );
    expect(proposal.result.type).toBe(ClarityType.ResponseOk);
    executeProposal(proposal);

    expect(
      simnet.callReadOnlyFn(
        "withdrawal-caps-v1",
        "get-refill-time-window",
        [],
        deployer
      ).result.value
    ).toBe(22_500n);
    expect(
      simnet.callReadOnlyFn(
        "withdrawal-caps-v1",
        "get-decay-time-window",
        [],
        deployer
      ).result.value
    ).toBe(21_600n);

    mint_token("mock-eth", 400_000_000, borrower);
    add_collateral("mock-eth", 400_000_000, deployer, borrower);

    simnet.mineEmptyBlocks(20);
    // 20 blocks -> 11,380s elapsed.
    expect(
      read("get-collateral-withdrawal-caps", [
        ETH,
        Cl.uint(tokenBalance("mock-eth")),
        Cl.uint(0),
      ])
    ).toBeOk(
      Cl.tuple({
        "cap-factor": Cl.uint(50_000_000),
        "old-bucket": Cl.uint(400_000_000),
        "new-bucket": Cl.uint(294_629_630),
        "max-bucket": Cl.uint(200_000_000),
      })
    );

    expect(
      read("get-collateral-withdrawal-caps", [
        ETH,
        Cl.uint(2_000_000_000),
        Cl.uint(0),
      ])
    ).toBeOk(
      Cl.tuple({
        "cap-factor": Cl.uint(50_000_000),
        "old-bucket": Cl.uint(400_000_000),
        "new-bucket": Cl.uint(905_777_777),
        "max-bucket": Cl.uint(1_000_000_000),
      })
    );
  });
});
