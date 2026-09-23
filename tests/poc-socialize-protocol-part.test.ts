import { beforeEach, describe, expect, it } from "vitest";
import { Cl, contractPrincipalCV } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  initialize_ir,
  initialize_lp,
  initialize_staking_reward,
  mint_token,
  set_allowed_contracts,
  set_asset_cap,
  update_supported_collateral,
} from "./utils";
import {
  build_price_update,
  init_pyth,
  set_initial_price,
  set_price_without_scaling,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const depositor = accounts.get("wallet_4")!;
const borrower = accounts.get("wallet_1")!;
const liquidator = accounts.get("wallet_5")!;
const btc = contractPrincipalCV(deployer, "mock-btc");
const stateContract = Cl.contractPrincipal(deployer, "state-v1");

// live USDCx / sBTC collateral settings, not the 70/80/10 repo default
const MAX_LTV = 50_000_000;
const LIQUIDATION_LTV = 65_000_000;
const LIQUIDATION_PREMIUM = 10_000_000;
const PROTOCOL_RESERVE_PCT = 25_000_000;

// The three interest parts are floored independently and the lp-token round trip
// floors again, so the identity lands a handful of base units off rather than on 0.
const DUST = 10n;

const ro = (contract: string, fn: string, args: any[] = []) =>
  simnet.callReadOnlyFn(contract, fn, args, deployer).result as any;

// Market tokens held plus what borrowers still owe the LP and staker sides, against
// the claims on them. protocol-open-interest is absent because it is uncollected: it
// backs no claim until a repay converts it into reserve-balance.
const surplus = () => {
  const oi = ro("state-v1", "get-open-interest").value;
  const lp = ro("state-v1", "get-lp-params").value;
  return (
    (ro("mock-usdc", "get-balance", [stateContract]).value.value as bigint) +
    (oi["lp-open-interest"].value as bigint) +
    (oi["staked-open-interest"].value as bigint) -
    (lp["total-assets"].value as bigint) -
    (ro("state-v1", "get-reserve-balance").value as bigint)
  );
};

const protocolOpenInterest = () =>
  ro("state-v1", "get-open-interest").value["protocol-open-interest"].value as bigint;

describe("socializing bad debt", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 100_000_000_000_000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);
    expect(
      simnet.callPublicFn(
        "state-v1",
        "set-protocol-reserve-percentage",
        [Cl.uint(PROTOCOL_RESERVE_PCT)],
        deployer,
      ).result,
    ).toBeOk(Cl.bool(true));
  });

  it("writes off only what stakers and LPs are owed, not the protocol's interest", async () => {
    mint_token("mock-usdc", 10_000_000_000_000, depositor);
    deposit(10_000_000_000_000, depositor);
    update_supported_collateral(
      "mock-btc",
      MAX_LTV,
      LIQUIDATION_LTV,
      LIQUIDATION_PREMIUM,
      8,
      deployer,
    );
    mint_token("mock-btc", 10_000_000_000_000, borrower);
    add_collateral("mock-btc", 10_000_000_000_000, deployer, borrower);
    borrow(5_000_000_000_000, borrower);
    expect(surplus(), "claims must match holdings on a freshly borrowed book").toBe(0n);

    for (let i = 0; i < 2; i++) {
      simnet.mineEmptyBlocks(3_000);
      expect(
        simnet.callPublicFn("borrower-v1", "repay", [Cl.uint(1), Cl.none()], borrower).result,
      ).toBeOk(Cl.bool(true));
    }
    expect(
      protocolOpenInterest(),
      "protocol interest must have accrued or the write-off has nothing to double-count",
    ).toBeGreaterThan(0n);

    await set_price_without_scaling("mock-btc", 50_000_000n, deployer);
    mint_token("mock-usdc", 20_000_000_000_000, liquidator);
    const liquidation = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        btc,
        Cl.principal(borrower),
        Cl.uint(20_000_000_000_000),
        Cl.uint(0),
      ],
      liquidator,
    );
    expect(liquidation.result).toBeOk(Cl.bool(true));

    const event = liquidation.events.find(
      (e: any) => e.data?.value?.value?.["action"]?.value === "socialized-bad-debt",
    );
    expect(event, "the position must have reached socialization").toBeDefined();
    const protocolPart = (event as any).data.value.value["protocol-part"].value as bigint;
    expect(protocolPart, "protocol-part must be non-zero for this scenario to bite").toBeGreaterThan(
      0n,
    );

    const stranded = surplus();
    expect(
      stranded,
      `socialization stranded market tokens no claim points at (protocol-part ${protocolPart})`,
    ).toBeLessThanOrEqual(DUST);
    expect(stranded, "socialization wrote claims down past the tokens backing them").toBeGreaterThanOrEqual(
      0n,
    );
  });
});
