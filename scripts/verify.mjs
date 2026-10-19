// Verify a deployed Clarity instance against the local sources.
//
// 1. Re-computes the SHA-256 manifest and compares it with the stored
//    deployment/manifest.json (proves sources were not touched since the
//    manifest was written).
// 2. Fetches the on-chain source of the deployed contract and compares it
//    byte-for-byte (modulo newline normalization) with the local file.

import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ROOT, DEPLOYMENT_DIR, NETWORK, guardChain, guardCliNetwork, cli, die, sha256File,
  buildManifest, readDeployment, MANIFEST_NAME, STUDIO_NAME,
} from "./common.mjs";

const norm = (s) => s.replace(/\r\n/g, "\n").replace(/\s*$/, "");

await guardChain();
guardCliNetwork();

const rec = readDeployment(STUDIO_NAME);
const stored = { ...readDeployment(MANIFEST_NAME) };

// ---- manifest integrity ------------------------------------------------ //
delete stored["created_at"];
const fresh = buildManifest();
if (JSON.stringify(fresh) !== JSON.stringify(stored)) {
  die("Source tree changed since the manifest was written — regenerate the manifest or redeploy.");
}
console.log("Manifest OK — working tree matches the deployment manifest.");

// ---- on-chain source --------------------------------------------------- //
console.log(`\nFetching on-chain code of ${rec.address} ...`);
const r = cli("code", [rec.address, "--rpc", NETWORK.rpc], { tolerant: true, timeout: 180_000 });
if (!r.ok) die("Could not read on-chain code:\n" + r.output);

const printed = r.output;
const idx = printed.indexOf("Result:");
if (idx < 0) die("Unexpected `genlayer code` output:\n" + printed.slice(0, 400));
// the CLI decorates the source with spinner lines; the code itself runs from
// the Depends header to the end of the result block
let source = printed.slice(idx + "Result:".length);
const stopAt = source.search(/\n- Getting code for contract at|\n✔ Contract code retrieved successfully|\n\[genlayer-js\]/);
if (stopAt > 0) source = source.slice(0, stopAt);
source = norm(source.replace(/^( *)\n/, ""));

const local = norm((await import("node:fs")).readFileSync(join(ROOT, "contracts", "clarity.py"), "utf8"));
if (source === local) {
  console.log("On-chain source: EXACT MATCH with contracts/clarity.py (SHA-256 " +
    sha256File(join(ROOT, "contracts", "clarity.py")).slice(0, 24) + "...)");
} else {
  writeFileSync(join(DEPLOYMENT_DIR, "onchain-code.txt"), source);
  die("On-chain source MISMATCH — dumped to deployment/onchain-code.txt for diffing.");
}
console.log("Verification complete.");
