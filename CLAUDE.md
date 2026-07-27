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

## settings/Mainnet.toml holds live mnemonics

It is gitignored and contains real deployer seed phrases. Never commit it, never print or echo its
contents, and never paste a value from it into a message, a log, or a script. Tooling that needs to
sign (clarinet) reads it directly; you do not need to open it.

## gh must run through direnv

This repo's `.envrc` pins the `GH_TOKEN` for the account that has write access here. A bare `gh` in a
fresh shell picks up whatever token is set globally instead, and fails with "must be a collaborator".
Prefix authenticated calls:

```bash
eval "$(direnv export bash)" && gh <command>
gh api user --jq .login    # confirm this matches the account .envrc configures
```

Commits and SSH pushes are unaffected; only `gh` / REST calls break.

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
