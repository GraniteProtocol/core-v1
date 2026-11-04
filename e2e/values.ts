import { ClarityType, type ClarityValue } from "@stacks/transactions";

type Any = ClarityValue & { value?: any; type: string };

export function asOk(value: ClarityValue): ClarityValue {
  const cv = value as Any;
  if (cv.type !== ClarityType.ResponseOk) throw new Error(`expected ok response, got ${cv.type}`);
  return cv.value as ClarityValue;
}

export function asUint(value: ClarityValue): bigint {
  const cv = value as Any;
  if (cv.type !== ClarityType.UInt) throw new Error(`expected uint, got ${cv.type}`);
  return cv.value as bigint;
}

export function asInt(value: ClarityValue): bigint {
  const cv = value as Any;
  if (cv.type !== ClarityType.Int) throw new Error(`expected int, got ${cv.type}`);
  return cv.value as bigint;
}

export function asBool(value: ClarityValue): boolean {
  const cv = value as Any;
  if (cv.type !== ClarityType.BoolTrue && cv.type !== ClarityType.BoolFalse) {
    throw new Error(`expected bool, got ${cv.type}`);
  }
  return cv.type === ClarityType.BoolTrue;
}

export function asOptional(value: ClarityValue): ClarityValue | null {
  const cv = value as Any;
  if (cv.type === ClarityType.OptionalNone) return null;
  if (cv.type === ClarityType.OptionalSome) return cv.value as ClarityValue;
  throw new Error(`expected optional, got ${cv.type}`);
}

export function asTuple(value: ClarityValue): Record<string, ClarityValue> {
  const cv = value as Any;
  if (cv.type !== ClarityType.Tuple) throw new Error(`expected tuple, got ${cv.type}`);
  return cv.value as Record<string, ClarityValue>;
}

export function asList(value: ClarityValue): ClarityValue[] {
  const cv = value as Any;
  if (cv.type !== ClarityType.List) throw new Error(`expected list, got ${cv.type}`);
  return cv.value as ClarityValue[];
}

export function asPrincipal(value: ClarityValue): string {
  const cv = value as Any;
  if (cv.type !== ClarityType.PrincipalStandard && cv.type !== ClarityType.PrincipalContract) {
    throw new Error(`expected principal, got ${cv.type}`);
  }
  return cv.value as string;
}

export function asBuffer(value: ClarityValue): Uint8Array {
  const cv = value as Any;
  if (cv.type !== ClarityType.Buffer) throw new Error(`expected buffer, got ${cv.type}`);
  return cv.value as Uint8Array;
}

/** Unwraps ok and decodes a uint. */
export function okUint(value: ClarityValue): bigint {
  return asUint(asOk(value));
}
