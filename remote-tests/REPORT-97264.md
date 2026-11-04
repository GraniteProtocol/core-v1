# Immunefi 97264 - same-block LP deposit inflates the debt withdrawal cap

Status: **reproduces at live state**, on the deployed contracts, with controls.

## How to run

```bash
npm ci
npx vitest run --config vitest.remote.config.js -- --manifest Clarinet.remote.toml
```

The remote manifest pins the fork:

- `[repl.remote_data] enabled = true`, `api_url = https://api.hiro.so`, `initial_height = 9411000`
  (fork block time `1793797784`).
- Requirements: `SP3M2BYF7RGF8WKW5FVDNJ6WR8D7AR9BHDXAKPXZE.state-v1`,
  `SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT.borrower-v1`,
  `SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT.liquidity-provider-v1`,
  `SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT.withdrawal-caps-v1`.
- The resolver pulled the rest of the live graph (adapter, IR module, staking, constants, sBTC token,
  USDCx token, Lazer oracle/decoder/traits) transitively. Contract code and storage are the deployed
  values; no contract is modified or redeployed.

No mnemonic is used. Every call is `simnet.callPublicFn` with an impersonated principal. The one
fork-state change outside the market flow is rotating the shared Lazer oracle's trusted signer to a
test key through `pyth-lazer-oracle.set-trusted-signers`, impersonating the principal that holds
`ROLE_GOVERNANCE` in the forked state. That is needed only so `borrow` can carry a valid price update.

## Live state read at the fork

| item | value (base units, 6 decimals) |
|---|---|
| `state-v1 get-borrowable-balance` | 3,826,199,156,206 |
| `withdrawal-caps-v1 get-debt-bucket` | 765,240,631,696 |
| `withdrawal-caps-v1 get-debt-cap-factor` | 20,000,000 (20%) |
| `withdrawal-caps-v1 get-refill-time-window` | 36,000 s |
| `withdrawal-caps-v1 get-decay-time-window` | 10,800 s |
| USDCx `get-total-supply` | 8,725,418,043,782 |

## Results

The borrowed amounts are USDCx base units (6 decimals).

### Control 1 - live cap enforced

Borrow `cap(3,826,199,156,206) + 1 = 765,239,831,242` with no LP activity: **refused with
`err u120003`** (`ERR-WITHDRAWAL-DEBT-CAP-EXCEEDED`).

### Control 2/3 - after the bucket is drained and a full refill window elapses

Drain the bucket by borrowing the live ceiling `765,239,831,241`, then mine until >= 36,000 s have
elapsed. Borrowable is now `3,060,959,324,965`, and the ceiling is 20% of it.

- Borrow `612,191,864,993 + 1`: **refused, `err u120003`**.
- Borrow `612,191,864,993`: **accepted**.

### Variant A - deposit, borrow, withdraw in one block

One `simnet.mineBlock` with:

1. `liquidity-provider-v1.deposit(8,700,000,000,000, attacker)`
2. `borrower-v1.borrow(price-update, 2,352,191,864,993, none)`
3. `liquidity-provider-v1.withdraw(8,700,000,000,000 - 1,000, attacker)`

All three succeed. The borrow is `2,352,191,864,993` against a control ceiling of
`612,191,864,993`: **3.842x the per-window cap** (3.074x the pre-drain live ceiling of
`765,239,831,241`). It is 76.8% of the pool's remaining borrowable (`3,060,959,324,965`).
After the block:

- `borrowable-balance` = 708,767,460,972
- `debt-bucket` = 0 (the borrow spent the inflated credit)
- the attacker holds 11,817,431,695,234 USDCx: the 8.7M temporary deposit recovered (minus the
  1,000-unit LP share-rounding remainder), the 765,239,831,241 drain borrow, and the
  2,352,191,864,993 attack borrow.

The 1,000-unit shortfall in the withdrawal is LP share rounding: deposit mints
`floor(assets*S/A)` shares and withdraw burns `ceil(assets*S/A)`, so an exact round trip can try to
burn one share more than it minted. Withdrawing 1,000 units less removes the revert; the mechanism
under test is unaffected.

### Variant B - the inflated credit outlives the temporary liquidity

One block with deposit `8,700,000,000,000`, `borrow(1)`, withdraw `8,700,000,000,000 - 1,000`.
After the block the stored `debt-bucket` is **2,352,191,864,992**, while the real ceiling for the
remaining borrowable (`3,060,959,325,964`) is `612,191,865,192`.

The next block borrows `1,224,383,729,986` and **succeeds**. The bucket after that borrow is
`1,031,141,468,351`, still above the real ceiling.

Control for the same shape without the deposit: drain + full refill window, `borrow(1)`, next block
borrow `1,224,383,729,986`, **refused with `err u120003`** (bucket `612,191,864,992`).

## Interpretation

`withdrawal-caps-v1.sync-debt-bucket` sizes the ceiling from the live `state-v1` borrowable balance
at sync time. `liquidity-provider-v1.deposit` and `withdraw` never sync the debt bucket, so liquidity
that exists for one block sets the ceiling, and the stored bucket is not clamped when that liquidity
leaves. The precondition the report states ("the bucket was last synced a full refill window ago")
is reachable on the live market simply by borrowing the current cap and waiting one refill window:
the attacker's own drain borrow creates it. No config change and no privileged access are involved.

The temporary liquidity is 8.7M USDCx, just under the live total supply of 8.725M. The attack's
dollar size is bounded by that supply, not by the cap; the measured 3.842x over the per-window ceiling
is what an attacker with nearly the whole circulating supply can take.
