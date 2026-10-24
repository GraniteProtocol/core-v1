import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, readdirSync, openSync, closeSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { deriveKey } from "./keys.ts";
import { DevnetStallError } from "./chain.ts";

export type DevnetHandle = {
  pid: number;
  logPath: string;
  apiUrl: string;
  nodeUrl: string;
  network: string;
  proc: ChildProcess;
  logFd: number;
  workingDir?: string;
};

export type BootAttempt = {
  attempt: number;
  logPath: string;
  ok: boolean;
  reason?: string;
};

const NETWORK = "granite-core.devnet";
const CACHE_DIR = ".cache";

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

async function tipHeight(apiUrl: string): Promise<number> {
  try {
    const res = await fetch(`${apiUrl}/v2/info`);
    if (!res.ok) return -1;
    const json = (await res.json()) as { stacks_tip_height?: number };
    return json.stacks_tip_height ?? -1;
  } catch {
    return -1;
  }
}

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPortsClosed(ports: number[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let open = ports;
  while (Date.now() < deadline) {
    open = [];
    for (const port of ports) if (await portOpen(port)) open.push(port);
    if (open.length === 0) return;
    await sleep(500);
  }
  console.warn(`teardown: ports still listening after ${timeoutMs}ms: ${open.join(", ")}`);
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

function devnetContainerNames(): string[] {
  const docker = dockerPath();
  const res = spawnSync(docker, ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.endsWith(`.${NETWORK}`));
}

function devnetNetworkExists(): boolean {
  const docker = dockerPath();
  const res = spawnSync(docker, ["network", "ls", "--format", "{{.Name}}"], { encoding: "utf8" });
  if (res.status !== 0) return false;
  return res.stdout.split("\n").map((line) => line.trim()).includes(NETWORK);
}

/** Refuses to adopt a devnet this run did not start: another run's chain owns these ports and names. */
async function assertNoForeignDevnet(apiUrl: string): Promise<void> {
  const status = await httpStatus(`${apiUrl}/v2/info`);
  if (status !== 0) {
    throw new Error(`another devnet is already answering on ${apiUrl} (status ${status}); refusing to adopt it`);
  }
  const containers = devnetContainerNames();
  if (containers.length > 0) {
    throw new Error(`devnet containers already exist (${containers.join(", ")}); refusing to adopt them`);
  }
  if (devnetNetworkExists()) {
    throw new Error(`devnet network ${NETWORK} already exists; refusing to adopt it`);
  }
}

function stackDirs(): string[] {
  try {
    return readdirSync(CACHE_DIR).filter((name) => name.startsWith("stacks-devnet-"));
  } catch {
    return [];
  }
}

export async function startDevnet(
  opts: {
    repoRoot?: string;
    logDir?: string;
    logName?: string;
    apiUrl?: string;
    nodeUrl?: string;
    contractTimeoutMs?: number;
  } = {},
  onHandle?: (handle: DevnetHandle) => void,
): Promise<DevnetHandle> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const logDir = opts.logDir ?? `/tmp/local-e2e-${Date.now()}`;
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, opts.logName ?? "devnet.log");
  const apiUrl = opts.apiUrl ?? "http://localhost:3999";
  const nodeUrl = opts.nodeUrl ?? "http://localhost:20443";

  await ensureDocker();
  await assertNoForeignDevnet(apiUrl);

  const dirsBefore = new Set(stackDirs());
  const logFd = openSync(logPath, "w");
  // -c recomputes the deployment plan without asking to overwrite it, leaving the single `y` below
  // for clarinet's PoX continue prompt.
  const proc = spawn("clarinet", ["devnet", "start", "--no-dashboard", "--from-genesis", "-c"], {
    cwd: repoRoot,
    env: { ...process.env, PATH: childPath() },
    stdio: ["pipe", logFd, logFd],
  });
  proc.stdin?.write("y\n");

  const handle: DevnetHandle = {
    pid: proc.pid ?? -1,
    logPath,
    apiUrl,
    nodeUrl,
    network: NETWORK,
    proc,
    logFd,
  };
  onHandle?.(handle);

  try {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`clarinet exited with code ${proc.exitCode} before the API was ready`);
      }
      if ((await httpStatus(`${apiUrl}/v2/info`)) === 200) break;
      await sleep(1000);
    }
    if ((await httpStatus(`${apiUrl}/v2/info`)) !== 200) {
      throw new Error(`devnet API did not answer on ${apiUrl} within 300s`);
    }
    if (proc.exitCode !== null) {
      throw new Error(`clarinet exited with code ${proc.exitCode} before the contracts deployed`);
    }

    const contracts = manifestContractNames(join(repoRoot, "Clarinet.toml"));
    const deployer = loadDeployer(join(repoRoot, "settings/Devnet.toml"));
    await waitForContracts(contracts, deployer, apiUrl, opts.contractTimeoutMs ?? 300_000, () => {
      if (proc.exitCode !== null) {
        throw new Error(`clarinet exited with code ${proc.exitCode} before all contracts deployed`);
      }
    });

    if (proc.exitCode !== null) {
      throw new Error(`clarinet exited with code ${proc.exitCode} after the contracts deployed`);
    }
    if ((await tipHeight(apiUrl)) < 1) {
      throw new Error("devnet reports no Stacks blocks; refusing to treat it as ours");
    }
    handle.workingDir = stackDirs().find((name) => !dirsBefore.has(name));
    return handle;
  } catch (error) {
    handle.workingDir ??= stackDirs().find((name) => !dirsBefore.has(name));
    await stopDevnet(handle);
    const reason = error instanceof Error ? error.message : String(error);
    const message = `${reason}\n--- devnet log tail ---\n${logTail(logPath)}`;
    if (error instanceof DevnetStallError) throw new DevnetStallError(message);
    throw new Error(message);
  }
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
  let tip = -1;
  let tipSince = Date.now();
  let lastTipCheck = 0;
  while (Date.now() < deadline) {
    for (const name of [...missing]) {
      if ((await httpStatus(`${apiUrl}/v2/contracts/source/${deployer}/${name}`)) === 200) missing.delete(name);
    }
    if (missing.size === 0) return;
    onDead();
    if (Date.now() - lastTipCheck >= 3000) {
      lastTipCheck = Date.now();
      const height = await tipHeight(apiUrl);
      if (height > tip) {
        tip = height;
        tipSince = Date.now();
      } else if (Date.now() - tipSince >= 120_000) {
        throw new DevnetStallError(
          `stacks tip stuck at ${height} for 120s while waiting for ${missing.size} contracts`,
        );
      }
    }
    await sleep(1000);
  }
  throw new Error(`contracts never resolved: ${[...missing].join(", ")}`);
}

