// Live end-to-end demonstration of Clarity on Studionet (chain id 61999).
//
// Refuses to run on any other chain. Uses freshly generated throwaway
// accounts funded from the genlayer CLI keystore account ("deployer") via
// `genlayer account send`. The raw keys live only in
// deployment/e2e-keys.json (gitignored) — nothing privileged is touched.
//
// Flow (full lifecycle of one vow):
//   1. guard chain / CLI network, load the deployed contract
//   2. verify the demo evidence page is reachable on raw.githubusercontent.com
//   3. create + fund founder / faith-backer / doubt-backer accounts
//   4. founder: create_vow(text, deadline, url) with a 10 GEN stake
//   5. doubt back(), then faith back() (1 GEN each, respect the faith cap)
//   6. wait until the deadline passes, then assess() -> provisional verdict
//   7. wait out the dispute window, then finalize() -> SETTLED
//   8. pull-based claims for everyone entitled
//   9. dump every view (vow/evidence/settlement/stats/invariant) into
//      deployment/live-e2e.json and print a human summary

import { generatePrivateKey, createAccount, createClient, chains } from "genlayer-js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, DEPLOYMENT_DIR, NETWORK, guardChain, guardCliNetwork, cli, die, rpc,
  readDeployment,
} from "./common.mjs";

const ts = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GEN = 10n ** 18n;
const SIDE_FAITH = 1;
const SIDE_DOUBT = 2;
const VERDICT_NAME = { 1: "FULFILLED", 2: "BROKEN", 3: "UNCLEAR" };
const ETHERSCAN_LIKE = (h) => (typeof h === "string" ? h : String(h));

const SCRIPT_URL = "https://raw.githubusercontent.com/Afghanistan8/clarity/main/demo/evidence.md";
const QUOTE = "CLARITY LIVE PROOF: this sentence is the verbatim evidence quote for the Studionet end-to-end test on 2026-10-19.";

// ---------------------------------------------------------------------- //

await guardChain();
guardCliNetwork();
const rec = readDeployment("studionet.json");
log(`Contract ${rec.address} on ${NETWORK.name}, deployment tx ${rec.tx_id}`);

// ---- 1. evidence page must be live and contain the quote -------------- //

const page = await fetch(SCRIPT_URL, { signal: AbortSignal.timeout(30_000) });
if (!page.ok) {
  die(`Evidence page unreachable (HTTP ${page.status}). Push the repository first.`);
}
const pageBody = await page.text();
if (!pageBody.includes(QUOTE)) die("Evidence page does not contain the grounding quote.");
const headers = page.headers;
log(`Evidence page OK (etag=${headers.get("etag") ? "yes" : "NO"}, last-modified=${headers.get("last-modified")}).`);

// ---- 2. accounts ------------------------------------------------------- //

mkdirSync(DEPLOYMENT_DIR, { recursive: true });
const keysPath = join(DEPLOYMENT_DIR, "e2e-keys.json");
let keys;
if (existsSync(keysPath)) {
  keys = JSON.parse(readFileSync(keysPath, "utf8"));
} else {
  keys = {};
  for (const n of ["founder", "backerFaith", "backerDoubt"]) keys[n] = generatePrivateKey();
  writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n");
}

const accts = Object.fromEntries(
  Object.entries(keys).map(([n, k]) => [n, createAccount(k)]),
);
const addrOf = Object.fromEntries(
  Object.entries(accts).map(([n, a]) => [n, a.address]),
);
for (const [n, a] of Object.entries(addrOf)) log(`${n.padEnd(12)} ${a}`);

const balanceOf = async (addr) =>
  BigInt(await rpc("eth_getBalance", [addr, "latest"]));

