import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api.js";

const CHAIN_ID = 61999;

// ---------------------------------------------------------------------- //
// tiny shared bits                                                        //
// ---------------------------------------------------------------------- //

function Pill({ kind = "dim", children }) {
  return <span className={`pill pill-${kind}`}>{children}</span>;
}

function StatePill({ state }) {
  const name = api.names.state(state);
  const kind = name === "OPEN" ? "ok" : name === "PROVISIONAL" ? "warn"
    : name === "SETTLED" ? "info" : "dim";
  return <Pill kind={kind}>{name}</Pill>;
}

function VerdictPill({ verdict }) {
  const name = api.names.verdict(verdict);
  if (!name || name === "NONE") return null;
  const kind = name === "FULFILLED" ? "ok" : name === "BROKEN" ? "bad" : "info";
  return <Pill kind={kind}>{name}</Pill>;
}

function Section({ eyebrow, title, sub, right, children }) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <h2>{title}</h2>
          {sub && <p className="section-sub">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function tile(x) {
  return String(x ?? "").trim();
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
    api.readLog(80),
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
  const [now, setNow] = useState(nowTs());
  const [loaded, setLoaded] = useState(false);

  const flash = useCallback((msg, kind = "ok") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 7000);
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    try {
      const [st, inv, cs, rows] = await Promise.all([
        api.readStats(), api.readInvariant(), api.readConstants(),
        api.readSummaries(20),
      ]);
      setStats(st);
      setInvariant(inv);
      setConstants(cs);
      setLedger(Array.isArray(rows) ? rows : Object.values(rows ?? {}));
      setNow(nowTs());
      setLoaded(true);
    } catch (e) {
      console.error(e);
      if (!quiet) flash("Could not read contract state — retrying in the background: " + clip(String(e?.message ?? e)), "err");
    }
  }, [flash]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => setNow(nowTs()), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // the Studionet RPC occasionally drops in and out — keep trying quietly
  // until the first successful load, then refresh on a slow background cadence
  useEffect(() => {
    if (loaded) return;
    const t = setInterval(() => refresh(true), 5000);
    return () => clearInterval(t);
  }, [loaded, refresh]);

  useEffect(() => {
    if (!loaded) return;
    const t = setInterval(() => refresh(true), 45000);
    return () => clearInterval(t);
  }, [loaded, refresh]);

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
      .catch(() => { });
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
      flash("Wallet connected · chain locked to Studionet");
    } catch (e) {
      if (String(e?.message ?? e).includes("NO_WALLET")) setNoWallet(true);
      else flash("Connect failed: " + clip(String(e?.message ?? e)), "err");
    }
  };

  const correctNetwork = async () => {
    try {
      await api.ensureStudionet();
      flash("Wallet switched to Studionet");
      setWallet((w) => (w ? { ...w, wrong: false } : w));
    } catch (e) {
      flash("Switch rejected or failed: " + clip(String(e?.message ?? e)), "err");
    }
  };

  const wrongNetwork = wallet?.address && wallet.wrong;

  const run = useCallback(async (label, fn) => {
    if (!wallet?.address) { flash("Connect a wallet first.", "err"); return false; }
    if (wrongNetwork) { flash("Wrong network — switch to Studionet (61999) first.", "err"); return false; }
    if (txPending) { flash("A transaction is already in flight.", "err"); return false; }
    setTxPending(true);
    try {
      const { hash } = await fn(wallet.address);
      flash(`${label} submitted — tx ${String(hash).slice(0, 12)}…`);
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
    }, 7000);
    return () => clearInterval(t);
  }, [detailId]);

  const invOk = invariant?.["consistent"] === true;
  const invBad = invariant?.["consistent"] === false;   // undefined != violation

  return (
    <div className="app">
      <div className="glow glow-a" aria-hidden="true" />
      <div className="glow glow-b" aria-hidden="true" />

      <TopBar
        wallet={wallet} noWallet={noWallet} wrongNetwork={wrongNetwork}
        connect={connect} sw={correctNetwork} stats={stats} invOk={invOk} invBad={invBad}
      />

      <main className="container">
        {wallet?.address && wrongNetwork && (
          <div className="banner banner-warn">
            <span><b>Wrong network.</b> Clarity operates only on Studionet (61999) — your wallet is on a different chain.</span>
            <button className="btn btn-solid" onClick={correctNetwork}>Switch to Studionet</button>
          </div>
        )}

        {noWallet && <NoWalletBanner connect={connect} />}

        <Hero invariant={invariant} stats={stats} />
        <HowItWorks />
        <ParamsSection constants={constants} />
        <CreateVow
          run={run} constants={constants} refresh={refresh} txPending={txPending}
          wrongNetwork={wrongNetwork} hasWallet={!!wallet?.address}
        />
        <VowList ledger={ledger} open={open} refresh={refresh} now={now} />
      </main>

      {txPending && (
        <div className="inflight">
          <span className="spin" aria-hidden="true" />
          Transaction in flight — the validator panel is working; the ledger refreshes on its own.
        </div>
      )}

      {detail && (
        <Drawer
          d={detail} now={now}
          close={() => { setDetail(null); setDetailId(null); }}
          myAddress={wallet?.address} wrongNetwork={wrongNetwork}
          hasWallet={!!wallet?.address}
          run={run} refresh={refresh}
        />
      )}

      {toast && <div className={`toast toast-${toast.kind}`}>{toast.msg}</div>}

      <footer className="footer">
        <div className="container footer-in">
          <div className="mono dim">
            <span className="dot dot-ok" /> contract <a className="link mono" href="https://studio.genlayer.com" target="_blank" rel="noreferrer">{api.shortAddr(api.CONTRACT_ADDRESS)}</a>
            {" "}· Studionet (61999) · <span className="mono">{api.RPC}</span>
          </div>
          <div className="dim">no admin keys · no upgrade path · pull-based claims · fail-closed settlement</div>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------- //
// top bar                                                                 //
// ---------------------------------------------------------------------- //

function TopBar({ wallet, noWallet, wrongNetwork, connect, sw, stats, invOk, invBad }) {
  return (
    <header className="topbar-wrap">
      <div className="container topbar">
        <a className="brand" href="#top">
          <span className="brand-mark" aria-hidden="true">◇</span>
          <span className="brand-name">Clarity</span>
        </a>
        <div className="topbar-right">
          {invOk && (
            <span className="chain-chip" title="escrow == unfinalized + outstanding + burned + dispatched">
              <span className="dot dot-ok" /> invariant consistent
            </span>
          )}
          {invBad && (
            <span className="chain-chip chain-chip-bad"><span className="dot dot-bad" /> invariant violation</span>
          )}
          <span className="chain-chip">Studionet · 61999</span>
          {wallet?.address && !wrongNetwork && (
            <button className="walletchip" onClick={sw} title="connected wallet (click to re-check network)">
              <span className="dot dot-ok" />
              {api.shortAddr(wallet.address)}
            </button>
          )}
          {wallet?.address && wrongNetwork && (
            <button className="walletchip walletchip-bad" onClick={sw}>
              <span className="dot dot-warn" /> wrong network — switch
            </button>
          )}
          {!noWallet && !wallet?.address && (
            <button className="btn btn-solid" onClick={connect}>Connect wallet</button>
          )}
          {noWallet && <span className="chain-chip"><span className="dot dot-warn" /> no wallet — read-only</span>}
        </div>
      </div>
    </header>
  );
}

function NoWalletBanner({ connect }) {
  return (
    <div className="banner banner-info">
      <span>
        <b>Read-only mode.</b> You are browsing without a wallet — everything on this page is read straight
        from the chain. Install MetaMask or any EIP-1193 wallet to create vows, back them or claim payouts.
      </span>
      <button className="btn" onClick={connect}>Check again</button>
    </div>
  );
}

// ---------------------------------------------------------------------- //
// hero                                                                    //
// ---------------------------------------------------------------------- //

function Hero({ invariant: inv, stats }) {
  return (
    <section className="hero" id="top">
      <h1 className="hero-title">Public promises,<br /><span className="grad">settled by consensus.</span></h1>
      <p className="hero-sub">
        Post a stake on a promise. Skeptics back their doubt with GEN — and only when doubt
        exists may anyone back in faith. After the deadline an independent validator panel
        fetches the evidence page, and deterministic arithmetic pays out. No oracle to trust,
        no admin to trust — just the chain and its receipts.
      </p>
      <div className="hero-cta">
        <a className="btn btn-solid btn-lg" href="#create">Make a vow</a>
        <a className="btn btn-ghosty btn-lg" href="#ledger">Browse the ledger</a>
      </div>
      <div className="statgrid">
        <HeroStat label="value in escrow" value={stats ? api.fmtGEN(stats["escrow"]) : "…"} unit="GEN" />
        <HeroStat label="already paid out" value={inv ? api.fmtGEN(inv["dispatched"]) : "…"} unit="GEN" />
        <HeroStat label="publicly burned" value={inv ? api.fmtGEN(inv["burned_total"]) : "…"} unit="GEN" />
        <HeroStat label="vows created" value={stats ? String(stats["vow_count"]) : "…"} unit="" />
      </div>
      {inv && (
        <div className="invline mono">
          escrow {api.fmtGEN(inv["escrow"])} = unfinalized {api.fmtGEN(inv["unfinalized"])} + outstanding{" "}
          {api.fmtGEN(inv["outstanding"])} + burned {api.fmtGEN(inv["burned_total"])} + dispatched{" "}
          {api.fmtGEN(inv["dispatched"])}
          {inv["consistent"] === true && <span className="inv-ok"> ✓ consistent</span>}
        </div>
      )}
    </section>
  );
}

function HeroStat({ label, value, unit }) {
  return (
    <div className="herostat">
      <div className="herostat-value">{value}{unit && <small> {unit}</small>}</div>
      <div className="herostat-label">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------- //
// how it works                                                            //
// ---------------------------------------------------------------------- //

const STEPS = [
  {
    n: "01", title: "Found",
    body: "A founder stakes ≥ 10 GEN on a concrete promise with a deadline and one evidence URL. The stake is escrowed the moment the tx lands.",
  },
  {
    n: "02", title: "Backed",
    body: "Anyone doubts with GEN, and only after doubt exists can anyone back in faith — faith may never exceed doubt.",
  },
  {
    n: "03", title: "Judged",
    body: "After the deadline, consensus validators independently fetch the page and must agree on every material field. A verbatim quote on a snapshot/permalink is required; everything else folds to UNCLEAR.",
  },
  {
    n: "04", title: "Disputed (only downward)",
    body: "For 15 minutes counter-evidence may demote a verdict (FULFILLED→BROKEN→UNCLEAR). Improvements never happen silently.",
  },
  {
    n: "05", title: "Settled & claimed",
    body: "FULFILLED pays doubters' pool to the faithful · BROKEN burns half the stake and pays doubters · UNCLEAR refunds everyone. Claims are pull-based; dust burns.",
  },
];

function HowItWorks() {
  return (
    <Section
      eyebrow="the mechanics"
      title="How a vow lives and dies"
      sub="Five deterministic stages — every one of them auditable on-chain."
    >
      <div className="steps">
        {STEPS.map((s) => (
          <div className="step" key={s.n}>
            <div className="step-n mono">{s.n}</div>
            <div className="step-title">{s.title}</div>
            <div className="step-body">{s.body}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------- //
// parameters                                                              //
// ---------------------------------------------------------------------- //

function ParamsSection({ constants }) {
  const c = constants;
  const tiles = c ? [
    ["10 GEN", "min vow stake"],
    ["1 GEN", "min backing"],
    ["48+ chars", "verbatim quote floor"],
    ["15 min", "dispute window"],
    ["72 h", "grace before auto-refund"],
    ["1 + 3", "assessments per vow (initial + disputes)"],
    ["64", "backers per side"],
    ["2000", "max promise chars"],
  ] : null;
  return (
    <Section
      eyebrow="checkable constants"
      title="The rules, in numbers"
      sub="Read live from the contract — these bound what anyone, including the founder, can do."
    >
      {!tiles && <div className="card muted">loading constants…</div>}
      {tiles && (
        <div className="paramgrid">
          {tiles.map(([v, l]) => (
            <div className="param" key={l}>
              <div className="param-v">{v}</div>
              <div className="param-l">{l}</div>
            </div>
          ))}
        </div>
      )}
      <div className="rulebar">
        <div><b>0</b> admin &amp; owner keys</div>
        <div><b>none</b> — immutable bytecode, no upgrade path</div>
        <div><b>pull-based</b> — value only ever leaves toward a claimant who calls in</div>
        <div><b>fail-closed</b> — unreadable evidence can never become a verdict of success</div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------- //
// creation form                                                           //
// ---------------------------------------------------------------------- //

function CreateVow({ run, constants, refresh, txPending, wrongNetwork, hasWallet }) {
  const [text, setText] = useState("");
  const [deadlineLocal, setDeadlineLocal] = useState("");
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);

  const txt = text.trim();
  const MAX_TEXT = 2000;                 // must match the contract's MAX_VOW_TEXT
  const MIN_STAKE = 10n * api.GEN;

  // datetime-local (local time) -> UTC ISO "YYYY-MM-DDTHH:MM:SSZ"
  const deadlineStr = useMemo(() => {
    if (!deadlineLocal) return "";
    const d = new Date(deadlineLocal);
    if (isNaN(+d)) return "";
    return d.toISOString().slice(0, 19) + "Z";
  }, [deadlineLocal]);

  const prov = (txt.length > 0 && url) ? api.classifyEvidenceUrl(url) : null;

  const errors = useMemo(() => {
    const out = [];
    if (txt.length === 0) out.push("The promise cannot be empty.");
    if (txt.length > MAX_TEXT) out.push(`Text is ${txt.length} chars; limit is ${MAX_TEXT}.`);
    if (!deadlineLocal) out.push("A deadline is required.");
    if (deadlineStr) {
      const dl = Date.parse(deadlineStr);
      if (isNaN(dl)) out.push("Deadline is invalid.");
      else if (dl + 5e3 <= Date.now()) out.push("Deadline must be at least a few seconds in the future.");
      else if (dl - Date.now() > 366 * 24 * 3600e3) out.push("Deadline is more than a year out.");
    }
    if (url && txt.length > 0) {
      const c = api.classifyEvidenceUrl(url);
      if (c.tier === "INVALID") out.push(c.warn);
      else if (c.tier === "MUTABLE") out.push(c.warn);
    }
    return out;
  }, [txt, deadlineLocal, deadlineStr, url]);

  const showErrors = touched && errors.length > 0;

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0) return;
    const ok = await run("create_vow", (a) => api.txCreateVow(a, txt, deadlineStr, url.trim(), MIN_STAKE));
    if (ok) {
      setText(""); setUrl(""); setDeadlineLocal(""); setTouched(false);
      refresh();
    }
  };

  return (
    <Section
      eyebrow="commit"
      title={<span id="create">Make a vow</span>}
      sub="Concrete and publicly checkable beats lofty — a vow is settled by its own wording, so write it like a contract."
      right={constants && (
        <span className="muted small">min stake 10 GEN · min backing {api.fmtGEN(constants["min_backing"])} GEN</span>
      )}
    >
      <div className="card create">
        <div className="fld">
          <div className="fld-head">
            <label htmlFor="vow-text">Promise</label>
            <span className={`muted small ${text.length > MAX_TEXT ? "overcount" : ""}`}>{text.length} / {MAX_TEXT}</span>
          </div>
          <textarea
            id="vow-text" rows={3} value={text} maxLength={MAX_TEXT + 40}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. The community garden will have running water by the deadline — documented on one fixed page."
          />
        </div>

        <div className="create-grid">
          <div className="fld">
            <div className="fld-head">
              <label htmlFor="vow-deadline">Deadline</label>
              <span className="muted small">your local time</span>
            </div>
            <input
              id="vow-deadline" type="datetime-local" value={deadlineLocal}
              onChange={(e) => setDeadlineLocal(e.target.value)}
            />
            {deadlineStr && !errors.some((x) => x.includes("Deadline")) && (
              <div className="fld-hint small muted">settles at <span className="mono">{deadlineStr}</span></div>
            )}
          </div>

          <div className="fld">
            <div className="fld-head">
              <label htmlFor="vow-url">Evidence page</label>
              {prov && (
                <Pill kind={prov.tier === "MUTABLE" || prov.tier === "INVALID" ? "warn" : "ok"}>
                  {prov.tier === "MAYBE_PERMALINK" ? "permalink (needs static text + ETag)" : prov.tier}
                </Pill>
              )}
            </div>
            <input
              id="vow-url" type="url" value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://web.archive.org/web/… or https://example.org/proof.html"
            />
            {prov?.warn && <div className="fld-hint small muted">{prov.warn}</div>}
          </div>
        </div>

        {showErrors && (
          <div className="warnbox">
            {errors.map((e) => <div key={e}>⚠ {e}</div>)}
          </div>
        )}

        <div className="create-foot">
          <button
            className="btn btn-solid btn-lg" disabled={txPending} onClick={submit}
          >
            {hasWallet
              ? (wrongNetwork ? "Switch to Studionet first" : txPending ? "Waiting for signature…" : "Stake 10 GEN — create vow")
              : "Connect a wallet to create"}
          </button>
          <p className="muted small">
            Cancelling before the deadline refunds the founder fully. After the deadline the evidence page is
            fetched and judged by independent validators — nobody (including the founder) can bury a promise
            once its deadline has passed.
          </p>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------- //
// ledger                                                                  //
// ---------------------------------------------------------------------- //

function VowList({ ledger, open, refresh, now }) {
  return (
    <Section
      eyebrow="the chain itself"
      title={<span id="ledger">Ledger</span>}
      sub="Every vow ever staked — state read straight from the contract."
      right={<button className="btn" onClick={refresh}>refresh</button>}
    >
      {ledger.length === 0 && (
        <div className="card empty">
          <div className="empty-mark">◇</div>
          <p>No vows yet. The ledger only records what the chain has seen — be the first to stake a promise.</p>
        </div>
      )}
      <div className="ledger">
        {ledger.map((row) => <VowCard key={String(row["id"])} row={row} open={open} now={now} />)}
      </div>
    </Section>
  );
}

function VowCard({ row, open, now }) {
  return (
    <button className="vowcard" onClick={() => open(row["id"])}>
      <div className="vowcard-head">
        <span className="vow-id mono">#{String(row["id"])}</span>
        <StatePill state={row["state"]} />
        <span className="vowcard-spacer" />
        <span className="muted small">{api.tsFormat(row["deadline"])}</span>
      </div>
      <div className="vowcard-text">{clip(row["text_head"], 150)}</div>
      <div className="vowcard-meta">
        <span><b>{api.fmtGEN(row["stake"])}</b> stake</span>
        <span><b>{api.fmtGEN(row["faith_total"])}</b> faith</span>
        <span><b>{api.fmtGEN(row["doubt_total"])}</b> doubt</span>
        {String(row["deadline"]) < now && <span className="meta-due">deadline passed</span>}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------- //
// detail drawer                                                           //
// ---------------------------------------------------------------------- //

function Drawer({ d, close, myAddress, wrongNetwork, hasWallet, run, refresh, now }) {
  const { vow, evidence, settlement, preview, backings, log } = d;
  const id = Number(vow["id"]);
  const state = api.names.state(vow["state"]);
  const verdict = settlement?.["none"] ? null : api.names.verdict(settlement["verdict"]);
  const [mine, setMine] = useState(null);
  const [claimRunning, setClaimRunning] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => { scrollRef.current?.scrollTo?.(0, 0); }, [id]);

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
    return () => { alive = false; };
  }, [id, myAddress]);

  const deadlinePassed = String(vow["deadline"]) < now;
  const windowOpen = state === "PROVISIONAL" && String(vow["dispute_deadline"]) > now;

  return (
    <div className="drawer-back" onClick={close}>
      <div className="drawer" onClick={(e) => e.stopPropagation()} ref={scrollRef}>
        <button className="drawer-x" onClick={close} aria-label="close">✕</button>

        <div className="drawer-head">
          <span className="drawer-id mono">vow #{id}</span>
          <StatePill state={vow["state"]} />
          <VerdictPill verdict={settlement?.["none"] ? 0 : settlement["verdict"]} />
        </div>

        <blockquote className="vow-quote">{String(vow["text"])}</blockquote>

        <div className="kvgrid">
          <KV k="founder" v={api.shortAddr(String(vow["proposer"]))} />
          <KV k="stake" v={api.fmtGEN(vow["stake"]) + " GEN"} />
          <KV k="deadline" v={api.tsFormat(vow["deadline"])} />
          <KV k="created" v={api.tsFormat(vow["created_at"])} />
          <KV k="faith pool" v={api.fmtGEN(vow["faith_total"]) + " GEN"} />
          <KV k="doubt pool" v={api.fmtGEN(vow["doubt_total"]) + " GEN"} />
          <KV k="evidence" v={<a className="link" href={String(vow["evidence_url"])} target="_blank" rel="noreferrer">{clip(String(vow["evidence_url"]), 40)}</a>} />
          <KV k="assessments" v={`${Number(vow["assessed_n"])} · disputes used ${Number(vow["dispute_n"])}`} />
        </div>

        {/* actions, in lifecycle order */}
        {state === "OPEN" && !deadlinePassed && (
          <BackWidget id={id} wrongNetwork={wrongNetwork} run={run} />
        )}
        {state === "OPEN" && deadlinePassed && (
          <div className="actionbar">
            <button className="btn btn-solid" onClick={() => run("assess", (a) => api.txAssess(a, id))}>
              Deadline passed — let the panel judge
            </button>
            <small className="muted">Anybody can trigger the assessment; the validators do the rest.</small>
          </div>
        )}

        {evidence?.["none"] !== true && state !== "OPEN" && (
          <EvidenceCard evidence={evidence} />
        )}

        {settlement?.["none"] !== true && (
          <SettlementCard settlement={settlement} preview={preview} provisional={state === "PROVISIONAL"} />
        )}

        {windowOpen && (
          <div className="actionbar">
            <button className="btn btn-warnsolid" onClick={() => run("dispute", (a) => api.txDispute(a, id))}>
              Dispute with counter-evidence
            </button>
            <small className="muted">window until {api.tsFormat(vow["dispute_deadline"])} — a fresh panel run that can only demote the verdict.</small>
          </div>
        )}
        {state === "PROVISIONAL" && !windowOpen && (
          <div className="actionbar">
            <button className="btn btn-solid" onClick={() => run("finalize", (a) => api.txFinalize(a, id))}>
              Dispute window closed — finalize
            </button>
          </div>
        )}

        {state === "SETTLED" && hasWallet && (
          <ClaimCard mine={mine} claimRunning={claimRunning} onClaim={async () => {
            setClaimRunning(true);
            const ok = await run("claim", (a) => api.txClaim(a, id));
            setClaimRunning(false);
            if (ok) refresh();
          }} />
        )}

        <div className="drawer-sec">
          <h3>Backings</h3>
          {backings.length === 0 && <p className="muted">no backings yet</p>}
          <div className="backings">
            {backings.map((b) => (
              <div key={String(b["address"])} className="backing">
                <Pill kind={b["side"] === "FAITH" ? "ok" : "warn"}>{String(b["side"])}</Pill>
                <span className="mono">{api.shortAddr(String(b["address"]))}</span>
                <span className="backing-amt">{api.fmtGEN(b["amount"])} GEN</span>
              </div>
            ))}
          </div>
        </div>

        <div className="drawer-sec">
          <h3>Receipts</h3>
          <p className="muted small">the on-chain audit log — authoritative public history</p>
          {log.length === 0 && <p className="muted">no entries</p>}
          <div className="timeline">
            {log.slice().reverse().map((l, i) => (
              <div key={i} className="tl-row">
                <span className="tl-dot" />
                <div>
                  <div><b className="mono tl-code">{String(l["code"])}</b> <span className="muted small">{api.tsFormat(l["ts"])}</span></div>
                  <div className="muted">{String(l["detail"])}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div className="kv">
      <div className="kv-k">{k}</div>
      <div className="kv-v">{v}</div>
    </div>
  );
}

function BackWidget({ id, wrongNetwork, run }) {
  const [side, setSide] = useState(null);
  const [amt, setAmt] = useState(1);
  return (
    <div className="card act-back">
      <h3>Back this vow</h3>
      <div className="back-choose">
        <button className={`sidebtn side-doubt ${side === 2 ? "on" : ""}`} onClick={() => setSide(2)}>
          <b>DOUBT</b><span>win when BROKEN · share refunds on UNCLEAR</span>
        </button>
        <button className={`sidebtn side-faith ${side === 1 ? "on" : ""}`} onClick={() => setSide(1)}>
          <b>FAITH</b><span>win when FULFILLED — only a quoted page pays</span>
        </button>
      </div>
      <div className="back-amt">
        <label htmlFor="back-amt">commit</label>
        <input id="back-amt" type="number" min={1} value={amt} onChange={(e) => setAmt(Number(e.target.value))} />
        <span className="muted">GEN (min 1)</span>
        <button
          className="btn btn-solid" disabled={!side || amt < 1 || wrongNetwork}
          onClick={() => run("back", (a) => api.txBack(a, id, side, BigInt(amt) * api.GEN))}
        >
          Commit {amt} GEN
        </button>
      </div>
      <small className="muted">One backing per address per vow. The contract caps faith at the current doubt total — the first skeptic enables hope.</small>
    </div>
  );
}

function EvidenceCard({ evidence }) {
  const tier = api.names.tier(evidence["tier"]);
  const proc = api.names.proc(evidence["procedure"]);
  const grounded = evidence["contained"] === true && String(evidence["quote"] ?? "") !== "";
  return (
    <div className="card ev-card">
      <div className="card-title-row">
        <h3>Evidence</h3>
        <Pill kind={grounded ? "ok" : "warn"}>{grounded ? "grounded ✓" : "not grounded"}</Pill>
      </div>
      <div className="kvgrid kvgrid-3">
        <KV k="fetched" v={api.tsFormat(evidence["assessed_at"])} />
        <KV k="http status" v={String(evidence["status"])} />
        <KV k="procedure" v={proc} />
        <KV k="provenance" v={tier} />
        <KV k="page date" v={String(evidence["page_date"] ?? "") || "—"} />
        <KV k="text length" v={String(evidence["text_len"] ?? "") + " chars"} />
        <KV k="body sha256" v={<code className="mono tiny">{clip(evidence["content_sha256"], 16)}</code>} />
        <KV k="text sha256" v={<code className="mono tiny">{clip(evidence["text_sha256"], 16)}</code>} />
        <KV k="page" v={<a className="link" href={String(evidence["url"])} target="_blank" rel="noreferrer">open ↗</a>} />
      </div>
      {grounded ? (
        <blockquote className="ev-quote">“{String(evidence["quote"])}”<span className="muted small"> — verbatim on page ✓</span></blockquote>
      ) : (
        <p className="muted small">
          No quote is anchored here: procedural failure ({proc}) or an ungrounded judgment — recorded
          as-is, never laundered into success.
        </p>
      )}
    </div>
  );
}

function SettlementCard({ settlement, preview, provisional }) {
  const name = api.names.verdict(settlement["verdict"]);
  const verdictKind = name === "FULFILLED" ? "ok" : name === "BROKEN" ? "bad" : "info";
  const outcome = {
    FULFILLED: "The promise was proven on the evidence page. Stake returned; the doubter pool streams to the faithful.",
    BROKEN: "The failure was proven. Half the stake burns publicly; the rest plus forfeited faith goes to doubters.",
    UNCLEAR: "Not provable, unreadable, or disputed into ambiguity. Everyone is refunded in full.",
  }[name];
  const tiles = [
    ["founder", settlement["to_proposer"]],
    ["faith pool", settlement["to_faith"]],
    ["doubt pool", settlement["to_doubt"]],
    ["public burn", settlement["burned"]],
  ];
  return (
    <div className="card settle-card">
      <div className="card-title-row">
        <h3>Settlement {provisional && <Pill kind="warn">provisional</Pill>}</h3>
        <Pill kind={verdictKind}>{name}</Pill>
      </div>
      <p className="settle-why muted">{String(settlement["reason"])} — {outcome}</p>
      <div className="settle-grid">
        {tiles.map(([k, v]) => (
          <div className="settle-tile" key={k}>
            <div className="settle-amt">{api.fmtGEN(v)}</div>
            <div className="settle-lbl">{k}</div>
          </div>
        ))}
      </div>
      {provisional && preview?.["none"] !== true && (
        <p className="muted small settle-preview">
          deterministic preview of finalization: {api.names.verdict(preview["verdict"])}, burn{" "}
          {api.fmtGEN(preview["burned"])} GEN, total entitlement {api.fmtGEN(preview["entitlement_total"])} GEN
        </p>
      )}
    </div>
  );
}

function ClaimCard({ mine, claimRunning, onClaim }) {
  return (
    <div className="card claim-card">
      {mine === null && <p className="muted">checking your entitlements…</p>}
      {mine && mine["present"] !== true && (
        <p className="muted">Nothing is owed to this address for this vow {mine["none"] === true ? "yet" : ""}.</p>
      )}
      {mine && mine["present"] === true && mine["claimed"] === true && (
        <p><span className="dot dot-ok" /> You claimed your payout.</p>
      )}
      {mine && mine["present"] === true && mine["claimed"] !== true && (
        <div className="claim-row">
          <span><b>{api.fmtGEN(mine["amount"])} GEN</b> waiting for you</span>
          <button className="btn btn-solid" onClick={onClaim} disabled={claimRunning}>
            {claimRunning ? "claiming…" : "Claim payout"}
          </button>
        </div>
      )}
    </div>
  );
}
