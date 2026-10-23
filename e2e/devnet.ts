import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deriveKey } from "./keys.ts";

export type DevnetHandle = {
  pid: number;
  logPath: string;
  apiUrl: string;
  nodeUrl: string;
  network: string;
  proc: ChildProcess;
};

const DOCKER_CANDIDATES = [
  "docker",
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
];

export function resolveDocker(): string {
  for (const candidate of DOCKER_CANDIDATES) {
    if (candidate === "docker") {
      const probe = spawnSync("docker", ["version"], { stdio: "ignore" });
      if (probe.status === 0) return candidate;
    } else if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("docker CLI not found; install Docker Desktop");
}

const dockerPath = (): string => {
  const fromEnv = process.env.DOCKER_BIN;
  return fromEnv && existsSync(fromEnv) ? fromEnv : resolveDocker();
};

const childPath = (): string => {
  const extra = "/Applications/Docker.app/Contents/Resources/bin";
  return process.env.PATH?.includes(extra) ? process.env.PATH : `${extra}:${process.env.PATH ?? ""}`;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function manifestContractNames(manifestPath = "Clarinet.toml"): string[] {
  const text = readFileSync(manifestPath, "utf8");
  const names = [...text.matchAll(/^\[contracts\.([a-z0-9-]+)\]/gm)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`no contracts found in ${manifestPath}`);
  return names;
}

function logTail(path: string, lines = 25): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "(no devnet log yet)";
  }
}

async function httpStatus(url: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.status;
  } catch {
    return 0;
  }
}

export async function ensureDocker(timeoutMs = 120_000): Promise<void> {
  const docker = dockerPath();
  const running = () => spawnSync(docker, ["info"], { stdio: "ignore" }).status === 0;
  if (running()) return;
  spawnSync("open", ["-a", "Docker"], { stdio: "ignore" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (running()) return;
    await sleep(2000);
  }
  throw new Error(`Docker daemon did not answer within ${timeoutMs}ms`);
}

export async function startDevnet(opts: {
  repoRoot?: string;
  logDir?: string;
  apiUrl?: string;
  nodeUrl?: string;
  contractTimeoutMs?: number;
} = {}): Promise<DevnetHandle> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const logDir = opts.logDir ?? `/tmp/local-e2e-${Date.now()}`;
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "devnet.log");
  const apiUrl = opts.apiUrl ?? "http://localhost:3999";
  const nodeUrl = opts.nodeUrl ?? "http://localhost:20443";

  await ensureDocker();
  const out = await import("node:fs").then((fs) => fs.openSync(logPath, "w"));
  const proc = spawn("clarinet", ["devnet", "start", "--no-dashboard", "--from-genesis"], {
    cwd: repoRoot,
    env: { ...process.env, PATH: childPath() },
    stdio: ["pipe", out, out],
  });
  proc.stdin?.write("y\n");
  proc.stdin?.end();

  const fail = (reason: string): never => {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    throw new Error(`${reason}\n--- devnet log tail ---\n${logTail(logPath)}`);
  };

  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) fail(`clarinet exited with code ${proc.exitCode} before the API was ready`);
    if ((await httpStatus(`${apiUrl}/v2/info`)) === 200) break;
    await sleep(1000);
  }
  if ((await httpStatus(`${apiUrl}/v2/info`)) !== 200) fail(`devnet API did not answer on ${apiUrl} within 300s`);

  const network = "granite-core.devnet";
  const contracts = manifestContractNames(join(repoRoot, "Clarinet.toml"));
  const deployer = loadDeployer(join(repoRoot, "settings/Devnet.toml"));
  await waitForContracts(contracts, deployer, apiUrl, opts.contractTimeoutMs ?? 300_000, () => {
    if (proc.exitCode !== null) fail(`clarinet exited with code ${proc.exitCode} before all contracts deployed`);
  });

  return { pid: proc.pid ?? -1, logPath, apiUrl, nodeUrl, network, proc };
}

export function loadDeployer(settingsPath: string): string {
  const text = readFileSync(settingsPath, "utf8");
  const section = text.match(/\[accounts\.deployer\]([\s\S]*?)(?:\n\[|$)/);
  const address = section?.[1].match(/#\s*stx_address:\s*(ST[A-Z0-9]+)/)?.[1];
  if (address) return address;
  const mnemonic = section?.[1].match(/mnemonic\s*=\s*"([^"]+)"/)?.[1];
  if (!mnemonic) throw new Error("deployer account not found in settings/Devnet.toml");
  return deriveKey(mnemonic).address;
}

export async function waitForContracts(
  names: string[],
  deployer: string,
  apiUrl: string,
  timeoutMs = 300_000,
  onDead: () => void = () => {
    throw new Error("devnet died while waiting for contracts");
  },
): Promise<void> {
  const missing = new Set(names);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const name of [...missing]) {
      if ((await httpStatus(`${apiUrl}/v2/contracts/source/${deployer}/${name}`)) === 200) missing.delete(name);
    }
    if (missing.size === 0) return;
    onDead();
    await sleep(1000);
  }
  throw new Error(`contracts never resolved: ${[...missing].join(", ")}`);
}

function devnetContainerNames(): string[] {
  const docker = dockerPath();
  const res = spawnSync(docker, ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.endsWith(".granite-core.devnet"));
}

export async function stopDevnet(handle: DevnetHandle): Promise<void> {
  const { proc } = handle;
  if (proc.exitCode === null) {
    proc.kill("SIGTERM");
    const deadline = Date.now() + 10_000;
    while (proc.exitCode === null && Date.now() < deadline) await sleep(200);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
  const docker = dockerPath();
  for (const name of devnetContainerNames()) {
    spawnSync(docker, ["rm", "-f", name], { stdio: "ignore" });
  }
  spawnSync(docker, ["network", "rm", handle.network], { stdio: "ignore" });
}