for (const [n, need] of [["founder", 12n * GEN], ["backerFaith", 4n * GEN], ["backerDoubt", 4n * GEN]]) {
  const bal = await balanceOf(addrOf[n]);
  if (bal >= need) {
    log(`${n} already funded (${Number(bal / GEN)} GEN).`);
    continue;
  }
  log(`Funding ${n} (${Number(bal / GEN)} -> ${Number(need / GEN)} GEN) from CLI 'deployer' ...`);
  const r = cli("account", ["send", addrOf[n], `${need}gen`, "--account", "deployer"],
    { tolerant: true, timeout: 10 * 60_000 });
  const okMsg = r.output.includes("successfully") || r.output.includes("submitted");
  if (!okMsg && r.status !== 0) die(`Funding ${n} failed:\n${r.output}`);
  const after = await balanceOf(addrOf[n]);
  if (after < need) die(`Funding ${n} did not land (balance ${after}).`);
  log(`${n} funded.`);
}

// ---- 3. client + tx helpers ------------------------------------------- //

const mk = (n) => createClient({ chain: chains.studionet, account: accts[n] });
const C = mk("founder");
const VOW_ID = 0n; // resolved after create

async function write(who, fn, args, value = 0n) {
  const client = mk(who);
  const hash = await client.writeContract({
    address: rec.address,
    functionName: fn,
    args,
    value,
  });
  log(`${who}: ${fn} -> tx ${ETHERSCAN_LIKE(hash)}`);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    interval: 5_000,
    retries: 240,
  });
  const result = receipt?.txExecutionResultName ?? receipt?.resultName ?? "";
  if (String(result).includes("REVERT")) {
    die(`${fn} by ${who} reverted: ${JSON.stringify(receipt?.data ?? {}).slice(0, 400)}`);
  }
  return { hash: ETHERSCAN_LIKE(hash), receipt };
}

async function read(fn, args = []) {
  const out = await C.readContract({
    address: rec.address,
    functionName: fn,
    args,
  });
  return out;
}

// ---- 4. create the vow ------------------------------------------------- //

const stats0 = await read("get_stats", []);
const vowedId = BigInt(stats0["vow_count"] ?? 0) + 1n;
const deadline = ts(Math.floor(Date.now() / 1000) + 180);
const VOW_TEXT =
  `By ${deadline} this live end-to-end test on GenLayer Studionet will be ` +
  `complete: the repository Afghanistan8/clarity contains demo/evidence.md, ` +
  `and that page contains, verbatim, the sentence marked "CLARITY LIVE PROOF" ` +
  `quoted and timestamped below.`;

log(`Creating vow #${vowedId} with a 10 GEN stake (deadline ${deadline}) ...`);
log(`  text: ${VOW_TEXT}`);
const created = await write("founder", "create_vow", [VOW_TEXT, deadline, SCRIPT_URL], 10n * GEN);
const createView = await read("get_vow", [Number(vowedId)]);
if (String(createView["state"]) !== "1" && String(createView["state"]) !== "OPEN") {
  // state is numeric (1=OPEN); ensure "open"
  if (Number(createView["state"]) !== 1) die(`Vow state after create is ${createView["state"]}, expected OPEN(1).`);
}
log(`Vow #${vowedId} OPEN.`);

// ---- 5. backings (doubt first: faith cap) ------------------------------ //

await write("backerDoubt", "back", [Number(vowedId), SIDE_DOUBT], 1n * GEN);
log("Doubt backing of 1 GEN recorded (first doubter pays for the possibility of faith).");
await write("backerFaith", "back", [Number(vowedId), SIDE_FAITH], 1n * GEN);
log("Faith backing of 1 GEN recorded (cap satisfied: faith 1 <= doubt 1).");

// ---- 6. wait for deadline, then assess --------------------------------- //

const dl = Date.parse(deadline);
if (Number.isNaN(dl)) die("Bad deadline timestamp.");
const msToAdl = dl - Date.now() + 6_000;
if (msToAdl > 0) log(`Sleeping ${Math.ceil(msToAdl / 1000)}s until the deadline passes ...`);
await sleep(Math.max(msToAdl, 0));