export async function stopDevnet(handle: DevnetHandle): Promise<void> {
  const { proc } = handle;
  if (proc.exitCode === null) {
    proc.kill("SIGTERM");
    const deadline = Date.now() + 10_000;
    while (proc.exitCode === null && Date.now() < deadline) await sleep(200);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
  try {
    proc.stdin?.destroy();
  } catch {
    /* already gone */
  }
  const docker = dockerPath();
  for (const name of devnetContainerNames()) {
    const res = spawnSync(docker, ["rm", "-f", name], { encoding: "utf8" });
    if (res.status !== 0) {
      console.warn(`teardown: docker rm -f ${name} failed (${res.status}): ${(res.stderr ?? "").trim()}`);
    }
  }
  const network = spawnSync(docker, ["network", "rm", handle.network], { encoding: "utf8" });
  if (network.status !== 0 && !/not found|no such network/i.test(network.stderr ?? "")) {
    console.warn(`teardown: docker network rm ${handle.network} failed: ${(network.stderr ?? "").trim()}`);
  }
  if (handle.workingDir) {
    try {
      rmSync(handle.workingDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`teardown: could not remove ${handle.workingDir}: ${error instanceof Error ? error.message : error}`);
    }
  }
  try {
    closeSync(handle.logFd);
  } catch {
    /* already closed */
  }
  await waitForPortsClosed([3999, 20443, 20444, 20445]);
}
