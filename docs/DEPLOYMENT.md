# Clarity — deployment

## Locked network

Everything in `scripts/` refuses to run against anything other than
**Studionet** — chain id **61999**, RPC `https://studio.genlayer.com/api`:

- `scripts/common.mjs::guardChain()` queries `eth_chainId` over the RPC and
  aborts unless it is `0xf22f` (61999).
- `guardCliNetwork()` also checks the genlayer CLI's own active network
  (`genlayer config get`) so the deploy tool and the guards cannot disagree.

## Toolchain

- genlayer CLI (`npm i -g genlayer`), configured with
  `genlayer network set studionet` and an unlocked keystore account
  (`genlayer account unlock --account <name> ...`).
- Node ≥ 20 for the scripts (`package.json` pins `genlayer-js` **1.1.8**).

## What was deployed

| Field           | Value                                                              |
|-----------------|--------------------------------------------------------------------|
| Contract        | `contracts/clarity.py` (constructor takes no arguments)            |
| Network         | Studionet (61999)                                                   |
| Address         | `0xABefC872823aB9aF8246c3E883529bBa4428bbF5`                         |
| Deploy tx       | `0xd4b6bf6d921afc6b7b2c110cbb693a51fb2a20d7a9bcd28cc71a30d3ca784e9d`|
| Deployed        | 2026-10-19, by keystore account `deployer` (`0x4184bc…b0df3`)      |
| Record          | `deployment/studionet.json`                                         |

The CLI prints the address & tx hash; `deploy.mjs` parses exactly that
output, and a live `genlayer call ... get_stats` (successful, `vow_count: 0`)
confirmed the deployed instance immediately after.

## SHA manifest

`scripts/deploy.mjs` writes `deployment/manifest.json` before deploying:
SHA-256 over every deployed source (contract, scripts, demo evidence, test
mirror, web entry). `scripts/verify.mjs` then

1. re-computes the manifest and compares (source drift detection), and
2. reads the on-chain source via `genlayer code <address>` and byte-compares
   it with the local contract file.

```
node scripts/deploy.mjs     # guarded deploy + manifest
node scripts/verify.mjs     # manifest + on-chain byte comparison
```

## Redeploying from scratch

```bash
# 1. toolchain
python -m pip install -r requirements-dev.txt      # tests
npm install                                        # scripts toolchain (pinned)

# 2. CLI configuration (network + an unlocked account with GEN)
genlayer network set studionet
genlayer account unlock --account <your-account> --password <pw>

# 3. run the test suite to make sure you are deploying what was audited
python -m pytest tests/ -q

# 4. deploy + verify
node scripts/deploy.mjs
node scripts/verify.mjs

# 5. point the web app at the new address (web/src/contract-address.js)
#    and rebuild the bundle
cd web && npm install && npm run build
```

## Live end-to-end

`scripts/e2e.mjs` runs the complete vow lifecycle on Studionet with throwaway
accounts generated for the run (keys land in `deployment/e2e-keys.json`,
gitignored) and funded from the CLI keystore account via
`genlayer account send`. It records the entire run (tx hashes, evidence,
settlement, claims, invariant) into `deployment/live-e2e.json`. See
`docs/END_TO_END.md` for the recorded run.

The E2E depends on `https://raw.githubusercontent.com/Afghanistan8/clarity/main/demo/evidence.md`
existing (it fetches and checks the exact quote before starting), so the
repository must be pushed first.

## Call / write without the scripts

```bash
genlayer call   0xABefC872823aB9aF8246c3E883529bBa4428bbF5 get_constants
genlayer call   0xABefC872823aB9aF8246c3E883529bBa4428bbF5 get_invariant
genlayer write  0xABefC872823aB9aF8246c3E883529bBa4428bbF5 <method> [--args ...]
```

Note: `genlayer write` cannot attach message value (the CLI hardcodes
`value: 0`); stake- and backing-bearing calls must go through `genlayer-js`
(`writeContract({ ..., value })`) as `scripts/e2e.mjs` and the web app do.