log("Calling assess() — Studionet validators fetch the page and judge it ...");
await write("founder", "assess", [Number(vowedId)]);
const stProv = await read("get_settlement", [Number(vowedId)]);
const verdict = Number(stProv["verdict"]);
log(`Provisional ${VERDICT_NAME[verdict]} — evidence:`);
const ev = await read("get_evidence", [Number(vowedId)]);
log(`  tier=${ev["tier"]} proc=${ev["procedure"]} status=${ev["status"]} contained=${ev["contained"]}`);
log(`  quote=${JSON.stringify(String(ev["quote"] ?? "")).slice(0, 140)}`);
log(`  page_date=${JSON.stringify(String(ev["page_date"] ?? ""))}`);

// ---- 7. dispute window then finalize ----------------------------------- //

const prov = await read("get_vow", [Number(vowedId)]);
const disputeEnd = Date.parse(String(prov["dispute_deadline"]));
if (Number.isNaN(disputeEnd)) {
  log(`Cannot parse dispute_deadline (${prov["dispute_deadline"]}); waiting 16 minutes instead.`);
  await sleep(16 * 60_000 + 30_000);
} else {
  const left = disputeEnd - Date.now() + 25_000;
  log(`Dispute window: ${Math.max(0, Math.ceil(left / 60000))} min remaining; waiting it out ...`);
  await sleep(Math.max(left, 0));
}
await write("founder", "finalize", [Number(vowedId)]);
log(`Vow SETTLED: ${JSON.stringify(await read("get_settlement", [Number(vowedId)]))}`);

// ---- 8. pull-based claims ---------------------------------------------- //

// entitlement drops back to zero for the losing side; claim only what is due.
async function tryClaim(who) {
  try {
    const w = await write(who, "claim", [Number(vowedId)]);
    return w.hash;
  } catch (e) {
    log(`${who} claim: ${String(e).message ?? e}`.slice(0, 160));
    return "";
  }
}
const claimHashes = {
  founder: await tryClaim("founder"),
  backerFaith: await tryClaim("backerFaith"),
  backerDoubt: await tryClaim("backerDoubt"),
};
for (const [who, h] of Object.entries(claimHashes)) {
  if (h) log(`claim tx (${who}): ${h}`);
}

// ---- 9. dump everything ------------------------------------------------ //

const views = {
  get_vow: await read("get_vow", [Number(vowedId)]),
  get_backings: await read("get_backings", [Number(vowedId)]),
  get_evidence: ev,
  get_settlement: await read("get_settlement", [Number(vowedId)]),
  get_entitlements: {
    founder: await read("get_entitlement", [Number(vowedId), addrOf.founder]),
    backerFaith: await read("get_entitlement", [Number(vowedId), addrOf.backerFaith]),
    backerDoubt: await read("get_entitlement", [Number(vowedId), addrOf.backerDoubt]),
  },
  get_stats: await read("get_stats", []),
  get_invariant: await read("get_invariant", []),
  get_log: await read("get_log", [64]),
};

const out = {
  contract: rec.address,
  network: NETWORK.name,
  chain_id: NETWORK.chainId,
  vow_id: Number(vowedId),
  vow_text: VOW_TEXT,
  deadline,
  evidence_url: SCRIPT_URL,
  accounts: addrOf,
  txs: { create: created.hash, assess: null, finalize: null, claims: claimHashes },
  verdict,
  verdict_name: VERDICT_NAME[verdict],
  views,
  finished_at: ts(),
};
writeFileSync(join(DEPLOYMENT_DIR, "live-e2e.json"), JSON.stringify(out, null, 2) + "\n");

console.log("\n============== LIVE E2E SUMMARY ==============");
console.log(`contract    : ${rec.address}`);
console.log(`vow         : #${vowedId}`);
console.log(`verdict     : ${VERDICT_NAME[verdict]}`);
console.log(`settlement  : ${JSON.stringify(views.get_settlement)}`);
console.log(`accounting  : ${JSON.stringify(views.get_stats)}`);
console.log(`invariant   : ${JSON.stringify(views.get_invariant)}`);
console.log("full receipts: deployment/live-e2e.json");
