# Granite Protocol

This repository contains the Clarity smart contracts for Granite V1, the deployment scripts, and full test suite coverage.

## What is Granite

Granite is a decentralized, non-custodial lending market protocol that allows users to participate as either suppliers (LPs) or borrowers. Suppliers provide liquidity to the market and earn passive income, while borrowers can take loans using a variety of supported collaterals. It targets the [Stacks blockchain](https://www.stacks.co/), a Bitcoin L2.

## Features

- Single asset multi-collateral markets
- Junior and senior tranches for liquidity providers
- Multisig-based governance
- Upgradable logic and immutable state contracts
- Protocol reserve to backstop bad debt
- Permissionless liquidations

## Setup

### Install

Install [Clarinet](https://github.com/hirosystems/clarinet) and fork this repository, then run

```
npm install
```

to get the needed dependencies for testing.

### Run tests

Run

```bash
clarinet check
```

to check if the contract syntax is correct, then

```bash
npm test
```

to execute the tests.

## Licensing

The primary license for Granite Protocol is the Business Source License 1.1 (`BUSL-1.1`), see [`LICENSE`](./LICENSE).

## Deployed Contracts:

- constants-v1.clar: [https://explorer.hiro.so/txid/SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.constants-v1?chain=mainnet](https://explorer.hiro.so/txid/SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.constants-v1?chain=mainnet)
- constants-v2.clar: [https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.constants-v1?chain=mainnet](https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.constants-v2?chain=mainnet)
- borrower-v1.clar: [https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.borrower-v1?chain=mainnet](https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.borrower-v1?chain=mainnet)
- staking-v1.clar: [https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.staking-v1?chain=mainnet](https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.staking-v1?chain=mainnet)
- withdrawal-caps-v1.clar: [https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.withdrawal-caps-v1?chain=mainnet](https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.withdrawal-caps-v1?chain=mainnet)
- flash-loan-v1.clar: [https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.flash-loan-v1?chain=mainnet](https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.flash-loan-v1?chain=mainnet)
- governance-v1.clar: [https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.governance-v1?chain=mainnet](https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.governance-v1?chain=mainnet)
- liquidator-v1.clar: [https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.liquidator-v1?chain=mainnet](https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.liquidator-v1?chain=mainnet)
- liquidity-provider-v1.clar: [https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.liquidity-provider-v1?chain=mainnet](https://explorer.hiro.so/txid/SP3BJR4P3W2Y9G22HA595Z59VHBC9EQYRFWSKG743.liquidity-provider-v1?chain=mainnet)
- meta-governance-v1.clar: [https://explorer.hiro.so/txid/SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.meta-governance-v1?chain=mainnet](https://explorer.hiro.so/txid/SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.meta-governance-v1?chain=mainnet)
- state-v1.clar: [https://explorer.hiro.so/txid/SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1?chain=mainnet](https://explorer.hiro.so/txid/SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1?chain=mainnet)
- linear-kinked-ir-v1.clar: [https://explorer.hiro.so/txid/SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.linear-kinked-ir-v1?chain=mainnet](https://explorer.hiro.so/txid/SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.linear-kinked-ir-v1?chain=mainnet)
- pyth-adapter-v1.clar: [https://explorer.hiro.so/txid/SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.pyth-adapter-v1?chain=mainnet](https://explorer.hiro.so/txid/SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.pyth-adapter-v1?chain=mainnet)
