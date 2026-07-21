// Build signed Pyth Lazer `evm`-format update blobs for the adapter/consumer tests.
// Encoders mirror the on-chain pyth-lazer-decoder-v1 parser (see stx-labs/stacks-pyth-lazer).

import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, hexToBytes } from "@noble/hashes/utils";

// @noble/secp256k1 v2 needs a sync HMAC injected before synchronous signing.
secp.etc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, concatBytes(...msgs));

export const TEST_PRIVKEY = new Uint8Array(32).fill(1);
export const TEST_PUBKEY = secp.getPublicKey(TEST_PRIVKEY, true); // 33-byte compressed
export const OTHER_PRIVKEY = new Uint8Array(32).fill(2);
export const OTHER_PUBKEY = secp.getPublicKey(OTHER_PRIVKEY, true);

export const EVM_FORMAT_MAGIC = Uint8Array.from([0x2a, 0x22, 0x99, 0x9a]);
export const LAZER_FORMAT_MAGIC = Uint8Array.from([0x93, 0xc7, 0xd3, 0x75]);

export const PROP = {
  Price: 0,
  BestBidPrice: 1,
  BestAskPrice: 2,
  PublisherCount: 3,
  Exponent: 4,
  Confidence: 5,
  FundingRate: 6,
  FundingTimestamp: 7,
  FundingRateInterval: 8,
  MarketSession: 9,
  EmaPrice: 10,
  EmaConfidence: 11,
  FeedUpdateTimestamp: 12,
} as const;

export type FeedSpec = { id: number; props: Array<[number, bigint | null]> };

const PROP_WIDTH: Record<number, number> = {
  0: 8, 1: 8, 2: 8, 3: 2, 4: 2, 5: 8, 9: 2, 10: 8, 11: 8,
};
const PROP_SIGNED = new Set([0, 1, 2, 4, 6, 10]);
const EXISTENCE_FLAGGED = new Set([6, 7, 8, 12]);

const uBE = (value: bigint, width: number): Uint8Array => {
  const out = new Uint8Array(width);
  let v = value & ((1n << BigInt(width * 8)) - 1n); // two's-complement wrap for signed values
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

export const encodeProperty = (type: number, value: bigint | null): Uint8Array => {
  if (EXISTENCE_FLAGGED.has(type)) {
    if (value === null) return Uint8Array.from([type, 0x00]);
    return concatBytes(Uint8Array.from([type, 0x01]), uBE(value, 8));
  }
  if (value === null) throw new Error(`property ${type} is fixed-width and cannot be null`);
  const width = PROP_WIDTH[type] ?? 8;
  return concatBytes(Uint8Array.from([type]), uBE(value, width));
};

const encodeFeed = (feed: FeedSpec): Uint8Array =>
  concatBytes(
    uBE(BigInt(feed.id), 4),
    Uint8Array.from([feed.props.length]),
    ...feed.props.map(([t, v]) => encodeProperty(t, v))
  );

export const buildLazerPayload = (params: {
  timestamp: bigint;
  channel: number;
  feeds: FeedSpec[];
}): Uint8Array =>
  concatBytes(
    LAZER_FORMAT_MAGIC,
    uBE(params.timestamp, 8),
    Uint8Array.from([params.channel]),
    Uint8Array.from([params.feeds.length]),
    ...params.feeds.map(encodeFeed)
  );

// Wrap a signed payload in the evm envelope:
// magic(4) | sig-r(32) | sig-s(32) | recovery-id(1, raw 0/1) | payload-len(u16 BE) | payload
export const buildEvmUpdate = (
  payload: Uint8Array,
  privKey: Uint8Array = TEST_PRIVKEY
): Uint8Array => {
  const sig = secp.sign(keccak_256(payload), privKey);
  return concatBytes(
    EVM_FORMAT_MAGIC,
    sig.toCompactRawBytes(),
    Uint8Array.from([sig.recovery]),
    uBE(BigInt(payload.length), 2),
    payload
  );
};

export { hexToBytes };
