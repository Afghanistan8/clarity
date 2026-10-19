// Deploy the Clarity contract to Studionet.
//
// - Refuses to run against any network other than Studionet (chain id 61999).
// - Writes a SHA-256 manifest of every source that is being deployed.
// - Deploys via the genlayer CLI using its unlocked keystore account.
// - Records the address, transaction and manifest in deployment/studionet.json.

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ROOT, DEPLOYMENT_DIR, CONTRACT, NETWORK, guardChain, guardCliNetwork, cli,
  die, writeManifest,
} from "./common.mjs";

if (!existsSync(CONTRACT)) die("contracts/clarity.py not found.");

await guardChain();
guardCliNetwork();

// 1. deterministic fingerprint of everything being deployed
const manifest = writeManifest();

// 2. deploy through the CLI (uses the keystore account marked active)
console.log("\nDeploying contracts/clarity.py ...");
const r = cli("deploy", [
  "--contract", "contracts/clarity.py",
  "--rpc", NETWORK.rpc,
], { timeout: 15 * 60_000 });
console.log(r.output.trim());

// 3. extract the address and transaction id from the CLI output
//    format: {'Transaction Hash': '0x...', 'Contract Address': '0x...'}
const printed = r.output.trim();
const addrM = printed.match(/Contract Address['"]?\s*[:=]\s*['"]?(0x[a-fA-F0-9]{40})/);
const txM = printed.match(/Transaction Hash['"]?\s*[:=]\s*['"]?(0x[a-fA-F0-9]{64})/);
if (!addrM) {
  die("Deployment did not produce a 'Contract Address' in its output.");
}

// 4. deployment record
const record = {
  contract: "clarity",
  network: NETWORK.name,
  chain_id: NETWORK.chainId,
  rpc: NETWORK.rpc,
  address: addrM[1],
  tx_id: txM ? txM[1] : "",
  deployed_at: new Date().toISOString(),
  manifest_sha256: manifest.manifest_sha256,
};
mkdirSync(DEPLOYMENT_DIR, { recursive: true });
const recPath = join(DEPLOYMENT_DIR, "studionet.json");
writeFileSync(recPath, JSON.stringify(record, null, 2) + "\n");

console.log("\nDeployment OK");
console.log(`  address:  ${record.address}`);
console.log(`  tx:       ${record.tx_id || "(not reported)"}`);
console.log(`  manifest: ${manifest.manifest_sha256}`);
console.log(`  record:   ${relative(ROOT, recPath)}`);
