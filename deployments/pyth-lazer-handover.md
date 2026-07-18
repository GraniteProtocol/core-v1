# Pyth Lazer deploy and governance handover

Runbook for standing up the self-deployed Pyth Lazer stack and handing the oracle over to the
`pyth-lazer-gov` shim. Do this per environment (staging, then each mainnet market).

The sharp edge: at deploy the deployer EOA holds the oracle's `ROLE_GOVERNANCE` and `ROLE_PAUSE`
(the oracle grants all roles to `tx-sender` at deploy). The oracle refuses self-removal of the
governance role (`ERR_CANNOT_CHANGE_OWN_GOVERNANCE`, guarded on `contract-caller`), so the deployer
cannot revoke itself directly. Revocation runs through a shim `set-role` proposal, which is
`SET_ROLE` and therefore 24h time-locked. Until that completes, the deployer is a unilateral oracle
admin that bypasses the shim entirely (it could set a malicious signer or decoder). Keep the window
short and the deployer key controlled.

## 1. Deploy

Deploy together (they reference each other by name):

1. `pyth-lazer-traits`
2. `pyth-lazer-oracle`
3. `pyth-lazer-decoder-v1`
4. `pyth-lazer-gov` (the shim)

Then the market logic pointing at the shared oracle: `pyth-adapter-v1`, `borrower-v1`,
`liquidator-v1`, `governance-v1`.

## 2. Grant the shim its oracle roles (deployer)

The deployer holds both roles by default, so it grants them:

- `oracle.set-role(<shim>, 0x00, true)`  (ROLE_GOVERNANCE)
- `oracle.set-role(<shim>, 0x01, true)`  (ROLE_PAUSE)

## 3. Initialize the shim (deployer)

- `shim.initialize((list (some <guardian>) ...))`

`initialize` asserts the shim already holds `ROLE_GOVERNANCE` and `ROLE_PAUSE` on the oracle and
that at least one guardian is supplied, so a forgotten grant or an empty guardian list fails here
rather than at first execution. Do step 2 before this.

## 4. Seed oracle parameters (through the shim, meta-gov multisig)

- Trusted signers: `initiate-proposal-to-set-trusted-signers` with the Pyth Lazer compressed
  pubkey(s) and expiry. Instant.
- Feed ids per token: `governance-v1.initiate-proposal-to-update-pyth-feed(token, feed-id, ratio, ...)`
  (24h time-locked in governance-v1).
- Freshness window if changing the default: `pyth-adapter-v1` `update-time-delta` via governance-v1.
- Stale threshold on the oracle if changing the default: `shim.initiate-proposal-to-set-stale-threshold`
  (24h time-locked).

## 5. Revoke the deployer's oracle roles (deployer + multisig)

Both are `SET_ROLE`, so 24h time-locked:

- `shim.initiate-proposal-to-set-role(<deployer>, 0x00, false)`  (revoke ROLE_GOVERNANCE)
- `shim.initiate-proposal-to-set-role(<deployer>, 0x01, false)`  (revoke ROLE_PAUSE)

Collect approvals to threshold, wait the 24h time-lock, then `shim.execute(<proposal-id>)` for each.

## 6. Verify the handover

- `oracle.has-role(<deployer>, 0x00)` is false and `oracle.has-role(<deployer>, 0x01)` is false.
- `oracle.has-role(<shim>, 0x00)` is true and `oracle.has-role(<shim>, 0x01)` is true.
- Guardian pause works: a guardian calls `shim.guardian-pause` and `oracle.is-paused` is true; then
  `shim.guardian-unpause`.

## Deploy-config notes

- Meta-governance binding: the shim binds `.meta-governance-v1` by name. Confirm whether this is the
  existing shared registry (already initialized with the environment's multisig) or a freshly
  co-deployed meta-gov that must be initialized first. The shim reads membership and the multisig
  count from it, so it must be live and initialized before any shim proposal.
- Guardians can be rotated post-deploy through the shim: `initiate-proposal-to-update-guardian` with
  action 6 (add, 24h time-locked) or 7 (remove, instant so a compromised pause key can be dropped
  fast).
