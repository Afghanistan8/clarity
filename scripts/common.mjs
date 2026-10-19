// Shared helpers for the Clarity deployment toolchain.
//
// Hard network policy: these scripts refuse to run against anything but
// Studionet (chain id 61999). Every guard is explicit and fail-closed.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(SCRIPTS_DIR, "..");
export const DEPLOYMENT_DIR = join(ROOT, "deployment");
export const CONTRACT = join(ROOT, "contracts", "clarity.py");

export const MANIFEST_NAME = "manifest.json";
export const STUDIO_NAME = "studionet.json";

export const NETWORK = {
  name: "studionet",
  chainId: 61999,
  chainIdHex: "0xf22f",
  rpc: "https://studio.genlayer.com/api",
};

export function die(msg) {
  console.error("\nERROR: " + msg);
  process.exit(1);
}

export function sha256File(path) {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

// ------------------------------------------------------------------ //
// JSON-RPC against the locked network                                 //
// ------------------------------------------------------------------ //

export async function rpc(method, params = []) {
  let res;
  try {
    res = await fetch(NETWORK.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    die(`RPC ${NETWORK.rpc} unreachable: ${e.message}`);
  }
  if (!res.ok) die(`RPC returned HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) die(`RPC error: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** Refuse to run on any chain other than Studionet. */
export async function guardChain() {
  let cid;
  try {
    cid = await rpc("eth_chainId");
  } catch (e) {
    die("Chain guard failed: " + e.message);
  }
  if (cid !== NETWORK.chainIdHex) {
    die(
      `Chain guard: RPC reports chain id ${cid}, expected ${NETWORK.chainIdHex} ` +
        `(Studionet, ${NETWORK.chainId}). Wrong network — aborting.`,
    );
  }
  console.log(`Chain guard OK: ${NETWORK.name} (chain id ${NETWORK.chainId}).`);
}

// ------------------------------------------------------------------ //
// genlayer CLI plumbing                                                //
// ------------------------------------------------------------------ //

export function cli(cmd, args, opts = {}) {
  const r = spawnSync("genlayer", [cmd, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    timeout: opts.timeout ?? 10 * 60_000,
  });
  return {
    ok: r.status === 0,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    status: r.status,
  };
}

/** Refuse to run if the CLI itself is pointed at another network/account. */
export function guardCliNetwork() {
  const r = cli("config", ["get"]);
  const m = r.output.match(/"network"\s*:\s*"([^"]+)"/);
  const net = m ? m[1] : "(unknown)";
  if (net !== NETWORK.name) {
    die(`CLI network is "${net}", expected "${NETWORK.name}". Run: genlayer network set ${NETWORK.name}`);
  }
  const acc = r.output.match(/"activeAccount"\s*:\s*"([^"]+)"/);
  console.log(`CLI guard OK: network=${net} activeAccount=${acc ? acc[1] : "?"}`);
}

// ------------------------------------------------------------------ //
// SHA manifest                                                         //
// ------------------------------------------------------------------ //

export const MANIFEST_SOURCES = [
  "contracts/clarity.py",
  "scripts/common.mjs",
  "scripts/deploy.mjs",
  "scripts/verify.mjs",
  "scripts/e2e.mjs",
  "demo/evidence.md",
  "tests/mirror.py",
  "tests/conftest.py",
];

/** Build a deterministic SHA-256 manifest over the deployment sources. */
export function buildManifest() {
  const files = [];
  for (const rel of MANIFEST_SOURCES) {
    const p = join(ROOT, rel);
    const data = readFileSync(p, "utf8");
    const h = createHash("sha256");
    h.update(data, "utf8");
    files.push({
      path: rel.replace(/\\/g, "/"),
      bytes: Buffer.byteLength(data, "utf8"),
      sha256: h.digest("hex"),
    });
  }
  const root = createHash("sha256");
  for (const f of files) root.update(`${f.sha256}  ${f.path}\n`);
  return {
    manifest_version: 1,
    network: NETWORK.name,
    chain_id: NETWORK.chainId,
    rpc: NETWORK.rpc,
    manifest_sha256: root.digest("hex"),
    files,
  };
}

/** Regenerate deployment/manifest.json (prints the root hash). */
export function writeManifest() {
  mkdirSync(DEPLOYMENT_DIR, { recursive: true });
  const manifest = buildManifest();
  writeFileSync(join(DEPLOYMENT_DIR, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `Manifest written: deployment/${MANIFEST_NAME} (root ${manifest.manifest_sha256.slice(0, 24)}...)`,
  );
  return manifest;
}

export function readDeployment(name) {
  const p = join(DEPLOYMENT_DIR, name);
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    die(`Missing deployment/deployment record ${name} — run scripts/deploy.mjs first.`);
  }
  return JSON.parse(text);
}

