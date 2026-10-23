import { buildEvmUpdate, buildLazerPayload, PROP, type FeedSpec } from "../tests/lazer.ts";
import type { Chain } from "./chain.ts";
import { asUint } from "./values.ts";

export const PRICE_DECIMALS = 8;
const SCALING_FACTOR = 100_000_000n;

export const FEED_IDS: Record<string, number> = {
  "mock-btc": 1,
  "mock-eth": 2,
  "mock-usdc": 7,
  "stx-sip010": 45,
};

export const MIN_CONFIDENCE_RATIOS: Record<string, number> = {
  "mock-btc": 500,
  "mock-eth": 500,
  "mock-usdc": 100,
  "stx-sip010": 500,
};

type Entry = { price: bigint; expo: number };
const registry = new Map<number, Entry>();

export function feedId(token: string): number {
  const id = FEED_IDS[token];
  if (id === undefined) throw new Error(`invalid token feed: ${token}`);
  return id;
}

/** Sets a price in whole dollars, stored the way tests/pyth.ts does (price * 1e8 at expo -8). */
export function setPrice(token: string, dollars: bigint | number): void {
  registry.set(feedId(token), { price: BigInt(dollars) * SCALING_FACTOR, expo: -8 });
}

export function setPriceRaw(token: string, price: bigint, expo = -8): void {
  registry.set(feedId(token), { price, expo });
}

export function resetPrices(): void {
  registry.clear();
}

/** The market's starting prices; scenarios reset to these so one cannot skew the next. */
export function resetToBaseline(): void {
  registry.clear();
  setPrice("mock-usdc", 1n);
  setPrice("mock-btc", 60_000n);
  setPrice("mock-eth", 3_000n);
  setPrice("stx-sip010", 2n);
}

/** Whole-dollar price (BigInt) currently set for a token. */
export function priceOf(token: string): bigint {
  const entry = registry.get(feedId(token));
  if (!entry) throw new Error(`no price for ${token}`);
  return (entry.price / SCALING_FACTOR) * (entry.expo === -8 ? 1n : 10n ** BigInt(-entry.expo - 8));
}

// Mirror of the adapter's convert-res: raw Lazer price -> fixed-point uint.
function convertRes(price: bigint, expo: number): bigint {
  if (expo >= 0) return price * 10n ** BigInt(expo + PRICE_DECIMALS);
  const diff = PRICE_DECIMALS - Math.abs(expo);
  if (diff === 0) return price;
  if (diff > 0) return price * 10n ** BigInt(diff);
  return price / 10n ** BigInt(Math.abs(diff));
}

/** Fixed-point price as the adapter returns it (1e8 resolution). */
export function convertedPrice(token: string): bigint {
  const entry = registry.get(feedId(token));
  if (!entry) throw new Error(`no price for ${token}`);
  return convertRes(entry.price, entry.expo);
}

export async function blockTime(chain: Chain): Promise<bigint> {
  return asUint(await chain.read("faucet", "get-block-time"));
}

/** A signed Lazer payload carrying every registered feed at the current devnet block time. */
export async function priceUpdate(chain: Chain, offsetSeconds = 0n): Promise<Uint8Array> {
  const timestamp = (await blockTime(chain)) + offsetSeconds;
  const feeds: FeedSpec[] = [...registry.entries()].map(([id, entry]) => {
    const props: Array<[number, bigint | null]> = [
      [PROP.Price, entry.price],
      [PROP.Exponent, BigInt(entry.expo)],
      [PROP.PublisherCount, 1n],
    ];
    return { id, props };
  });
  if (feeds.length === 0) throw new Error("no prices registered");
  if (feeds.length > 16) throw new Error("Lazer update supports at most 16 feeds");
  return buildEvmUpdate(buildLazerPayload({ timestamp: timestamp * 1_000_000n, channel: 1, feeds }));
}
