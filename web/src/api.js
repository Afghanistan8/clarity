// Clarity web client — GenLayer Studionet only.
//
// Wallet rules, in one place and enforced everywhere:
//   - The ONLY signer is the injected EIP-1193 provider (window.ethereum).
//   - Reads go straight to the Studionet RPC; wallet signature is needed
//     only for state-changing transactions.
//   - The app refuses to operate on any chain other than 61999 and switches
//     the wallet automatically when possible.

import { createClient, chains } from "genlayer-js";

export const CHAIN = chains.studionet;
export const RPC = "https://studio.genlayer.com/api";
export const CHAIN_ID = 61999;

/** Contract address is baked at build/deploy time; falls back to the
 *  local deployment record file placed under src/contract-address.js.
 *  Re-exported so callers can reference api.CONTRACT_ADDRESS. */
import { CONTRACT_ADDRESS } from "./contract-address.js";
export { CONTRACT_ADDRESS };

export const GEN = 10n ** 18n;

// ------------------------------------------------------------------ //
// wallet plumbing — multi-wallet aware (you may have several injected) //
// ------------------------------------------------------------------ //
//
// Modern wallets announce themselves over EIP-6963; older ones only plant
// globals (window.ethereum / window.okxwallet / window.kplr). When several
// installed, window.ethereum is a race — so we build an explicit list and
// let the user pick. The choice is persisted; OKX is preferred by default.

const CHOICE_KEY = "clarity.wallet";
let _walletList = null;                       // resolved by initWallets()
let _choice = "";
try { _choice = localStorage.getItem(CHOICE_KEY) ?? ""; } catch { /* private mode */ }

function _sortKey(wallet) {
  const n = String(wallet.name ?? "").toLowerCase();
  if (n.includes("okx")) return 0;            // user's preferred wallet
  if (n.includes("metamask")) return 1;
  if (n.includes("kplr")) return 2;
  if (n.includes("coinbase")) return 3;
  return 4;
}

/** Discover every installed EIP-1193 provider and lock in the persisted
 *  choice (or the highest-priority default). Call once at app start. */
export async function initWallets() {
  if (_walletList) return activeWallet();
  const found = new Map();                    // provider object -> wallet
  const add = (wallet) => {
    if (!wallet || !wallet.provider) return;
    const prev = found.get(wallet.provider);
    if (!prev || (wallet.icon && !prev.icon)) found.set(wallet.provider, wallet);
  };
  // 1) EIP-6963 announcements
  const onAnnounce = (e) => {
    const d = e.detail ?? {};
    if (d.info && d.provider) {
      add({
        id: d.info.rdns || d.info.uuid,
        name: d.info.name || "Wallet",
        icon: d.info.icon || null,
        provider: d.provider,
      });
    }
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // 2) well-known globals (wallets without 6963 support)
  if (window.okxwallet) add({ id: "okx-static", name: "OKX", icon: null, provider: window.okxwallet });
  if (window.kplr) add({ id: "kplr-static", name: "KPLR", icon: null, provider: window.kplr });
  // 3) the generic window.ethereum proxy last — it may be ANY wallet above
  if (window.ethereum) {
    const providers = Array.isArray(window.ethereum?.providers)
      ? window.ethereum.providers
      : [window.ethereum];
    for (const p of providers) {
      const name =
        p.isOKExWallet || p.isOkxWallet ? "OKX"
        : p.isMetaMask ? "MetaMask"
        : p.isCoinbaseWallet ? "Coinbase Wallet"
        : p.isKplr ? "KPLR"
        : "Injected wallet";
      add({ id: name.toLowerCase().replace(/\s+/g, "-"), name, icon: null, provider: p });
    }
  }
  // announcements land synchronously in practice; give slower wallets a beat
  await new Promise((r) => setTimeout(r, 300));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);
  _walletList = [...found.values()].sort((a, b) => _sortKey(a) - _sortKey(b));
  // a persisted choice that no longer exists (uninstalled) is forgotten
  if (_choice && !_walletList.some((w) => w.id === _choice)) _choice = "";
  return activeWallet();
}

export function listWallets() {
  return _walletList ?? [];
}

