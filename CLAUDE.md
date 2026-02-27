# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Granite Protocol V1 — a decentralized, non-custodial lending market on Stacks (Bitcoin L2). Smart contracts are written in **Clarity 3** (epoch 3.0). Tests use **Vitest** with the **Clarinet SDK** simnet environment.

## Commands

```bash
# Check contract syntax
clarinet check

# Run all tests
npm test

# Run a single test file
npx vitest run tests/borrower.test.ts

# Run tests matching a pattern
npx vitest run -t "should fail adding unsupported collateral"

# Run tests with coverage and cost reports
npm run test:report

# Watch mode (rerun on file changes)
npm run test:watch
```

## Architecture

### Contract Layer Separation

The protocol uses a **logic/state split**:

- **`state-v1.clar`** — Immutable state contract. Holds all protocol data (positions, collaterals, balances, LP token, permissioning flags). Logic contracts call into state to read/write. Only contracts in the `allowed-contracts` map can mutate state.
- **Logic contracts** (`borrower-v1`, `liquidity-provider-v1`, `liquidator-v1`, `staking-v1`, `flash-loan-v1`) — Contain business logic, call state for reads/writes. These are upgradable by deploying new versions and updating the allowed contracts list.

### Key Contracts

| Contract | Error Range | Role |
|---|---|---|
| `state-v1` | u100–u116 | Protocol state, LP token, permissioning |
| `liquidity-provider-v1` | u10000+ | Deposit/withdraw liquidity |
| `borrower-v1` | u20000+ | Borrow, repay, add/remove collateral |
| `liquidator-v1` | u30000+ | Permissionless liquidations |
| `governance-v1` | u40000+ | Guardian multisig proposals with time-lock |
| `meta-governance-v1` | u50000+ | Top-level governance multisig |
| `staking-v1` | u60000+ | LP token staking with delayed withdrawals |
| `linear-kinked-ir-v1` | u70000+ | Interest rate model (kinked curve) |
| `pyth-adapter-v1` | u80000+ | Pyth oracle price feed adapter |
| `staking-reward-v1` | u90000+ | Staking reward distribution model |
| `lp-incentives-v2` | u100000+ | LP incentive epochs and snapshot rewards |
| `flash-loan-v1` | u110001+ | Flash loans with callback trait |
| `withdrawal-caps-v1` | u120000+ | Withdrawal/debt/collateral cap checks |
| `stx-claim` | u130001+ | STX reward claims |

### Modules (`contracts/modules/`)

Shared utility contracts: `math-v1` (arithmetic helpers), `pyth-adapter-v1` (oracle integration), `linear-kinked-ir-v1` (interest rate model), `staking-reward-v1`, `withdrawal-caps-v1`, `utility` (read-only view helpers).

### Constants

`constants-v1.clar` defines base constants (scaling factor = 1e8, block time, market token decimals). `constants-v2.clar` extends with price decimals/scaling factor, delegating to v1. Logic contracts reference constants via contract calls.

### Governance

Two-tier multisig system:
- **`meta-governance-v1`** — Top-level. Can replace governance contract, freeze upgrades on state.
- **`governance-v1`** — Guardian multisig. Proposals with 21600-block voting period + time-lock. Controls collateral settings, pause flags, allowed contracts, reserve management, IR params.

### Oracle Integration

Pyth Network oracle via a git submodule at `contracts/pyth/` (stacks-pyth-bridge). `pyth-adapter-v1` wraps Pyth to read prices with staleness checks and confidence ratio validation.

### Test Contracts (`contracts/test/`)

Mock tokens (`mock-btc`, `mock-eth`, `mock-usdc`), `mock-oracle`, `faucet`, `borrower-proxy`, `mock-flash-loan-callback`, `mock-liquidator-with-flash-loan`. Only used in tests.

## Testing Patterns

- Tests use a global `simnet` object provided by the Clarinet vitest environment.
- `tests/utils.ts` has shared helpers: `deposit`, `borrow`, `repay`, `add_collateral`, `mint_token`, `set_allowed_contracts`, `initialize_ir`, etc.
- `tests/pyth.ts` has Pyth oracle initialization helpers (`init_pyth`, `set_initial_price`, `set_price`).
- Every test file's `beforeEach` initializes Pyth, sets allowed contracts, configures IR params, and sets mock prices.
- Test accounts: `deployer`, `wallet_1` through `wallet_8` from `simnet.getAccounts()`.
- Custom Clarity matchers: `toBeOk()`, `toBeErr()`, `toBeUint()`, etc. from clarinet-sdk.

## Deployment

Deployment plans are YAML files in `deployments/`. They define ordered batches of contract publishes for mainnet/staging. Contracts are deployed to multiple Stacks addresses (deployer addresses vary per contract).

## Clarity Conventions

- All contracts use Clarity version 3, epoch 3.0.
- Scaling factor is `u100000000` (1e8) for fixed-point arithmetic.
- Error codes are namespaced per contract (see table above). New contracts should use the next available range.
- State mutations go through `state-v1`; logic contracts must be in the allowed-contracts list.
- Interest accrual (`accrue-interest`) is called at the start of most public functions in logic contracts.
