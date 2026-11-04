# Report 97281 — absent Lazer confidence maps to zero spread

## Status

**Reproduces.** The defect is observed by execution against a Clarinet `remote_data` fork of mainnet at block 8,666,449. The deployed adapter's `prices-for` accepts a feed whose confidence field is absent and returns the price; the same feed with confidence present at 20% is rejected with `ERR-PRICE-CONFIDENCE-LOW` (`u80004`).

## Live contract and block

- Adapter: `SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT.pyth-adapter-v1`
  - Deployed: block 8,666,265 (tx `0xa057ebce9c8c1501cf56b18185ea3eed4e35a72934446bb9599508637d476520`)
  - Initialized: block 8,666,449 (tx `0xe27a312cf9a05cacd6e0708740b0cd2bb7a72593f9babdd9bffe77bd8d5411c8`), time-delta `u300`
  - Fork height: 8,666,449
- Pyth Lazer oracle/decoder/traits: `SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8.*`
- Constants: `SP3M2BYF7RGF8WKW5FVDNJ6WR8D7AR9BHDXAKPXZE.constants-v1` and `.constants-v2`
- Fork block time: 1,785,409,948 (initialize block); previous block 8,666,448 time 1,785,409,932; `STACKS_BLOCK_TIME u5`.
- Chain tip at measurement: 9,411,225.

## Deployed source verification

Read over the API (`GET https://api.hiro.so/extended/v1/contract/SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT.pyth-adapter-v1`) and saved to `tests/remote/97281/pyth-adapter-v1.deployed.clar`. The deployed source carries the `(default-to u0 maybe-conf)` path:

- `prices-for` at line 138.
- `validate-and-convert` at line 220; `(price-conf (default-to u0 maybe-conf))` at line 231.
- `check-confidence` at line 240; comparison at line 248.
- `confidence-absent` print at line 243.

## A/B/C results

All calls are `prices-for` against the forked adapter with token `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` (feed-id 1, max-confidence-ratio 500 = 5%), raw price `10000000000000` (10^13), exponent `-8`, timestamp `1785409948` (valid for the fork).

| case | confidence field | result |
|---|---|---|
| absent | omitted (`none`) | `ok` with price `10000000000000`; prints `confidence-absent` for feed-id 1 |
| present 20% | `some(2000000000000)` | `err u80004` (`ERR-PRICE-CONFIDENCE-LOW`) |
| present 5% | `some(500000000000)` | `ok` with price `10000000000000` |

The bound is `10000000000000 * 500 / 10000 = 500000000000`. The 20% confidence exceeds it and is rejected; the 5% confidence equals it and is accepted; the absent confidence becomes `u0`, which is always `<=` the bound and is accepted. Only the field's presence changes between the absent and present 20% cases.

## Exact commands

```bash
# exploratory probe
node tests/remote/97281/probe.mjs

# assertion test (exit 0 on reproduction)
node tests/remote/97281/repro.mjs
```

The test manifest is `tests/remote/97281/Clarinet.toml` with:

```toml
[repl.remote_data]
enabled = true
api_url = "https://api.hiro.so"
initial_height = 8666449
```

## Frequency measurement

The adapter's entire indexed event history was paginated (`GET /extended/v1/contract/SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT.pyth-adapter-v1/events?limit=50&offset=...`). Measured over blocks 8,666,449 to 9,411,225:

- total events: **1** (the `initialize` event).
- `confidence-absent` events: **0**.

So the bypass has not fired on a consumed mainnet price in this window. The defect is latent on-chain as of this run; its severity rests on the possibility, not on observed occurrence. The report's own measurement of 0/492 consumed feed observations is the report's, not re-measured here. The project's own source comment says ~15% of upstream Lazer updates omit the field; that is an upstream rate and is not measured here (the public Lazer API is token-gated).

## Notes

- The fork loaded the adapter's state (the `price-feeds` map returned the sBTC feed); without `remote_data`, the same calls returned `u80001` (`ERR-UNSUPPORTED-ASSET`) because requirements deployed source without state.
- The absent-confidence call emits the deployed `confidence-absent` print event, confirming the exact code path.