export function activeWallet() {
  if (!_walletList || _walletList.length === 0) return null;
  return _walletList.find((w) => w.id === _choice) ?? _walletList[0];
}

export function chooseWallet(id) {
  _choice = String(id ?? "");
  try { localStorage.setItem(CHOICE_KEY, _choice); } catch { /* private mode */ }
  return activeWallet();
}

export function chosenWalletId() {
  return _choice || null;
}

export function hasWallet() {
  return !!activeWallet();
}

export function walletName() {
  return activeWallet()?.name ?? null;
}

export function provider() {
  const w = activeWallet();
  if (!w) throw new Error("NO_WALLET");
  return w.provider;
}

export async function walletAddresses() {
  return await provider().request({ method: "eth_accounts" });
}

export async function walletChainId() {
  const hex = await provider().request({ method: "eth_chainId" });
  return parseInt(hex, 16);
}

/** Switch (or add) Studionet in the injected wallet. */
export async function ensureStudionet() {
  const p = provider();
  const hexId = await p.request({ method: "eth_chainId" });
  if (parseInt(hexId, 16) === CHAIN_ID) return true;
  try {
    await p.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xf22f" }],
    });
    return true;
  } catch (e) {
    if (e && (e.code === 4902 || e.code === -32603)) {
      await p.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0xf22f",
          chainName: "GenLayer Studionet",
          nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
          rpcUrls: [RPC],
        }],
      });
      return true;
    }
    throw e;               // user rejected the switch — surfaced by callers
  }
}

export async function connectWallet() {
  if (!hasWallet()) throw new Error("NO_WALLET");
  await ensureStudionet();
  const accounts = await provider().request({ method: "eth_requestAccounts" });
  return accounts[0] ?? null;
}

function client(address) {
  // a string account + the chosen injected provider => all signing methods
  // are routed through that wallet; reads are plain RPC.
  return createClient({
    chain: CHAIN,               // carries the Studionet RPC urls
    account: address,           // undefined => read-only client
    provider: hasWallet() ? provider() : undefined,
  });
}

// ------------------------------------------------------------------ //
// read models                                                          //
// ------------------------------------------------------------------ //

async function readOnly() {
  return client(undefined);
}

/** readContract with validation + retries: an RPC hiccup can resolve to
 *  an empty body instead of throwing, which must NEVER be rendered as
 *  state. Empty responses are retried and then surfaced as an error. */
