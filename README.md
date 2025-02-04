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
