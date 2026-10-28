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
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const depositor = accounts.get("wallet_1")!;
const borrower = accounts.get("wallet_2")!;
const btc = contractPrincipalCV(deployer, "mock-btc");

const SCALING = 100_000_000n;
const DEBT_CAP_FACTOR = 20_000_000n;
const USDC = 100_000_000n; // simnet mock-usdc has 8 decimals
const REPAY = 100n * USDC;

const ro = (contract: string, fn: string, args: any[] = []) =>
  simnet.callReadOnlyFn(contract, fn, args, deployer).result as any;

const txOk = (res: any) => expect(res.result).toBeOk(Cl.bool(true));

// Immunefi 97070: execute-liquidation updated state (raising borrowable-balance by the
// repayment) before withdrawal-caps.repay, so the debt-cap max was computed from the
// post-repayment balance and the repayment was then credited again as inflow.
describe("Immunefi 97070: liquidation debt-cap ordering", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 2n ** 128n - 1n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);

    txOk(
      simnet.callPublicFn(
        "withdrawal-caps-v1",
        "set-debt-cap",
        [Cl.uint(DEBT_CAP_FACTOR)],
        deployer
      )
    );
    txOk(
      simnet.callPublicFn(
        "withdrawal-caps-v1",
        "set-lp-cap",
        [Cl.uint(20_000_000)],
        deployer
      )
    );
    txOk(
      simnet.callPublicFn(
        "withdrawal-caps-v1",
        "set-refill-time-window",
        [Cl.uint(36_000)],
        deployer
      )
    );
    txOk(
      simnet.callPublicFn(
        "withdrawal-caps-v1",
        "set-decay-time-window",
        [Cl.uint(10_800)],
        deployer
      )
    );
    txOk(
      simnet.callPublicFn(
        "state-v1",
        "set-protocol-reserve-percentage",
        [Cl.uint(25_000_000)],
        deployer
      )
    );
  });

  it("caps the debt bucket on the pre-repayment balance, not the post-repayment one", () => {
    mint_token("mock-usdc", Number(100_000n * USDC), depositor);
    deposit(Number(100_000n * USDC), depositor);

    update_supported_collateral(
      "mock-btc",
      70_000_000,
      80_000_000,
      10_000_000,
      8,
      deployer
    );
    mint_token("mock-btc", Number(2_000n * USDC), borrower);
    add_collateral("mock-btc", Number(2_000n * USDC), deployer, borrower);
    borrow(Number(1_000n * USDC), borrower);

    // Lower the liquidation LTV below the debt ratio so the position is liquidatable.
    update_supported_collateral(
      "mock-btc",
      20_000_000,
      30_000_000,
      10_000_000,
      8,
      deployer
    );

    // Refill window is 36,000 s and simnet advances 600 s per block, so 8,000 blocks fills
    // the bucket to its ceiling; the post-liquidation value is then exactly max + inflow.
    simnet.mineEmptyBlocks(8_000);

    mint_token("mock-usdc", Number(REPAY), depositor);
    const borrowableBefore = ro("state-v1", "get-borrowable-balance").value as bigint;
    const intendedMax = (borrowableBefore * DEBT_CAP_FACTOR) / SCALING;

    const liquidation = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        btc,
        Cl.principal(borrower),
        Cl.uint(REPAY),
        Cl.uint(1),
      ],
      depositor
    );
    txOk(liquidation);

    const bucketAfter = ro("withdrawal-caps-v1", "get-debt-bucket").value as bigint;
    // The repayment is credited once as inflow. The refill component must be capped by the
    // balance read before the repayment, so the bucket is the intended cap + inflow, less at
    // most one block of decay of the freshly created excess between the sync and this read.
    expect(bucketAfter).toBeLessThanOrEqual(intendedMax + REPAY);
    expect(bucketAfter).toBeGreaterThanOrEqual(intendedMax + REPAY - (REPAY / 50n));
  });
});
