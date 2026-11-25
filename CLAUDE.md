# core-v1

Failure contracts for this repo. Setup, tests and architecture are in README.md; this file is only
the things that are costly to learn the hard way.

## state-v1 is immutable

`contracts/state-v1.clar` holds every position and all funds, and there is no migration path once
it is live. Never modify it. All other logic contracts are upgradable: publish a new version and
point governance at it. If a fix appears to require a state-v1 change, stop and raise it rather
than making it, and leave a terse `TODO:` naming the concrete fix so v2 picks it up.

## Every deploy uses a fresh deployer

A new deployment goes out under a brand new deployer address, never a reused one. The new contracts
reference the still-live contracts from earlier deployments by fully-qualified address
(`SP<old-deployer>.<contract>`) and reference their own peers relatively (`.<contract>`). Deployment
plans should assume a fresh deployer from the start.

## A repoint pins the whole moving contract unit

Any config whose contract references peers relatively (`.withdrawal-caps-v1`, `.staking-v1`) must pin
every contract in the moving unit - the entry contract and each relative peer it names - to its own
expected principal for that environment. The pin is a single invariant covering every environment,
failing when an environment has no pinned set, and mutation-checked: swapping two entries fails.
Pinning only the entry contract leaves the config's entries for those peers free to name a
wrong-but-live contract, and that passes every test.

## Mutation-verified claims name the evidence

Every "mutation-verified" claim names the test file, the mutant applied and the observed failure.

## settings/Mainnet.toml holds live mnemonics

It is gitignored and contains real deployer seed phrases. Never commit it, never print or echo its
contents, and never paste a value from it into a message, a log, or a script. Tooling that needs to
sign (clarinet) reads it directly; you do not need to open it.

## Epoch and Clarity version are fixed at publish

A contract cannot reference a contract published under a newer epoch. Because the epoch is frozen at
publish time, raising it means republishing every contract that references the bumped one, so an
epoch bump cascades up the whole reference graph. Check the epoch of what you reference before
assuming a single-contract redeploy is enough.

## Deploy plans need the on-disk flag

```bash
clarinet deployments apply -p deployments/<plan>.yaml -d --no-dashboard
```

`-d` uses the costs written in the plan. Without it clarinet re-derives them and overshoots by a
wide margin, which can drain or overrun a freshly funded deployer mid-deploy.

## Live config is on-chain, not in this repo

Before redeploying a market, read the current values (oracle feed ids, withdrawal caps, time deltas,
guardian sets) off the live contracts and carry them into the new deployment. The defaults in this
repo are not what production is running, and a missed value has already cost a full redeploy.

## Collateral parameters come from verified sources, never staging

Pin a market endpoint to its state-v1 before using its values. A host is identified by the state-v1
it fronts, not by its name: `api.granite.world` served the wound-down aeUSDC market when checked on
2026-11-16, reporting its sBTC at 15/25/10 against `api-usdcx.granite.world` at 50/65/10.

Assert an oracle feed by numeric id and `asset_type`, never by ticker alone. Lazer feed 45 is
`Crypto.STX/USD`, `asset_type` `crypto`; feed 1404 is `Equity.US.STX/USD`, `asset_type` `equity`
(Seagate Technology), an unrelated equity price roughly three orders of magnitude above STX. The
adapter cannot detect the mistake because it discards market session and per-feed timestamp.

Never carry staging parameter values into production. A one-unit gap between max-LTV and
liquidation-LTV liquidates a max-LTV position on essentially any move; staging `SP2N615` runs STX at
30/30.000001.
