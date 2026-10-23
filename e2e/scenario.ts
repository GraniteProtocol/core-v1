import { checkInvariants, failed } from "./invariants.ts";
import type { Chain } from "./chain.ts";
import type { Actors, Snapshot } from "./setup.ts";

export type StepResult = { name: string; ok: boolean; failure?: string };

export type ScenarioContext = {
  chain: Chain;
  actors: Actors;
  baseline: Snapshot;
  steps: StepResult[];
  invariantFailures: string[];
  step: (name: string, action: () => Promise<unknown>) => Promise<void>;
  attempt: (name: string, action: () => Promise<unknown>, code: string) => Promise<void>;
  assert: (name: string, condition: boolean, detail: string) => void;
};

export type Scenario = { name: string; run: (context: ScenarioContext) => Promise<void> };

export function createContext(chain: Chain, actors: Actors, baseline: Snapshot): ScenarioContext {
  const steps: StepResult[] = [];
  const invariantFailures: string[] = [];

  const verify = async (label: string): Promise<void> => {
    const results = failed(await checkInvariants(chain));
    if (results.length > 0) {
      const detail = results.map((result) => `${result.name}: ${result.detail}`).join("; ");
      invariantFailures.push(`${label}: ${detail}`);
      throw new Error(`invariant violated after ${label}: ${detail}`);
    }
  };

  const record = (name: string, ok: boolean, failure?: string) => {
    steps.push({ name, ok, failure });
  };

  return {
    chain,
    actors,
    baseline,
    steps,
    invariantFailures,
    async step(name, action) {
      try {
        await action();
        record(name, true);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        record(name, false, failure);
        throw error;
      }
      await verify(name);
    },
    async attempt(name, action, code) {
      try {
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(code)) {
          const failure = `expected abort ${code}, got: ${message}`;
          record(name, false, failure);
          throw new Error(failure);
        }
        record(name, true);
        await verify(name);
        return;
      }
      const failure = `expected abort ${code}, but the call succeeded`;
      record(name, false, failure);
      throw new Error(failure);
    },
    assert(name, condition, detail) {
      record(name, condition, condition ? undefined : detail);
      if (!condition) throw new Error(`${name}: ${detail}`);
    },
  };
}