async function rc(functionName, args = []) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200 * attempt));
    try {
      const out = await (await readOnly()).readContract({
        address: CONTRACT_ADDRESS, functionName, args,
      });
      if (out !== undefined && out !== null) return out;
      lastErr = new Error(`RPC returned an empty body for ${functionName}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Opaque bigints / addresses as returned by calldata decoding. */
export async function readConstants() {
  return rc("get_constants");
}

export async function readStats() {
  return rc("get_stats");
}

export async function readInvariant() {
  return rc("get_invariant");
}

export async function readSummaries(limit = 20) {
  return rc("get_vow_summaries", [Number(limit)]);
}

export async function readVow(id) {
  return rc("get_vow", [Number(id)]);
}

export async function readEvidence(id) {
  return rc("get_evidence", [Number(id)]);
}

export async function readSettlement(id) {
  return rc("get_settlement", [Number(id)]);
}

export async function readPreview(id) {
  return rc("get_settlement_preview", [Number(id)]);
}

export async function readBackings(id) {
  return rc("get_backings", [Number(id)]);
}

export async function readLog(lastN = 40) {
  return rc("get_log", [Number(lastN)]);
}

export async function readEntitlement(id, who) {
  return rc("get_entitlement", [Number(id), who]);
}

// ------------------------------------------------------------------ //
// writes (always through the injected wallet)                          //
// ------------------------------------------------------------------ //

async function write(address, functionName, args, value = 0n) {
  const c = client(address);
  const hash = await c.writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    value,
  });
  // best-effort receipt polling; the ledger re-reads state anyway
  let receipt = null;
  try {
    receipt = await c.waitForTransactionReceipt({ hash, interval: 5_000, retries: 120 });
  } catch { /* keep the hash */ }
  return { hash: String(hash), receipt };
}

export async function txCreateVow(address, text, deadline, url, stake) {
  return write(address, "create_vow", [text, deadline, url], stake);
}

export async function txBack(address, id, side, amount) {
  return write(address, "back", [Number(id), side], amount);
}

export async function txAssess(address, id) {
  return write(address, "assess", [Number(id)]);
}

export async function txDispute(address, id) {
  return write(address, "dispute", [Number(id)]);
}

export async function txFinalize(address, id) {
  return write(address, "finalize", [Number(id)]);
}

export async function txSetEvidence(address, id, url) {
  return write(address, "set_evidence", [Number(id), url]);
}

export async function txEarlyCancel(address, id) {
  return write(address, "early_cancel", [Number(id)]);
}

export async function txClaim(address, id) {
  return write(address, "claim", [Number(id)]);
}

// ------------------------------------------------------------------ //
// client-side provenance preview (mirrors the contract tier logic)      //
// ------------------------------------------------------------------ //

const ARCHIVE_HOSTS = [
  "web.archive.org", "archive.ph", "archive.today", "perma.cc", "perma-archives.org",
];
const SNAPSHOT_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"];

export function classifyEvidenceUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { tier: "INVALID", warn: "Not a valid URL." };
  }
  if (u.protocol !== "https:") {
    return { tier: "INVALID", warn: "Only https:// URLs are accepted." };
  }
  if (u.username || u.password) {
    return { tier: "INVALID", warn: "URLs with credentials are not allowed." };
  }
  const host = u.hostname.toLowerCase();
  const isArchive = ARCHIVE_HOSTS.some((a) => host === a || host.endsWith("." + a));
  if (isArchive) return { tier: "SNAPSHOT", warn: "" };
  if (SNAPSHOT_TYPES.some((t) => u.pathname.toLowerCase().endsWith(t.replace("application/", ".")))) {
    return { tier: "SNAPSHOT", warn: "" };
  }
  if (u.search) {
    return { tier: "MUTABLE", warn: "Query parameters make this URL look like a changing resource — FULFILLED verdicts cannot be grounded on it." };
  }
  return {
    tier: "MAYBE_PERMALINK",
    warn: "Static permalink expected: the page must be text-like and carry an ETag or Last-Modified header, otherwise FULFILLED verdicts cannot be grounded (they fold to UNCLEAR).",
  };
}

// ------------------------------------------------------------------ //
// formatting helpers                                                   //
// ------------------------------------------------------------------ //

const VERDICT_NAMES = { 0: "NONE", 1: "FULFILLED", 2: "BROKEN", 3: "UNCLEAR" };
const STATE_NAMES = { 1: "OPEN", 2: "PROVISIONAL", 3: "SETTLED", 4: "CANCELLED" };
const TIER_NAMES = { 0: "NONE", 1: "SNAPSHOT", 2: "PERMALINK", 3: "MUTABLE" };
const PROC_NAMES = { 0: "OK", 1: "BAD_STATUS", 2: "UNREACHABLE", 3: "EMPTY_BODY", 4: "EMPTY_TEXT", 5: "UNPARSEABLE" };

export const names = {
  verdict: (v) => VERDICT_NAMES[Number(v)] ?? String(v),
  state: (s) => STATE_NAMES[Number(s)] ?? String(s),
  tier: (t) => TIER_NAMES[Number(t)] ?? String(t),
  proc: (p) => PROC_NAMES[Number(p)] ?? String(p),
};

export function fmtGEN(v) {
  try {
    const n = BigInt(v);
    const whole = n / GEN;
    const frac = (n % GEN) / (GEN / 10000n);
    return `${whole}.${frac.toString().padStart(4, "0").slice(0, 4)}`.replace(/\.?0+$/, (m) => (m[0] === "." ? "" : m));
  } catch {
    return "0";
  }
}

export function shortAddr(a) {
  const s = typeof a === "string" ? a : String(a);
  if (s.startsWith("0x") && s.length >= 42) return s.slice(0, 8) + "…" + s.slice(-6);
  return s.slice(0, 10);
}

export function tsFormat(s) {
  const t = String(s ?? "");
  if (t === "") return "—";
  const d = new Date(t);
  if (isNaN(+d)) return t;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
