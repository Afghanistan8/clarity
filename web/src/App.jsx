import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "./api.js";

const CHAIN_ID = 61999;

// ---------------------------------------------------------------------- //
// tiny shared bits                                                        //
// ---------------------------------------------------------------------- //

function Pill({ kind, children }) {
  return <span className={`pill pill-${kind}`}>{children}</span>;
}

function Arg({ name, value }) {
  return (
    <div className="arg">
      <span className="arg-name">{name}</span>
      <span className="arg-value">{value}</span>
    </div>
  );
}

function Section({ title, children, right }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function nowTs() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function clip(s, n = 80) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

async function loadDetail(id) {
  const [vow, evidence, settlement, preview, backings, log] = await Promise.all([
    api.readVow(Number(id)),
    api.readEvidence(Number(id)),
    api.readSettlement(Number(id)),
    api.readPreview(Number(id)),
    api.readBackings(Number(id)),
    api.readLog(60),
  ]);
  const asList = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));
  return {
    vow,
    evidence,
    settlement,
    preview,
    backings: asList(backings),
    log: asList(log).filter((l) => Number(l["vow"]) === Number(id)),
  };
}

// ---------------------------------------------------------------------- //
// App                                                                     //
// ---------------------------------------------------------------------- //

export default function App() {
  const [wallet, setWallet] = useState(null);        // { address, wrong }
  const [noWallet, setNoWallet] = useState(false);
  const [stats, setStats] = useState(null);
  const [invariant, setInvariant] = useState(null);
  const [constants, setConstants] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [detail, setDetail] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [txPending, setTxPending] = useState(false);
  const [toast, setToast] = useState(null);

  const flash = useCallback((msg, kind = "ok") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 7000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [st, inv, cs, rows] = await Promise.all([
        api.readStats(), api.readInvariant(), api.readConstants(),
        api.readSummaries(16),
      ]);
      setStats(st);
      setInvariant(inv);
      setConstants(cs);
      setLedger(Array.isArray(rows) ? rows : Object.values(rows ?? {}));
    } catch (e) {
      console.error(e);
      flash("Could not read contract state: " + clip(String(e?.message ?? e)), "err");
    }
  }, [flash]);

  useEffect(() => { refresh(); }, [refresh]);

  // wallet wiring (EIP-1193 events + a light poll as a fallback)
  useEffect(() => {
    if (!api.hasWallet()) { setNoWallet(true); return; }
    const onAccounts = (accs) =>
      setWallet((w) => ({ address: accs?.[0] ?? null, wrong: w ? w.wrong : false }));
    const syncChain = async () => {
      try {
        const cid = await api.walletChainId();
        setWallet((w) => (w ? { ...w, wrong: cid !== CHAIN_ID } : w));
      } catch { /* ignore */ }
    };
    window.ethereum.on?.("accountsChanged", onAccounts);
    window.ethereum.on?.("chainChanged", syncChain);
    api.walletAddresses()
      .then((accs) => { if (accs?.[0]) setWallet({ address: accs[0], wrong: false }); })
      .catch(() => {});
    syncChain();
    const t = setInterval(syncChain, 4000);
    return () => {
      clearInterval(t);
      window.ethereum.removeListener?.("accountsChanged", onAccounts);
      window.ethereum.removeListener?.("chainChanged", syncChain);
    };
  }, []);

  const connect = async () => {
    try {
      const a = await api.connectWallet();
      setWallet({ address: a, wrong: false });
      flash("Wallet connected. Chain locked to Studionet (61999).");
    } catch (e) {
      if (String(e?.message ?? e).includes("NO_WALLET")) setNoWallet(true);
      else flash("Connect failed: " + clip(String(e?.message ?? e)), "err");
    }
  };

  const correctNetwork = async () => {
    try {
      await api.ensureStudionet();
      flash("Wallet switched to Studionet.");
      setWallet((w) => (w ? { ...w, wrong: false } : w));
    } catch (e) {
      flash("Switch rejected or failed: " + clip(String(e?.message ?? e)), "err");
    }
  };

  const wrongNetwork = wallet?.address && wallet.wrong;

  const run = useCallback(async (label, fn) => {
    if (!wallet?.address) { flash("Connect a wallet first.", "err"); return false; }
    if (wrongNetwork) { flash("Wrong network. Switch to Studionet (61999) first.", "err"); return false; }
    if (txPending) { flash("A transaction is already in flight.", "err"); return false; }
    setTxPending(true);
    try {
      const { hash } = await fn(wallet.address);
      flash(`${label} submitted — tx ${String(hash).slice(0, 14)}… (finalizes when consensus lands)`);
      setTimeout(refresh, 5000);
      setTimeout(refresh, 15000);
      setTimeout(refresh, 40000);
      return true;
    } catch (e) {
      flash(`${label}: ${clip(String(e?.message ?? e))}`, "err");
      return false;
    } finally {
      setTxPending(false);
    }
  }, [wallet, wrongNetwork, txPending, refresh, flash]);

  const open = useCallback(async (id) => {
    try {
      setDetail(await loadDetail(id));
      setDetailId(Number(id));
    } catch (e) {
      flash("Could not load vow: " + clip(String(e?.message ?? e)), "err");
    }
  }, [flash]);

  // keep the open drawer fresh
  useEffect(() => {
    if (detailId === null) return;
    const t = setInterval(async () => {
      try { setDetail(await loadDetail(detailId)); } catch { /* ignore */ }
    }, 6000);
    return () => clearInterval(t);
  }, [detailId]);

  return (
    <div className="page">
      <Header
        wallet={wallet} noWallet={noWallet} wrongNetwork={wrongNetwork}
        connect={connect} sw={correctNetwork} stats={stats}
      />
      {wallet?.address && wrongNetwork && (
        <div className="banner banner-warn">
          Your wallet is on a different chain. Clarity operates <b>only on Studionet (61999)</b>.
          <button className="btn" onClick={correctNetwork}>Switch to Studionet</button>
        </div>
      )}
      {noWallet && (
        <div className="banner banner-warn">
          No injected EIP-1193 wallet detected. Reads work without one; install MetaMask or any
          EIP-1193 wallet to create, back or claim.
          <button className="btn" onClick={connect}>Check again</button>
        </div>
      )}
      {toast && <div className={`toast toast-${toast.kind}`}>{toast.msg}</div>}

      <TrustModel invariant={invariant} constants={constants} />
      <CreateVow
        run={run} constants={constants} refresh={refresh} txPending={txPending}
        wrongNetwork={wrongNetwork} hasWallet={!!wallet?.address}
      />
      <Ledger ledger={ledger} open={open} refresh={refresh} />
      {txPending && (
        <div className="inflight">
          Transaction in flight — the validator panel is working; the ledger refreshes on its own.
        </div>
      )}

      {detail && (
        <Drawer
          d={detail} close={() => { setDetail(null); setDetailId(null); }}
          myAddress={wallet?.address} wrongNetwork={wrongNetwork} hasWallet={!!wallet?.address}
          run={run} refresh={refresh}
        />
      )}

      <footer className="footer">
        <div>
          contract <code>{api.CONTRACT_ADDRESS}</code> · chain Studionet (61999) · RPC {api.RPC}
        </div>
        <div>no admin keys · no upgrade path · pull-based claims · fail-closed settlement</div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------- //
// header + trust strip                                                    //
// ---------------------------------------------------------------------- //

function Header({ wallet, noWallet, wrongNetwork, connect, sw, stats }) {
  const addr = wallet?.address;
  return (
    <header className="header">
      <div className="brand">
        <h1>Clarity</h1>
        <p>public promises with real stakes — evidence judged by consensus, settled by arithmetic</p>
      </div>
      <div className="header-side">
        <div className="stats-mini">
          <Arg name="escrow" value={stats ? api.fmtGEN(stats["escrow"]) + " GEN" : "…"} />
          <Arg name="burned" value={stats ? api.fmtGEN(stats["burned_total"]) + " GEN" : "…"} />
        </div>
        {addr && !wrongNetwork && <Pill kind="ok">{api.shortAddr(addr)}</Pill>}
        {noWallet && <Pill kind="warn">no wallet</Pill>}
        {!noWallet && !addr && <button className="btn btn-primary" onClick={connect}>Connect wallet</button>}
        {addr && wrongNetwork && <button className="btn btn-warn" onClick={sw}>Wrong network</button>}
      </div>
    </header>
  );
}

function TrustModel({ invariant: inv, constants }) {
  return (
    <Section title="Trust model">
      <div className="trust">
        <div className="card">
          <h3>How a vow lives and dies</h3>
          <p><b>1 · Founding.</b> A founder posts a stake against a concrete promise, a deadline, and one evidence URL. The stake is escrowed immediately.</p>
          <p><b>2 · Backing.</b> Anyone can <b>doubt</b> with GEN; <b>faith</b> can only exist after doubt — faith may never exceed doubt, so hope is always collateralized by scepticism.</p>
          <p><b>3 · Assessment.</b> After the deadline, consensus validators independently fetch the evidence page and judge it. FULFILLED requires a verbatim quote (&ge; 48 chars) from a snapshot or permalink provenance, dated on or before the deadline — anything else folds to UNCLEAR. Unreadable pages are never a verdict of success (fail-closed).</p>
          <p><b>4 · Dispute.</b> For 15 minutes, counter-evidence can <b>only demote</b> a verdict (FULFILLED→BROKEN, …→UNCLEAR). Improvements never happen silently.</p>
          <p><b>5 · Settlement.</b> Deterministic arithmetic: FULFILLED returns the stake and streams the doubter pool to the faithful; BROKEN burns half the stake and pays doubters; UNCLEAR refunds everyone. Proportional shares round down; remainder dust burns. Claims are pull-based; unclaimed funds rest — nothing is swept.</p>
        </div>
        <div className="card">
          <h3>Constraints you can check live</h3>
          <Arg name="admin & owner keys" value="0 — none exist in the contract" />
          <Arg name="upgrade path" value="none — closed immutable bytecode" />
          <Arg name="claims" value="pull-based; contract never moves value except to a caller" />
          {inv && (
            <Arg name="accounting invariant" value={inv["consistent"] === true
              ? "consistent ✓ (escrow = unfinalized + outstanding + burned + dispatched)"
              : "VIOLATION ✗"}/>
          )}
          {inv && <>
            <Arg name="value held" value={api.fmtGEN(inv["escrow"]) + " GEN"} />
            <Arg name="awaiting pulls" value={api.fmtGEN(inv["outstanding"]) + " GEN"} />
            <Arg name="burned publicly" value={api.fmtGEN(inv["burned_total"]) + " GEN"} />
            <Arg name="already paid out" value={api.fmtGEN(inv["dispatched"]) + " GEN"} />
          </>}
          {constants && <>
            <Arg name="min vow stake" value={api.fmtGEN(constants["min_vow_stake"]) + " GEN"} />
            <Arg name="min backing" value={api.fmtGEN(constants["min_backing"]) + " GEN"} />
            <Arg name="quote floor" value={constants["min_quote_len"] + " chars verbatim"} />
            <Arg name="dispute window" value={constants["dispute_window_sec"] + " seconds"} />
            <Arg name="assessments per vow" value={String(constants["max_assessments"]) + " (initial + disputes)"} />
          </>}
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------- //
// creation form                                                           //
// ---------------------------------------------------------------------- //

function CreateVow({ run, constants, refresh, txPending, wrongNetwork, hasWallet }) {
  const [text, setText] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("12:00");
  const [url, setUrl] = useState("");

  const txt = text.trim();
  const MAX_TEXT = 2000;   // must match the contract's MAX_VOW_TEXT
  const MIN_STAKE = 10n * api.GEN;

  const prov = (txt.length > 0 && url) ? api.classifyEvidenceUrl(url) : null;

  const errors = useMemo(() => {
    const out = [];
    if (txt.length === 0) out.push("Promise text cannot be empty.");
    if (txt.length > MAX_TEXT) out.push(`Text is ${txt.length} chars; limit is ${MAX_TEXT}.`);
    if (!date) out.push("Deadline date is required.");
    if (date) {
      const dl = new Date(`${date}T${time}:00Z`);
      if (isNaN(+dl)) out.push("Deadline is invalid.");
      else if (dl.getTime() + 5e3 <= Date.now())
        out.push("Deadline must be at least a few seconds in the future.");
      else if (dl.getTime() - Date.now() > 366 * 24 * 3600e3)
        out.push("Deadline is more than a year out.");
    }
    if (url) {
      const c = api.classifyEvidenceUrl(url);
      if (c.tier === "INVALID") out.push(c.warn);
      else if (c.tier === "MUTABLE") out.push(c.warn);
    }
    return out;
  }, [txt, date, time, url]);

  const deadlineStr = date ? `${date}T${time}:00Z` : "";

  const submit = async () => {
    const ok = await run("create_vow", (a) => api.txCreateVow(a, txt, deadlineStr, url.trim(), MIN_STAKE));
    if (ok) {
      setText(""); setUrl(""); setDate(""); setTime("12:00");
      refresh();
    }
  };

  return (
    <Section title="Make a vow">
      <div className="card create">
        <label>Promise (≤ {MAX_TEXT} chars, concrete and publicly checkable)</label>
        <textarea
          rows={3} value={text} maxLength={MAX_TEXT + 40}
          onChange={(e) => setText(e.target.value)}
          placeholder="Example: The community garden will have running water by the deadline — with one fixed page documenting it."
        />
        <div className="row">
          <div>
            <label>Deadline (UTC)</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="grow">
            <label>Evidence page (https permalink or archive snapshot)</label>
            <input
              type="url" value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://web.archive.org/web/…  or  https://example.org/proof.html"
            />
            {prov && (
              <div className={`prov prov-${prov.tier}`}>
                <Pill kind={prov.tier === "MUTABLE" || prov.tier === "INVALID" ? "warn" : "ok"}>
                  provenance: {prov.tier === "MAYBE_PERMALINK" ? "permalink (static text + ETag)" : prov.tier}
                </Pill>
                {prov.warn && <small>{prov.warn}</small>}
              </div>
            )}
          </div>
        </div>

        <div className="create-foot">
          <span>stake <b>10 GEN</b> (minimum) sent with the transaction</span>
          {constants && (
            <span className="muted">
              backing min {api.fmtGEN(constants["min_backing"])} GEN · dispute window {constants["dispute_window_sec"]} s
            </span>
          )}
        </div>

        {errors.length > 0 && (
          <div className="warn-lines">{errors.map((e) => <div key={e}>{e}</div>)}</div>
        )}

        <button className="btn btn-primary btn-big" disabled={txPending} onClick={submit}>
          {hasWallet
            ? (wrongNetwork ? "Switch to Studionet first" : "Stake 10 GEN — create vow")
            : "Connect a wallet"}
        </button>
        <p className="muted small">
          Cancelling before the deadline refunds the founder fully. After the deadline the evidence page is
          fetched and judged by a panel of independent validators — nobody (including the founder) can
          bury a promise once its deadline passes.
        </p>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------- //
// ledger                                                                  //
// ---------------------------------------------------------------------- //

function Ledger({ ledger, open, refresh }) {
  return (
    <Section title="Ledger" right={<button className="btn" onClick={refresh}>refresh</button>}>
      {ledger.length === 0 && <p className="muted">No vows yet — be the first to stake.</p>}
      <div className="ledger">
        {ledger.map((row) => <LedgerRow key={String(row["id"])} row={row} open={open} />)}
      </div>
    </Section>
  );
}

function LedgerRow({ row, open }) {
  const state = api.names.state(row["state"]);
  return (
    <button className="row" onClick={() => open(row["id"])}>
      <div className="row-top">
        <span className="vow-id">#{String(row["id"])}</span>
        <span className="vow-text">{clip(row["text_head"], 116)}</span>
        <div className="row-pills">
          <Pill kind={state === "OPEN" ? "ok" : state === "PROVISIONAL" ? "warn"
            : state === "SETTLED" ? "info" : "dim"}>{state}</Pill>
        </div>
      </div>
      <div className="row-bottom">
        <span>deadline {api.tsFormat(row["deadline"])}</span>
        <span>stake {api.fmtGEN(row["stake"])} GEN</span>
        <span>faith {api.fmtGEN(row["faith_total"])} GEN · doubt {api.fmtGEN(row["doubt_total"])} GEN</span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------- //
// detail drawer                                                           //
// ---------------------------------------------------------------------- //

function Drawer({ d, close, myAddress, wrongNetwork, run, refresh }) {
  const { vow, evidence, settlement, preview, backings, log } = d;
  const id = Number(vow["id"]);
  const state = api.names.state(vow["state"]);
  const verdict = settlement?.["none"] ? null : api.names.verdict(settlement["verdict"]);
  const [mine, setMine] = useState(null);
  const [claimRunning, setClaimRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      if (!myAddress) return;
      try {
        const ent = await api.readEntitlement(id, myAddress);
        if (alive) setMine(ent);
      } catch { /* ignore */ }
    };
    pull();
    const t = setInterval(pull, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [id, myAddress]);

  return (
    <div className="drawer-back" onClick={close}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span className="vow-id">vow #{id}</span>
          <Pill kind={state === "OPEN" ? "ok" : state === "PROVISIONAL" ? "warn"
            : state === "SETTLED" ? "info" : "dim"}>{state}</Pill>
          {verdict && verdict !== "NONE" && (
            <Pill kind={verdict === "FULFILLED" ? "ok" : verdict === "BROKEN" ? "bad" : "dim"}>{verdict}</Pill>
          )}
          <button className="btn btn-ghost" onClick={close}>close</button>
        </div>

        <blockquote className="vow-text-full">{String(vow["text"])}</blockquote>
        <div className="grid2">
          <Arg name="founder" value={api.shortAddr(String(vow["proposer"]))} />
          <Arg name="stake" value={api.fmtGEN(vow["stake"]) + " GEN"} />
          <Arg name="deadline" value={api.tsFormat(vow["deadline"])} />
          <Arg name="created" value={api.tsFormat(vow["created_at"])} />
          <Arg name="faith pool" value={api.fmtGEN(vow["faith_total"]) + " GEN"} />
          <Arg name="doubt pool" value={api.fmtGEN(vow["doubt_total"]) + " GEN"} />
          <Arg name="evidence page" value={
            <a href={String(vow["evidence_url"])} target="_blank" rel="noreferrer">
              {clip(String(vow["evidence_url"]), 46)}
            </a>} />
          <Arg name="assessments" value={`${Number(vow["assessed_n"])} · disputes used ${Number(vow["dispute_n"])}`} />
        </div>

        {state === "OPEN" && (
          <BackWidget id={id} wrongNetwork={wrongNetwork} run={run} />
        )}

        {state === "OPEN" && String(vow["deadline"]) < nowTs() && (
          <div className="actions">
            <button className="btn btn-primary" onClick={() => run("assess", (a) => api.txAssess(a, id))}>
              Deadline passed — fetch the page and let the panel judge
            </button>
          </div>
        )}

        {evidence?.["none"] !== true && state !== "OPEN" && <EvidenceBar evidence={evidence} />}

        {settlement?.["none"] !== true && (
          <SettlementView settlement={settlement} preview={preview} provisional={state === "PROVISIONAL"} />
        )}

        {state === "PROVISIONAL" && String(vow["dispute_deadline"]) > nowTs() && (
          <div className="actions">
            <button className="btn btn-warn" onClick={() => run("dispute", (a) => api.txDispute(a, id))}>
              Dispute with counter-evidence (window until {api.tsFormat(vow["dispute_deadline"])})
            </button>
            <small className="muted">A dispute re-runs the whole panel assessment. It can only demote the current verdict.</small>
          </div>
        )}

        {state === "PROVISIONAL" && String(vow["dispute_deadline"]) <= nowTs() && (
          <div className="actions">
            <button className="btn btn-primary" onClick={() => run("finalize", (a) => api.txFinalize(a, id))}>
              Dispute window closed — finalize the verdict
            </button>
          </div>
        )}

        {state === "SETTLED" && myAddress && (
          <ClaimWidget
            mine={mine}
            claimRunning={claimRunning}
            onClaim={async () => {
              setClaimRunning(true);
              const ok = await run("claim", (a) => api.txClaim(a, id));
              setClaimRunning(false);
              if (ok) refresh();
            }}
          />
        )}

        <h3>Backings</h3>
        <div className="backings">
          {backings.length === 0 && <p className="muted">no backings</p>}
          {backings.map((b) => (
            <div key={String(b["address"])} className="backing">
              <Pill kind={b["side"] === "FAITH" ? "ok" : "warn"}>{String(b["side"])}</Pill>
              <span className="mono">{api.shortAddr(String(b["address"]))}</span>
              <span>{api.fmtGEN(b["amount"])} GEN</span>
            </div>
          ))}
        </div>

        <h3>Receipts (on-chain audit log)</h3>
        <div className="receipts">
          {log.length === 0 && <p className="muted">no entries</p>}
          {log.slice().reverse().map((l, i) => (
            <div key={i} className="logline">
              <span className="mono muted">{api.tsFormat(l["ts"])}</span>
              <b>{String(l["code"])}</b>
              <span className="muted">{String(l["detail"])}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BackWidget({ id, wrongNetwork, run }) {
  const [side, setSide] = useState(null);
  const [amt, setAmt] = useState(1);
  return (
    <div className="actions back-widget">
      <button className={`btn ${side === 2 ? "btn-warn" : ""}`} onClick={() => setSide(2)}>
        {side === 2 ? "✓ " : ""}DOUBT
      </button>
      <button className={`btn ${side === 1 ? "btn-ok" : ""}`} onClick={() => setSide(1)}>
        {side === 1 ? "✓ " : ""}FAITH
      </button>
      <input type="number" min={1} value={amt} onChange={(e) => setAmt(Number(e.target.value))} /> GEN
      <button
        className="btn btn-primary"
        disabled={!side || amt < 1 || wrongNetwork}
        onClick={() => run("back", (a) => api.txBack(a, id, side, BigInt(amt) * api.GEN))}
      >
        Commit {amt} GEN
      </button>
      <small className="muted">
        Doubt wins on BROKEN (and shares in refunds). Faith wins only on FULFILLED — and only if the
        page carries a decisive quote. The contract caps faith at the doubt total.
      </small>
    </div>
  );
}

function EvidenceBar({ evidence }) {
  const tier = api.names.tier(evidence["tier"]);
  const proc = api.names.proc(evidence["procedure"]);
  const grounded = evidence["contained"] === true && String(evidence["quote"] ?? "") !== "";
  return (
    <div className="card evidence">
      <h3>Evidence (fetched and judged by the validator panel)</h3>
      <div className="grid2">
        <Arg name="page" value={
          <a href={String(evidence["url"])} target="_blank" rel="noreferrer">
            {clip(String(evidence["url"]), 44)}
          </a>} />
        <Arg name="http status" value={String(evidence["status"])} />
        <Arg name="procedure" value={proc} />
        <Arg name="provenance" value={tier} />
        <Arg name="fetched at" value={api.tsFormat(evidence["assessed_at"])} />
        <Arg name="page date" value={String(evidence["page_date"] ?? "") || "—"} />
        <Arg name="body sha256" value={<code className="mono">{clip(evidence["content_sha256"], 20)}</code>} />
        <Arg name="text sha256" value={<code className="mono">{clip(evidence["text_sha256"], 20)}</code>} />
      </div>
      {grounded ? (
        <blockquote>"{String(evidence["quote"])}"<span className="muted"> — verbatim on page ✓</span></blockquote>
      ) : (
        <p className="muted">
          No quote is anchored here: procedural failure ({proc}) or an ungrounded judgment — recorded
          as-is, never laundered into success.
        </p>
      )}
    </div>
  );
}

function SettlementView({ settlement, preview, provisional }) {
  const rows = [
    ["verdict", api.names.verdict(settlement["verdict"])],
    ["decided by", String(settlement["reason"])],
    ["public burn", api.fmtGEN(settlement["burned"]) + " GEN"],
    ["to founder", api.fmtGEN(settlement["to_proposer"]) + " GEN"],
    ["faith pool", api.fmtGEN(settlement["to_faith"]) + " GEN"],
    ["doubt pool", api.fmtGEN(settlement["to_doubt"]) + " GEN"],
    ["finalized at", api.tsFormat(settlement["finalized_at"])],
  ];
  return (
    <div className="card settle">
      <h3>Settlement {provisional ? "(provisional)" : ""}</h3>
      {rows.map(([k, v]) => <Arg key={k} name={k} value={v} />)}
      {provisional && preview?.["none"] !== true && (
        <p className="muted small">
          final preview: {api.names.verdict(preview["verdict"])}, burn {api.fmtGEN(preview["burned"])} GEN,
          total entitlement {api.fmtGEN(preview["entitlement_total"])} GEN
        </p>
      )}
    </div>
  );
}

function ClaimWidget({ mine, claimRunning, onClaim }) {
  if (!mine) {
    return <div className="card"><p className="muted">checking your entitlements…</p></div>;
  }
  if (mine["present"] !== true) {
    return <div className="card"><p className="muted">Nothing is owed to you for this vow.</p></div>;
  }
  if (mine["claimed"] === true) {
    return <div className="card"><p>Your payout is claimed ✓</p></div>;
  }
  return (
    <div className="card claim">
      <b>{api.fmtGEN(mine["amount"])} GEN</b> is waiting for you.
      <button className="btn btn-primary" onClick={onClaim} disabled={claimRunning}>
        {claimRunning ? "claiming…" : "Claim payout (pull-based)"}
      </button>
    </div>
  );
}
