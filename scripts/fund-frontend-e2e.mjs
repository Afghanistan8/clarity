// Funds throwaway accounts for the FRONTEND end-to-end test of Clarity on
// Studionet (chain id 61999). Refuses any other chain.
//
// The browser drives the UI; its wallet is simulated by web/e2e.html with a
// real private key. Keys live ONLY in deployment/frontend-e2e-keys.json
// (gitignored). Funding flows from the CLI keystore account "deployer".
//
// Actors (all interactions happen through the deployed web UI):
//   fA — founder of both vows, faith-backer never (founders cannot back)
//   fB — doubt-backer of both vows
//   fC — faith-backer of both vows (+ payout claimant)
//
// Usage: node scripts/fund-frontend-e2e.mjs

import { generatePrivateKey, createAccount, chains } from "genlayer-js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, DEPLOYMENT_DIR, NETWORK, guardChain, guardCliNetwork, cli, die, rpc,
  readDeployment,
} from "./common.mjs";

const GEN = 10n ** 18n;
const NEEDS = { fA: 24n * GEN, fB: 4n * GEN, fC: 8n * GEN }; // 10+10 create / 1+1 back / 1+1 back

const ts = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await guardChain();
guardCliNetwork();
const rec = readDeployment("studionet.json");
log(`Contract ${rec.address} on ${NETWORK.name}.`);

mkdirSync(DEPLOYMENT_DIR, { recursive: true });
const keysPath = join(DEPLOYMENT_DIR, "frontend-e2e-keys.json");
let keys;
if (existsSync(keysPath) && readFileSync(keysPath, "utf8").includes("fA")) {
  keys = JSON.parse(readFileSync(keysPath, "utf8"));
} else {
  keys = {};
  for (const n of Object.keys(NEEDS)) { keys[n] = generatePrivateKey(); log(`generated ${n}`); }
  writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n");
}

const addrOf = Object.fromEntries(
  Object.keys(NEEDS).map((n) => [n, createAccount(keys[n]).address]),
);
for (const [n, a] of Object.entries(addrOf)) log(`${n.padEnd(3)} ${a}`);

const balanceOf = async (addr) => BigInt(await rpc("eth_getBalance", [addr, "latest"]));

const fundOnce = async (n, need) => {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const bal = await balanceOf(addrOf[n]);
    if (bal >= need) return true;
    log(`Funding ${n} (attempt ${attempt}): ${Number(bal / GEN)} -> ${Number(need / GEN)} GEN from CLI 'deployer' ...`);
    const r = cli("account", ["send", addrOf[n], `${Number(need / GEN)}gen`, "--account", "deployer"],
      { tolerant: true, timeout: 10 * 60_000 });
    if (!r.output.includes("successfully") && !r.output.includes("submitted") && r.status !== 0) {
      log(`   send output tail: ${(r.output.split("\n").filter(Boolean).at(-2) ?? "").slice(0, 120)}`);
    }
    for (let i = 0; i < 40; i++) {
      const b = await balanceOf(addrOf[n]);
      if (b >= need) return true;
      await sleep(4000);
    }
    await sleep(15_000 * attempt); // retry after a pause (queued nonce races)
  }
  return false;
};

for (const [n, need] of Object.entries(NEEDS)) {
  const bal = await balanceOf(addrOf[n]);
  if (bal >= need) { log(`${n} already funded (${Number(bal / GEN)} GEN).`); continue; }
  if (!(await fundOnce(n, need))) die(`Funding ${n} did not land after retries.`);
  log(`${n} funded (balance ${Number((await balanceOf(addrOf[n])) / GEN)} GEN).`);
}

console.log(JSON.stringify(addrOf, null, 2));
