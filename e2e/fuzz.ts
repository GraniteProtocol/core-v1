export type Op = { actor: string; op: string; args: Record<string, number> };

// Timed budget: 10 sequences of 20-40 ops keeps matrix + fuzz inside ~30 minutes.
export const FUZZ_SEQUENCES = 10;
export const FUZZ_MIN_OPS = 20;
export const FUZZ_MAX_OPS = 40;

export const FUZZ_ACTORS = ["lp", "safe", "max", "near", "under", "liquidator", "staker"] as const;

const OPERATIONS: Array<{ op: string; weight: number }> = [
  { op: "deposit", weight: 10 },
  { op: "withdraw", weight: 8 },
  { op: "addCollateral", weight: 12 },
  { op: "removeCollateral", weight: 6 },
  { op: "borrow", weight: 12 },
  { op: "repay", weight: 10 },
  { op: "liquidate", weight: 4 },
  { op: "stake", weight: 6 },
  { op: "unstake", weight: 4 },
  { op: "setPrice", weight: 8 },
  { op: "governance", weight: 2 },
];

/** mulberry32: small, deterministic, good enough for op sequences. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOTAL_WEIGHT = OPERATIONS.reduce((sum, entry) => sum + entry.weight, 0);

function pickOperation(random: () => number): string {
  let roll = random() * TOTAL_WEIGHT;
  for (const entry of OPERATIONS) {
    roll -= entry.weight;
    if (roll <= 0) return entry.op;
  }
  return OPERATIONS[OPERATIONS.length - 1].op;
}

const amountWithin = (random: () => number, max: number): number => 1 + Math.floor(random() * max);

/** Pure, seeded operation generator. Execution is the runner's job. */
export function generate(seed: number, length: number): Op[] {
  const random = mulberry32(seed);
  const ops: Op[] = [];
  for (let i = 0; i < length; i++) {
    const actor = FUZZ_ACTORS[Math.floor(random() * FUZZ_ACTORS.length)];
    const op = pickOperation(random);
    switch (op) {
      case "deposit":
        ops.push({ actor: actor === "liquidator" || actor === "staker" ? actor : "lp", op, args: { amount: amountWithin(random, 50_000) } });
        break;
      case "withdraw":
        ops.push({ actor: "lp", op, args: { amount: amountWithin(random, 20_000) } });
        break;
      case "addCollateral":
        ops.push({
          actor,
          op,
          args: { token: Math.floor(random() * 3), amount: amountWithin(random, 5) },
        });
        break;
      case "removeCollateral":
        ops.push({
          actor,
          op,
          args: { token: Math.floor(random() * 3), amount: amountWithin(random, 2) },
        });
        break;
      case "borrow":
        ops.push({ actor, op, args: { amount: amountWithin(random, 20_000) } });
        break;
      case "repay":
        ops.push({ actor, op, args: { amount: amountWithin(random, 10_000) } });
        break;
      case "liquidate":
        ops.push({ actor: "liquidator", op, args: { target: Math.floor(random() * 4), amount: amountWithin(random, 20_000) } });
        break;
      case "stake":
        ops.push({ actor: "staker", op, args: { amount: amountWithin(random, 20_000) } });
        break;
      case "unstake":
        ops.push({ actor: "staker", op, args: { amount: amountWithin(random, 10_000) } });
        break;
      case "setPrice":
        ops.push({
          actor: "deployer",
          op,
          args: { token: Math.floor(random() * 4), price: Math.floor(random() * 120_000) + 1 },
        });
        break;
      case "governance":
        ops.push({ actor: "deployer", op, args: { action: Math.floor(random() * 3) } });
        break;
      default:
        throw new Error(`unhandled op ${op}`);
    }
  }
  return ops;
}
