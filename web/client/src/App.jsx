import React, { useState, useEffect, useRef, useCallback } from "react";
import Chart from "chart.js/auto";

/* ---------- helpers ---------- */
const COL = { primary: "#3b82f6", sec: "#4ae176", ter: "#ffb95f", err: "#ff6b6b", mut: "#8c909f" };
const fmt = (n) => (n == null || n === "") ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtInt = (n) => (n == null ? "0" : Number(n).toLocaleString());
const inr = (n) => (n == null ? "—" : "₹" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const trunc = (u, n = 46) => { if (!u) return "—"; let l = u.replace(/^https?:\/\//, ""); return l.length > n ? l.slice(0, n - 1) + "…" : l; };
const pid = (u) => { try { return new URL(u).pathname.split("/").filter(Boolean).pop() || "—"; } catch { return "—"; } };
const elapsed = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
async function api(path, opts) { const r = await fetch(path, opts); try { return await r.json(); } catch { return {}; } }
const aj = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

/* ---------- toasts ---------- */
let _toast = () => {};
export const toast = (t, k = "ok") => _toast(t, k);
function Toaster() {
  const [xs, setXs] = useState([]);
  _toast = (text, kind) => { const id = Math.random(); setXs((a) => [...a, { id, text, kind }]); setTimeout(() => setXs((a) => a.filter((i) => i.id !== id)), 3200); };
  return <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
    {xs.map((t) => <div key={t.id} className="toastin px-4 py-2.5 rounded-lg text-[13px] shadow-2xl"
      style={{ background: "var(--c)", border: "1px solid " + (t.kind === "err" ? COL.err : COL.sec) }}>{t.text}</div>)}
  </div>;
}

/* ---------- icons ---------- */
const P = {
  pipeline: "M3 3v18h18M7 14l3-3 3 3 5-6", review: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  clock: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", alerts: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a2 2 0 0 0 3.4 0",
  plug: "M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v6", gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8M4.6 9a1.6 1.6 0 0 0-.3-1.8",
  home: "M3 11l9-8 9 8M5 10v10h14V10", play: "M8 5v14l11-7z", refresh: "M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5",
  stop: "M6 6h12v12H6z", upload: "M12 16V4M7 9l5-5 5 5M5 20h14", dl: "M12 3v12m-5-5 5 5 5-5M5 21h14",
  check: "M20 6 9 17l-5-5", x: "M18 6 6 18M6 6l12 12", search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  share: "M4 12v8h16v-8M12 16V4M8 8l4-4 4 4", up: "M12 19V5M5 12l7-7 7 7", down: "M12 5v14M5 12l7 7 7-7", logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
};
const Icon = ({ n, s = 16, c = "currentColor" }) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{(P[n] || "").split("M").filter(Boolean).map((d, i) => <path key={i} d={"M" + d} />)}</svg>;

function Btn({ children, kind = "ghost", sm, ...p }) {
  const st = { primary: { background: COL.primary, color: "#fff", border: "1px solid " + COL.primary },
    sec: { background: COL.sec, color: "#04140d", border: "1px solid " + COL.sec },
    danger: { background: "transparent", color: COL.err, border: "1px solid " + COL.err },
    ghost: { background: "var(--c-low)", color: "var(--on)", border: "1px solid var(--border)" } }[kind];
  return <button {...p} style={st} className={"inline-flex items-center gap-1.5 font-semibold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed " + (sm ? "px-2.5 py-1.5 text-[12px]" : "px-3.5 py-2 text-[13px]")}>{children}</button>;
}
const Stat = ({ k, v, c }) => <div className="card p-3.5"><div className="lbl mb-1">{k}</div><div className="mono" style={{ fontSize: 22, fontWeight: 600, color: c || "#fff" }}>{v}</div></div>;
function Toggle({ on, onChange }) { return <button onClick={() => onChange(!on)} className="relative rounded-full" style={{ width: 40, height: 22, background: on ? COL.sec : "var(--c-low)", border: "1px solid " + (on ? COL.sec : "var(--border)") }}><span className="absolute rounded-full transition-all" style={{ width: 16, height: 16, top: 2, left: on ? 20 : 2, background: on ? "#04140d" : COL.mut }} /></button>; }
function VendorSelect({ value, onChange, kind }) {
  const [vs, setVs] = useState([]);
  useEffect(() => { api("/api/vendors" + (kind ? "?kind=" + kind : "")).then((d) => setVs(d.vendors || [])); }, [kind]);
  return <select className="inp mono" style={{ width: 210 }} value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="">All vendors ({vs.length})</option>
    {vs.map((v) => <option key={v.vendor} value={v.vendor}>{v.vendor.replace(/^www\./, "")} · {v.count}</option>)}</select>;
}
function ChartBox({ type, labels, datasets, options, h = 230 }) {
  const ref = useRef(null), inst = useRef(null);
  // Only rebuild when the data/config actually changes — NOT on every parent
  // re-render (the app polls /api/meta on a timer, which would otherwise destroy
  // and recreate every chart repeatedly and make the UI lag/flicker).
  const sig = JSON.stringify({ type, labels, datasets, options });
  useEffect(() => {
    if (!ref.current) return; if (inst.current) inst.current.destroy();
    inst.current = new Chart(ref.current.getContext("2d"), { type, data: { labels, datasets },
      options: Object.assign({ responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { labels: { color: "#a1a1aa", font: { size: 11 } } } },
        scales: (type === "doughnut") ? {} : { x: { ticks: { color: "#a1a1aa", font: { size: 10 } }, grid: { color: "#27272a" } }, y: { ticks: { color: "#a1a1aa", font: { size: 10 } }, grid: { color: "#27272a" } } } }, options || {}) });
    return () => inst.current && inst.current.destroy();
  }, [sig, h]);
  return <div style={{ height: h }}><canvas ref={ref} /></div>;
}

/* ===================== AUTH ===================== */
function Auth({ onIn }) {
  const [mode, setMode] = useState("login"); const [email, setE] = useState(""); const [pw, setPw] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e) => { e.preventDefault(); setBusy(true); setErr("");
    const d = await aj(mode === "login" ? "/api/login" : "/api/register", { email, password: pw });
    setBusy(false); if (d.ok) onIn(d); else setErr(d.error || "Failed"); };
  return <div className="h-full flex items-center justify-center">
    <form onSubmit={submit} className="card p-8" style={{ width: 360 }}>
      <div className="flex items-center gap-2.5 mb-5"><div style={{ width: 34, height: 34, borderRadius: 9, background: "linear-gradient(135deg,#3b82f6,#4ae176)", display: "flex", alignItems: "center", justifyContent: "center" }}>⚡</div>
        <div><div style={{ fontWeight: 800, fontSize: 18 }}>MBO Tracker</div><div className="lbl">{mode === "login" ? "sign in" : "create account"}</div></div></div>
      <div className="lbl mb-1">Email</div><input className="inp w-full mb-3" type="email" value={email} onChange={(e) => setE(e.target.value)} autoFocus required />
      <div className="lbl mb-1">Password</div><input className="inp w-full" type="password" value={pw} onChange={(e) => setPw(e.target.value)} required />
      <button disabled={busy} className="w-full mt-5 rounded-lg font-bold py-2.5" style={{ background: COL.primary, color: "#fff" }}>{busy ? "…" : (mode === "login" ? "Sign in" : "Create account")}</button>
      <div className="mt-3 text-[12px]" style={{ color: COL.err, minHeight: 16 }}>{err}</div>
      <div className="text-[12px]" style={{ color: COL.mut }}>{mode === "login" ? <>No account? <a onClick={() => setMode("register")} style={{ color: COL.primary, cursor: "pointer" }}>Create one</a></> : <>Have an account? <a onClick={() => setMode("login")} style={{ color: COL.primary, cursor: "pointer" }}>Sign in</a></>}</div>
    </form></div>;
}

/* ===================== HOME ===================== */
function Home({ go }) {
  const [d, setD] = useState(null);
  useEffect(() => { api("/api/insights").then(setD); }, []);
  if (!d) return <div className="text-center py-20" style={{ color: COL.mut }}>Loading insights…</div>;
  const c = d.counts || {}, ex = d.exposure || {}, fxr = d.fx || {};
  const k = [["Total Products", fmtInt(c.total), "#fff"], ["Matched", fmtInt(c.matched), COL.sec], ["Mismatches", fmtInt(c.mismatch), COL.ter], ["Errors", fmtInt(c.error), COL.err], ["Vendors", fmtInt(d.vendors), COL.primary], ["Awaiting", fmtInt(c.awaiting), COL.ter], ["Approved (archived)", fmtInt(d.approved_count), COL.sec], ["Overpriced ₹", inr(Math.round(ex.over || 0)), COL.err]];
  return <div className="h-full overflow-auto pr-1">
    <div className="grid grid-cols-4 gap-3 mb-4">{k.map(([a, b, c2]) => <Stat key={a} k={a} v={b} c={c2} />)}</div>
    <div className="grid grid-cols-3 gap-3 mb-4">
      <div className="card p-4"><div className="lbl mb-3">Catalog status</div><ChartBox type="doughnut" h={220} labels={["Matched", "Mismatch", "Error", "Pending"]} datasets={[{ data: [c.matched, c.mismatch, c.error, c.pending], backgroundColor: [COL.sec, COL.ter, COL.err, "#3f3f46"], borderWidth: 0 }]} options={{ plugins: { legend: { position: "bottom" } }, cutout: "62%" }} /></div>
      <div className="card p-4"><div className="lbl mb-3">Top vendors by mismatch</div><ChartBox type="bar" h={220} labels={d.top_mismatch.map((v) => v.brand.replace(/\.(com|in|co).*/, ""))} datasets={[{ data: d.top_mismatch.map((v) => v.count), backgroundColor: COL.ter, borderRadius: 4 }]} options={{ indexAxis: "y", plugins: { legend: { display: false } } }} /></div>
      <div className="card p-4"><div className="lbl mb-3">Largest vendors</div><ChartBox type="bar" h={220} labels={d.top_products.map((v) => v.brand.replace(/\.(com|in|co).*/, ""))} datasets={[{ data: d.top_products.map((v) => v.count), backgroundColor: COL.primary, borderRadius: 4 }]} options={{ indexAxis: "y", plugins: { legend: { display: false } } }} /></div>
    </div>
    <div className="grid grid-cols-3 gap-3">
      <div className="card p-4"><div className="lbl mb-3">Exposure (mismatch gap)</div>
        <Row l="Overpriced" v={inr(Math.round(ex.over || 0))} c={COL.err} /><Row l="Underpriced" v={inr(Math.round(ex.under || 0))} c={COL.sec} /><Row l="Avg gap" v={inr(Math.round(ex.avg || 0))} /><Row l="Approved value" v={inr(Math.round(d.approved_value || 0))} c={COL.sec} /></div>
      <div className="card p-4"><div className="lbl mb-3">Live FX → INR</div>{["USD", "CAD"].map((cu) => <Row key={cu} l={cu} v={"₹" + fmt(fxr[cu])} c={COL.primary} />)}</div>
      <div className="card p-4"><div className="lbl mb-3">Quick actions</div><div className="flex flex-col gap-2">
        <Btn kind="primary" onClick={() => go("pipeline")}><Icon n="play" s={14} />Run pipeline</Btn>
        <Btn kind="ghost" onClick={() => go("review")}><Icon n="review" s={14} />Review {fmtInt(c.awaiting)} awaiting</Btn>
        <Btn kind="ghost" onClick={() => go("history")}><Icon n="clock" s={14} />History</Btn></div></div>
    </div></div>;
}
const Row = ({ l, v, c }) => <div className="flex justify-between py-1.5"><span className="text-[12.5px]" style={{ color: COL.mut }}>{l}</span><b className="mono" style={{ color: c || "#fff" }}>{v}</b></div>;

/* ===================== PIPELINE ===================== */
function Pipeline({ admin }) {
  const [st, setSt] = useState({ entries: [], matched: 0, mismatch: 0, errors: 0, total_rows: 0, current_row: 0, elapsed: 0, message: "Idle.", running: false, phase: "idle", log_total: 0 });
  const [cfg, setCfg] = useState({ concurrency: 8, timeout_ms: 12000, batch_size: 250, rest_between: 2, safe_retry: true, simulation: false, data_source: "database" });
  const [vendors, setVendors] = useState([]); const [vsel, setVsel] = useState([]); const [cat, setCat] = useState({ total: 0 });
  const cursor = useRef(0), logRef = useRef(null);
  useEffect(() => { api("/api/pipe/status?cursor=0").then((d) => d.config &&
    setCfg((current) => ({ ...current, ...d.config }))); }, []);
  useEffect(() => {
    api("/api/vendors?source=" + cfg.data_source).then((d) => setVendors(d.vendors || []));
    api("/api/meta").then((d) => d.counts && setCat({ ...d.counts, imported: d.imported_count || 0 }));
  }, [cfg.data_source]);
  const poll = useCallback(async () => { const d = await api("/api/pipe/status?cursor=" + cursor.current); if (d.running === undefined) return; cursor.current = d.cursor; setSt((s) => ({ ...d, entries: [...s.entries, ...(d.entries || [])].slice(-400) })); }, []);
  useEffect(() => { let live = true; const loop = async () => { if (!live) return; await poll(); setTimeout(loop, st.running ? 800 : 2000); }; loop(); return () => { live = false; }; }, [poll, st.running]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [st.entries.length]);
  const send = (extra) => aj("/api/pipe/config", { ...cfg, ...extra });
  const run = async (mode) => { await send({ fresh_start: mode === "fresh", retry_errors: mode === "update", vendors: vsel }); const d = await aj("/api/pipe/start", {}); d.error ? toast(d.error, "err") : toast("Run started", "ok"); setSt((s) => ({ ...s, entries: [] })); cursor.current = 0; };
  const onFile = async (f) => { if (!f || !admin) return; const fd = new FormData(); fd.append("file", f); toast("Reading " + f.name + "..."); const p = await api("/api/import/preview", { method: "POST", body: fd }); if (!p.ok) return toast(p.error || "Preview failed", "err"); const fd2 = new FormData(); const d = await api("/api/import", { method: "POST", body: fd2 }); d.ok ? toast(`Sheet staged: ${d.rows} products · click "Add to database" to save`, "ok") : toast(d.error || "Import failed", "err"); refreshCat(); };
  const refreshCat = () => { api("/api/meta").then((x) => x.counts && setCat({ ...x.counts, imported: x.imported_count || 0 })); api("/api/vendors?source=" + cfg.data_source).then((x) => setVendors(x.vendors || [])); };
  const commitSheet = async () => { if (!admin) return toast("Admin only", "err"); if (!cat.imported) return toast("Upload a sheet first", "err"); if (!confirm(`Sync the database to the sheet?\n\nThe products DB will become EXACTLY the ${fmtInt(cat.imported)} Shopify products in the sheet — new ones added, products no longer in the sheet removed. Approval history is kept.`)) return; toast("Syncing database to sheet…"); const r = await aj("/api/import/commit", {}); r.ok ? toast(`Synced → ${fmtInt(r.total)} in DB (${fmtInt(r.added)} added, ${fmtInt(r.removed)} removed)`, "ok") : toast(r.error || "Failed", "err"); refreshCat(); };
  const pct = st.total_rows ? Math.min(100, st.current_row / st.total_rows * 100) : 0;
  const sourceTotal = cfg.data_source === "imported" ? cat.imported : cat.total;
  const scope = vsel.length ? vendors.filter((v) => vsel.includes(v.vendor)).reduce((a, v) => a + v.count, 0) : sourceTotal;
  const tv = (v) => { const n = new Set(vsel); n.has(v) ? n.delete(v) : n.add(v); setVsel([...n]); };
  return <div className="grid grid-cols-[300px_1fr] gap-5 h-full min-h-0">
    <div className="overflow-y-auto pr-1 space-y-3">
      <div className="card p-3"><div className="lbl mb-2">Source Configuration</div>
        <div onClick={() => document.getElementById("fi").click()} className="rounded-lg p-4 text-center cursor-pointer" style={{ border: "1.5px dashed var(--border)", color: COL.mut }}><Icon n="upload" s={20} /><div className="text-[12px] mt-1">Drop sheet or click to upload</div></div>
        <input id="fi" type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => onFile(e.target.files[0])} />
        <div className="text-[11px] mt-2" style={{ color: COL.mut }}>{fmtInt(sourceTotal)} products in selected source</div>
        <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
          <div><div className="text-[12px] font-semibold">{cfg.data_source === "imported" ? "Sheet products only" : "Database products"}</div>
            <div className="text-[10px]" style={{ color: COL.mut }}>{cfg.data_source === "imported" ? "Scrape the uploaded sheet, not the DB" : "Scrape the permanent products database"}</div></div>
          <Toggle on={cfg.data_source === "imported"} onChange={(on) => {
            const data_source = on ? "imported" : "database";
            const next = { ...cfg, data_source, vendors: [] };
            setCfg(next); setVsel([]); aj("/api/pipe/config", next);
          }} />
        </div>
        <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
          <Btn kind="primary" sm onClick={commitSheet} disabled={!admin || !cat.imported} style={{ width: "100%", justifyContent: "center" }}><Icon n="dl" s={13} />Sync database to sheet</Btn>
          <div className="text-[10px] mt-1.5" style={{ color: COL.mut }}>Staged in sheet: <b style={{ color: "#fff" }}>{fmtInt(cat.imported)}</b> · DB becomes exactly the sheet's Shopify products</div>
        </div></div>
      <div className="card p-3"><div className="flex justify-between items-center mb-2"><span className="lbl">Designer Domain</span><span className="text-[10px]" style={{ color: COL.mut }}><a onClick={() => setVsel([])} style={{ cursor: "pointer" }}>clear</a></span></div>
        <div className="max-h-44 overflow-y-auto space-y-0.5">{vendors.map((v) => <label key={v.vendor} className="flex items-center gap-2 text-[12px] px-1 py-0.5 cursor-pointer"><input type="checkbox" checked={vsel.includes(v.vendor)} onChange={() => tv(v.vendor)} /><span className="flex-1 truncate">{v.vendor.replace(/^www\./, "")}</span><span style={{ color: COL.mut }}>{v.count}</span></label>)}</div>
        <div className="text-[11px] mt-2" style={{ color: COL.mut }}>Scope: <b style={{ color: "#fff" }}>{fmtInt(scope)}</b> products</div></div>
      <div className="card p-3 space-y-2"><div className="lbl">Engine Settings</div>
        <div className="grid grid-cols-2 gap-2">{[["Concurrency", "concurrency"], ["Timeout (ms)", "timeout_ms"], ["Batch", "batch_size"], ["Rest (s)", "rest_between"]].map(([l, key]) => <div key={key}><div className="lbl mb-1">{l}</div><input type="number" className="inp w-full mono" value={cfg[key]} onChange={(e) => setCfg({ ...cfg, [key]: +e.target.value })} /></div>)}</div>
        <div className="flex items-center justify-between pt-1"><span className="text-[12.5px]">Safe-Retry</span><Toggle on={cfg.safe_retry} onChange={(v) => setCfg({ ...cfg, safe_retry: v })} /></div>
        <Btn kind="ghost" onClick={() => { send({}); toast("Config applied", "ok"); }}><Icon n="check" s={13} />Apply</Btn></div>
    </div>
    <div className="flex flex-col min-h-0">
      <div className="flex gap-2.5 mb-3 items-center flex-wrap">
        <Btn kind="primary" onClick={() => run("fresh")} disabled={st.running || !admin}><Icon n="play" s={14} />Run from Start</Btn>
        <Btn kind="ghost" onClick={() => run("update")} disabled={st.running || !admin}><Icon n="refresh" s={14} />Check Updates</Btn>
        <Btn kind="danger" onClick={() => aj("/api/pipe/abort", {})} disabled={!st.running}><Icon n="stop" s={14} />Abort</Btn>
        <span className="ml-auto text-[11px] flex items-center gap-1.5" style={{ color: st.running ? COL.sec : COL.mut }}><span className="w-2 h-2 rounded-full pdot" style={{ background: st.running ? COL.sec : COL.mut }} />{st.running ? "ENGINE LIVE" : "IDLE"}</span></div>
      <div className="grid grid-cols-6 gap-2.5 mb-3"><Stat k="Total" v={fmtInt(st.total_rows)} /><Stat k="Done" v={fmtInt(st.current_row)} /><Stat k="Matched" v={fmtInt(st.matched)} c={COL.sec} /><Stat k="Mismatch" v={fmtInt(st.mismatch)} c={COL.ter} /><Stat k="Errors" v={fmtInt(st.errors)} c={COL.err} /><Stat k="Elapsed" v={elapsed(st.elapsed || 0)} /></div>
      {st.phase !== "idle" && <div className="mb-3 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold" style={{ border: "1px solid " + COL.ter + "55", background: COL.ter + "18", color: COL.ter }}>Phase: {st.message}</div>}
      <div className="h-2.5 rounded-full overflow-hidden mb-3 relative" style={{ background: "var(--c-low)", border: "1px solid var(--border)" }}><div className="h-full relative overflow-hidden" style={{ width: pct + "%", background: COL.primary }}>{st.running && <span className="shine" />}</div></div>
      <div className="lbl mb-1.5">Stream Console · {fmtInt(st.log_total)}</div>
      <div ref={logRef} className="card flex-1 min-h-0 overflow-auto mono" style={{ fontSize: 12 }}>
        <table className="w-full"><tbody>{st.entries.map((e, i) => <tr key={i} className="fadeup" style={{ borderTop: "1px solid var(--c-low)" }}>
          <td className="px-2 py-1.5" style={{ color: COL.mut, width: 60 }}>{e.t}</td>
          <td className="px-2 py-1.5" style={{ color: COL.primary2, width: 110 }}>[{(e.domain || "?").replace(/^www\./, "").toUpperCase().slice(0, 12)}]</td>
          <td className="px-2 py-1.5">{e.url ? <a href={e.url} target="_blank" rel="noopener" style={{ color: COL.primary }}>{trunc(e.url, 40)}</a> : "—"}</td>
          <td className="px-2 py-1.5 text-right" style={{ width: 90 }}>{e.price}</td>
          <td className="px-2 py-1.5" style={{ width: 90, color: e.status === "Price Matched" ? COL.sec : e.status && e.status.startsWith("Price Mismatch") ? COL.ter : COL.err }}>{e.status === "Fetch Error" ? "ERR" : e.status === "Price Matched" ? "MATCH" : "MISMATCH"}</td></tr>)}
          {!st.entries.length && <tr><td className="text-center py-10" style={{ color: COL.mut }}>No log yet — Run from Start.</td></tr>}</tbody></table></div>
    </div></div>;
}

/* ===================== REVIEW ===================== */
function Review({ admin }) {
  const [tab, setTab] = useState("mismatch"); const [items, setItems] = useState([]); const [counts, setCounts] = useState({});
  const [brand, setBrand] = useState(""); const [sel, setSel] = useState(() => new Set()); const [gm, setGm] = useState(0); const [convCur, setConvCur] = useState("USD"); const [fxr, setFxr] = useState({});
  const [usd, setUsd] = useState(""); const [cad, setCad] = useState("");
  const convOn = convCur !== "off";
  const load = useCallback(async () => { const d = await api(`/api/review/items?kind=${tab}&brands=${encodeURIComponent(brand)}`); setItems((d.items || []).map((it) => ({ ...it, _m: it.markup_pct || gm, _amt: "", _cur: (it.currency || "INR").toUpperCase() }))); setCounts(d.counts || {}); setSel(new Set()); }, [tab, brand]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api("/api/fx").then((d) => { if (d.rates) setFxr(d.rates); if (d.markup != null) setGm(d.markup); setUsd(d.overrides?.USD ?? ""); setCad(d.overrides?.CAD ?? ""); }); }, []);
  const saveFx = async () => { const r = await aj("/api/fx/override", { usd, cad, markup: gm }); if (r.rates) setFxr(r.rates); if (r.overrides) { setUsd(r.overrides.USD ?? ""); setCad(r.overrides.CAD ?? ""); } toast(r.ok ? "Rates & markup saved · applies to all" : "Save failed", r.ok ? "ok" : "err"); };
  // Conversion currency is chosen at the top (USD/CAD/off) and forced on every
  // non-INR live price, so all foreign prices convert the same agreed way.
  // Live price expressed in INR using its own currency (mirrors server toInr).
  const liveInr = (it) => { if (it.live_price == null) return null; const c = (it.currency || "INR").toUpperCase(); if (c === "INR") return it.live_price; return it.live_price * (fxr[c] || 1); };
  const dInr = (it) => { const li = liveInr(it); return li != null && it.base_price != null ? li - it.base_price : null; };
  // Output currency chosen at the top. Final = INR reference / targetRate + flat markup amount.
  const targetCur = convOn ? convCur : "INR";
  const targetRate = targetCur === "INR" ? 1 : (fxr[targetCur] || 1);
  const amtInr = (amount, currency) => { const n = Number(amount); if (!Number.isFinite(n) || n <= 0) return null; const c = (currency || "INR").toUpperCase(); const r = (c === "INR" || c === "UNKNOWN") ? 1 : (fxr[c] || 1); return Math.round(n * r * 100) / 100; };
  const previewFinal = (it) => { const manual = amtInr(it._amt, it._cur); if (manual != null) return Math.round(manual / targetRate * 100) / 100; const refInr = liveInr(it) ?? it.base_price; if (refInr == null) return null; return Math.round((refInr / targetRate + Number(it._m || 0)) * 100) / 100; };
  const decide = async (it, decision) => { const r = await aj("/api/review/decide", { row: it.id, decision, markup_pct: it._m, price_amount: it._amt, price_currency: it._cur, convert: convOn, convert_currency: convOn ? convCur : "" }); r.ok ? toast(decision === "approved" ? `Approved ${inr(r.final_price)} · ${r.shopify?.status || "queued"}` : "Rejected", r.shopify && !r.shopify.ok ? "err" : "ok") : toast(r.error, "err"); load(); };
  const del = async (it) => { if (!admin) return toast("Admin only", "err"); if (!confirm(`Reject and remove this product from the database?\n\n${trunc(it.url, 56)}`)) return; const r = await aj("/api/review/delete", { row: it.id }); r.ok ? toast("Rejected · removed from database", "ok") : toast(r.error || "Failed", "err"); load(); };
  const approveSel = async () => { if (!sel.size) return toast("Select rows first", "err"); let pushed = 0, failed = 0; for (const id of sel) { const it = items.find((x) => x.id === id); const r = await aj("/api/review/decide", { row: id, decision: "approved", markup_pct: it._m, price_amount: it._amt, price_currency: it._cur, convert: convOn, convert_currency: convOn ? convCur : "" }); r.shopify?.ok ? pushed++ : failed++; } toast(`Approved ${sel.size} · Shopify ${pushed} ok${failed ? `, ${failed} failed` : ""}`, failed ? "err" : "ok"); load(); };
  const approveAll = async () => { if (!confirm(`Approve ALL ${items.length} ${tab} with +${gm} ${targetCur} markup?`)) return; const r = await aj("/api/review/approve_all", { markup_pct: gm, convert: convOn, convert_currency: convOn ? convCur : "", kind: tab, brands: brand ? [brand] : [] }); r.ok ? toast(`Approved ${r.approved} · Shopify ${r.pushed || 0} ok${r.failed ? `, ${r.failed} failed` : ""}`, r.failed ? "err" : "ok") : toast(r.error, "err"); load(); };
  const tabs = [["mismatch", "Mismatches", counts.awaiting, COL.ter], ["error", "Errors", counts.error, COL.err], ["resolved", "Resolved", counts.matched, COL.sec]];
  const tog = (id) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  return <div className="h-full min-h-0 flex flex-col">
    <div className="flex items-start justify-between mb-3">
      <div><h1 style={{ fontSize: 28, fontWeight: 600 }}>Review &amp; Approval</h1><div className="text-[13px]" style={{ color: COL.mut }}>Approving archives the row and pushes the final price to Shopify using the selected MBO URL setting.</div></div>
      <div className="flex gap-2.5 items-center"><VendorSelect value={brand} onChange={setBrand} kind={tab} />
        <Btn kind="ghost" sm onClick={load}><Icon n="refresh" s={13} />Refresh</Btn>
        <Btn kind="ghost" sm onClick={() => window.location = `/api/export?kind=${tab === "resolved" ? "all" : tab}`}><Icon n="dl" s={13} />Export</Btn>
        <Btn kind="primary" sm onClick={approveSel} disabled={!admin}><Icon n="check" s={13} />Approve Selected</Btn></div></div>
    <div className="card p-3 flex items-center gap-3 mb-3 flex-wrap">
      <span className="lbl">Global pricing · all products</span>
      <span className="text-[12px]" style={{ color: COL.mut }}>Markup</span><input type="number" className="inp mono" style={{ width: 72 }} value={gm} onChange={(e) => setGm(e.target.value)} /><span className="text-[12px]">{targetCur}</span>
      <span className="w-px h-5" style={{ background: "var(--border)" }} />
      <span className="text-[12px]" style={{ color: COL.mut }}>USD→₹</span><input type="number" step="0.01" className="inp mono" style={{ width: 84 }} placeholder={fmt(fxr.USD)} value={usd} onChange={(e) => setUsd(e.target.value)} />
      <span className="text-[12px]" style={{ color: COL.mut }}>CAD→₹</span><input type="number" step="0.01" className="inp mono" style={{ width: 84 }} placeholder={fmt(fxr.CAD)} value={cad} onChange={(e) => setCad(e.target.value)} />
      <Btn kind="ghost" sm onClick={saveFx} disabled={!admin}><Icon n="check" s={13} />Save rates</Btn>
      <span className="w-px h-5" style={{ background: "var(--border)" }} />
      <span className="text-[12px]" style={{ color: COL.mut }}>Apply conversion</span>
      <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
        {[["off", "No conv"], ["USD", "USD→₹"], ["CAD", "CAD→₹"]].map(([k, l]) => <button key={k} onClick={() => setConvCur(k)} className="px-3 py-1.5 text-[12px] font-semibold navi" style={{ background: convCur === k ? COL.primary : "var(--c-low)", color: convCur === k ? "#fff" : COL.mut }}>{l}</button>)}
      </div>
      <Btn kind="sec" sm onClick={approveAll} disabled={!admin || !items.length}><Icon n="check" s={13} />Apply &amp; Approve all ({items.length})</Btn></div>
    <div className="flex gap-1.5 mb-3">{tabs.map(([k, l, n, c]) => <button key={k} onClick={() => { setTab(k); setBrand(""); }} className="px-4 py-2 rounded-lg text-[13px] font-semibold navi" style={{ background: tab === k ? "var(--c)" : "transparent", color: tab === k ? "#fff" : COL.mut, border: "1px solid " + (tab === k ? "var(--border)" : "transparent") }}>{l} <span className="mono" style={{ color: c }}>{fmtInt(n)}</span></button>)}</div>
    <div className="card flex-1 min-h-0 overflow-auto">
      <table className="w-full text-[12.5px]"><thead><tr className="lbl">{["", "Brand", "Product", "Base ₹", "Live", "≈₹", "Δ₹", `Markup ${targetCur}`, "Amount", "Currency", `Final ${targetCur}`, ""].map((h, i) => <th key={i} className="px-3 py-2.5 text-left whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>{items.map((it) => { const li = liveInr(it), dl = dInr(it), up = (dl || 0) > 0; return <tr key={it.id} style={{ borderTop: "1px solid var(--c-low)" }}>
          <td className="px-3 py-2"><input type="checkbox" checked={sel.has(it.id)} onChange={() => tog(it.id)} /></td>
          <td className="px-3 py-2 mono text-[11px]">{(it.brand || "").replace(/^www\./, "")}</td>
          <td className="px-3 py-2"><a href={it.url} target="_blank" rel="noopener" style={{ color: COL.primary }}>{trunc(it.url, 30)}</a></td>
          <td className="px-3 py-2 mono text-right">{fmt(it.base_price)}</td>
          <td className="px-3 py-2 mono text-right">{fmt(it.live_price)} <span style={{ color: COL.mut, fontSize: 10 }}>{it.currency}</span></td>
          <td className="px-3 py-2 mono text-right">{fmt(li)}</td>
          <td className="px-3 py-2 mono text-right" style={{ color: up ? COL.err : COL.sec }}>{dl != null ? (up ? "+" : "") + fmt(dl) : "—"}</td>
          <td className="px-3 py-2"><input type="number" className="inp mono text-right" style={{ width: 64 }} value={it._m} onChange={(e) => setItems((xs) => xs.map((x) => x.id === it.id ? { ...x, _m: e.target.value } : x))} /></td>
          <td className="px-3 py-2"><input type="number" className="inp mono text-right" style={{ width: 78 }} placeholder="amount" value={it._amt} onChange={(e) => setItems((xs) => xs.map((x) => x.id === it.id ? { ...x, _amt: e.target.value } : x))} /></td>
          <td className="px-3 py-2"><select className="inp mono" style={{ width: 78 }} value={it._cur} onChange={(e) => setItems((xs) => xs.map((x) => x.id === it.id ? { ...x, _cur: e.target.value } : x))}><option>INR</option><option>USD</option><option>CAD</option><option>EUR</option><option>GBP</option><option>AUD</option></select></td>
          <td className="px-3 py-2 mono text-right" style={{ color: COL.sec }}>{fmt(previewFinal(it))}</td>
          <td className="px-3 py-2"><div className="flex gap-1.5">{it.decision === "approved" ? <span style={{ color: COL.sec }}>✓</span> : <><button title="Approve · push to Shopify · remove from DB" onClick={() => decide(it, "approved")} style={{ color: COL.sec }} disabled={!admin}><Icon n="check" s={15} /></button><button title="Reject · remove from DB" onClick={() => del(it)} style={{ color: COL.err }} disabled={!admin}><Icon n="x" s={15} /></button></>}</div></td></tr>; })}
          {!items.length && <tr><td colSpan="12" className="text-center py-12" style={{ color: COL.mut }}>Nothing here.</td></tr>}</tbody></table></div>
  </div>;
}

/* ===================== HISTORY ===================== */
function History({ admin }) {
  const [d, setD] = useState({ items: [], count: 0, value: 0, pushed: 0 }); const [brand, setBrand] = useState("");
  const load = useCallback(() => api(`/api/history?brand=${encodeURIComponent(brand)}`).then(setD), [brand]);
  useEffect(() => { load(); }, [load]);
  const push = async (it) => { if (!admin) return toast("Admin only", "err"); toast("Pushing…"); const r = await aj("/api/history/push", { row: it.id }); toast(r.status || "done", r.ok ? "ok" : "err"); load(); };
  const pushAll = async () => { if (!admin || !confirm("Push all approved prices to store?")) return; toast("Pushing…"); const r = await aj("/api/history/push_all", {}); toast(`Pushed ${r.pushed}${r.failed ? ", " + r.failed + " failed" : ""}`, r.failed ? "err" : "ok"); load(); };
  const clearDb = async () => { if (!admin) return toast("Admin only", "err"); if (!d.count) return toast("History already empty", "ok"); if (!confirm(`Permanently delete ALL ${fmtInt(d.count)} review history records?\n\nThis only clears the review/approval archive. Products are not affected.`)) return; toast("Clearing review history…"); const r = await aj("/api/history/clear", {}); r.ok ? toast(`Cleared ${fmtInt(r.removed)} review records`, "ok") : toast(r.error || "Failed", "err"); load(); };
  return <div className="h-full overflow-auto">
    <div className="flex items-start justify-between mb-4"><div><h1 style={{ fontSize: 28, fontWeight: 600 }}>Approval History</h1><div className="text-[13px]" style={{ color: COL.mut }}>Approved prices archived from review.</div></div>
      <div className="flex gap-2.5 items-center"><VendorSelect value={brand} onChange={setBrand} /><Btn kind="ghost" sm onClick={() => window.location = "/api/history/export"}><Icon n="dl" s={13} />Export</Btn><Btn kind="primary" sm onClick={pushAll} disabled={!admin}><Icon n="share" s={13} />Push all</Btn><Btn kind="danger" sm onClick={clearDb} disabled={!admin || !d.count}><Icon n="x" s={13} />Clear DB</Btn></div></div>
    <div className="grid grid-cols-3 gap-3 mb-4"><Stat k="Approved" v={fmtInt(d.count)} /><Stat k="Total value" v={inr(d.value)} c={COL.sec} /><Stat k="Pushed" v={fmtInt(d.pushed) + "/" + fmtInt(d.count)} c={COL.primary} /></div>
    <div className="card overflow-auto"><table className="w-full text-[12.5px]"><thead><tr className="lbl">{["Brand", "Product", "Base ₹", "Final ₹", "Markup", "By", "When", "Store", ""].map((h, i) => <th key={i} className="px-3 py-2.5 text-left whitespace-nowrap">{h}</th>)}</tr></thead>
      <tbody>{d.items.map((it) => <tr key={it.id} style={{ borderTop: "1px solid var(--c-low)" }}>
        <td className="px-3 py-2.5 mono text-[11px]">{(it.brand || "").replace(/^www\./, "")}</td>
        <td className="px-3 py-2.5"><a href={it.url} target="_blank" rel="noopener" style={{ color: COL.primary }}>{trunc(it.url, 30)}</a></td>
        <td className="px-3 py-2.5 mono text-right">{fmt(it.base_price)}</td><td className="px-3 py-2.5 mono text-right" style={{ color: COL.sec }}>{fmt(it.final_price)}</td>
        <td className="px-3 py-2.5 mono text-right">{it.markup_pct != null ? (+it.markup_pct).toFixed(2) : "—"}</td>
        <td className="px-3 py-2.5 text-[11px]" style={{ color: COL.mut }}>{it.approved_by || "—"}</td>
        <td className="px-3 py-2.5 mono text-[11px]" style={{ color: COL.mut }}>{(it.approved_at || "").slice(0, 16).replace("T", " ")}</td>
        <td className="px-3 py-2.5 text-[11px]">{it.shopify_status ? <span style={{ color: COL.sec }}>{it.shopify_status.slice(0, 22)}</span> : <span style={{ color: COL.mut }}>not pushed</span>}</td>
        <td className="px-3 py-2.5"><button onClick={() => push(it)} style={{ color: COL.primary }}><Icon n="share" s={15} /></button></td></tr>)}
        {!d.items.length && <tr><td colSpan="9" className="text-center py-12" style={{ color: COL.mut }}>No approvals yet.</td></tr>}</tbody></table></div>
  </div>;
}

/* ===================== ALERTS ===================== */
function Alerts() {
  const [thr, setThr] = useState(15); const [dir, setDir] = useState("all"); const [brand, setBrand] = useState(""); const [d, setD] = useState({ items: [], total: 0, drops: 0, spikes: 0 });
  const load = useCallback(() => api(`/api/alerts?threshold=${thr}&direction=${dir}&brand=${encodeURIComponent(brand)}`).then(setD), [thr, dir, brand]);
  useEffect(() => { load(); }, [load]);
  return <div className="h-full min-h-0 flex flex-col">
    <h1 style={{ fontSize: 28, fontWeight: 600 }}>Price Movement Alerts</h1><div className="text-[13px] mb-4" style={{ color: COL.mut }}>Volatility vs the previous run.</div>
    <div className="card p-4 flex items-end gap-5 flex-wrap mb-4">
      <div><div className="lbl mb-1.5">Threshold %</div><input type="number" className="inp mono" style={{ width: 90 }} value={thr} onChange={(e) => setThr(e.target.value)} /></div>
      <div><div className="lbl mb-1.5">Filter</div><div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>{[["all", "All"], ["drop", "Drops"], ["spike", "Spikes"]].map(([k, l]) => <button key={k} onClick={() => setDir(k)} className="px-3.5 py-1.5 text-[12px] font-semibold navi" style={{ background: dir === k ? COL.primary : "var(--c-low)", color: dir === k ? "#fff" : COL.mut }}>{l}</button>)}</div></div>
      <div><div className="lbl mb-1.5">Vendor</div><VendorSelect value={brand} onChange={setBrand} /></div>
      <Btn kind="ghost" sm onClick={load}><Icon n="refresh" s={13} /></Btn></div>
    <div className="grid grid-cols-4 gap-2.5 mb-4"><Stat k="Alerts" v={fmtInt(d.total)} /><Stat k="Drops" v={fmtInt(d.drops)} c={COL.sec} /><Stat k="Spikes" v={fmtInt(d.spikes)} c={COL.err} /><Stat k="Threshold" v={"≥" + thr + "%"} c={COL.primary} /></div>
    <div className="card flex-1 min-h-0 overflow-auto"><table className="w-full text-[12.5px]"><thead><tr className="lbl">{["Product", "Brand", "Dir", "Prev", "Now", "Δ", "Change %", "When"].map((h, i) => <th key={i} className="px-3 py-2.5 text-left whitespace-nowrap">{h}</th>)}</tr></thead>
      <tbody>{d.items.map((it, i) => { const up = it.direction === "spike", c = up ? COL.err : COL.sec; return <tr key={i} style={{ borderTop: "1px solid var(--c-low)" }}>
        <td className="px-3 py-2.5"><a href={it.url} target="_blank" rel="noopener" style={{ color: COL.primary }}>{trunc(it.url, 32)}</a></td>
        <td className="px-3 py-2.5 mono text-[11px]">{(it.brand || "").replace(/^www\./, "")}</td>
        <td className="px-3 py-2.5"><span className="inline-flex items-center gap-1 font-bold text-[11px]" style={{ color: c }}><Icon n={up ? "up" : "down"} s={13} />{up ? "SPIKE" : "DROP"}</span></td>
        <td className="px-3 py-2.5 mono text-right">{fmt(it.prev)}</td><td className="px-3 py-2.5 mono text-right">{fmt(it.live_price)}</td>
        <td className="px-3 py-2.5 mono text-right" style={{ color: c }}>{fmt(it.abs_change)}</td><td className="px-3 py-2.5 mono text-right font-bold" style={{ color: c }}>{it.pct > 0 ? "+" : ""}{it.pct}%</td>
        <td className="px-3 py-2.5 mono text-[11px]" style={{ color: COL.mut }}>{(it.created_at || "").slice(0, 16).replace("T", " ")}</td></tr>; })}
        {!d.items.length && <tr><td colSpan="8" className="text-center py-12" style={{ color: COL.mut }}>No movements ≥ {thr}% — run the pipeline twice.</td></tr>}</tbody></table></div>
  </div>;
}

/* ===================== INTEGRATIONS ===================== */
function Integrations({ admin }) {
  const [cfg, setCfg] = useState({ shop_domain: "", api_version: "2024-10", dry_run: true, has_token: false, price_url_source: "mbo" }); const [token, setToken] = useState(""); const [brands, setBrands] = useState([]); const [v, setV] = useState("");
  const load = () => { api("/api/integration").then((d) => setCfg((c) => ({ ...c, ...d }))); api("/api/integrations").then((d) => setBrands(d.brands || [])); };
  useEffect(() => { load(); const t = setInterval(() => api("/api/integrations").then((d) => setBrands(d.brands || [])), 8000); return () => clearInterval(t); }, []);
  const save = async () => { const r = await aj("/api/integration/save", { ...cfg, access_token: token }); r.ok ? toast("Saved", "ok") : toast("Failed", "err"); setToken(""); load(); };
  const verify = async () => { setV("…"); const r = await aj("/api/integration/verify", {}); setV(r.status); toast(r.status, r.ok ? "ok" : "err"); };
  return <div className="h-full overflow-auto">
    <h1 style={{ fontSize: 28, fontWeight: 600 }}>Integrations</h1><div className="text-[13px] mb-4" style={{ color: COL.mut }}>One Shopify store · brands update live from Supabase.</div>
    <div className="card p-4 mb-4" style={{ maxWidth: 520 }}><div className="lbl mb-3">Shopify Store</div>
      <div className="lbl mb-1">Store domain</div><input className="inp w-full mono mb-2" placeholder="store.myshopify.com" value={cfg.shop_domain} onChange={(e) => setCfg({ ...cfg, shop_domain: e.target.value })} disabled={!admin} />
      <div className="lbl mb-1">Access token {cfg.has_token && <span style={{ color: COL.sec }}>· saved</span>}</div><input className="inp w-full mono mb-2" type="password" placeholder={cfg.has_token ? "••••••••" : "shpat_…"} value={token} onChange={(e) => setToken(e.target.value)} disabled={!admin} />
      <div className="flex items-center gap-3 mb-3"><div className="flex items-center gap-2"><span className="lbl">API</span><input className="inp mono" style={{ width: 100 }} value={cfg.api_version} onChange={(e) => setCfg({ ...cfg, api_version: e.target.value })} disabled={!admin} /></div>
        <div className="flex items-center gap-2"><Toggle on={!cfg.dry_run} onChange={(x) => setCfg({ ...cfg, dry_run: !x })} /><span className="text-[12px]" style={{ color: cfg.dry_run ? COL.ter : COL.sec }}>{cfg.dry_run ? "Dry Run" : "Live"}</span></div></div>
      <div className="flex items-center justify-between rounded-lg p-3 mb-3" style={{ background: "var(--c-low)", border: "1px solid var(--border)" }}>
        <div><div className="text-[12px] font-semibold">Shopify price-update URL</div>
          <div className="text-[10px]" style={{ color: COL.mut }}>{cfg.price_url_source === "mbo" ? "Use MBO Shopify Admin/Product URL" : "Use Designer Product URL"}</div></div>
        <Toggle on={cfg.price_url_source === "mbo"} onChange={(on) => setCfg({ ...cfg, price_url_source: on ? "mbo" : "designer" })} />
      </div>
      <div className="flex gap-2"><Btn kind="primary" sm onClick={save} disabled={!admin}><Icon n="check" s={13} />Save</Btn><Btn kind="ghost" sm onClick={verify}><Icon n="plug" s={13} />Verify</Btn></div>
      {v && <div className="text-[11px] mt-2" style={{ color: COL.mut }}>{v}</div>}</div>
    <div className="lbl mb-2">Brands in catalog (live)</div>
    <div className="card overflow-auto"><table className="w-full text-[12.5px]"><thead><tr className="lbl">{["Brand", "Products", "Mismatches"].map((h, i) => <th key={i} className="px-3 py-2.5 text-left">{h}</th>)}</tr></thead>
      <tbody>{brands.map((b) => <tr key={b.brand} style={{ borderTop: "1px solid var(--c-low)" }}><td className="px-3 py-2.5 mono">{b.brand}</td><td className="px-3 py-2.5 mono">{fmtInt(b.products)}</td><td className="px-3 py-2.5 mono" style={{ color: COL.ter }}>{fmtInt(b.mismatches)}</td></tr>)}
        {!brands.length && <tr><td colSpan="3" className="text-center py-10" style={{ color: COL.mut }}>No brands.</td></tr>}</tbody></table></div>
  </div>;
}

/* ===================== SETTINGS (owner) ===================== */
function Settings({ me }) {
  const [sessions, setSessions] = useState([]); const [users, setUsers] = useState([]); const owner = me.role === "owner";
  const load = () => { if (!owner) return; api("/api/admin/sessions").then((d) => setSessions(d.sessions || [])); api("/api/admin/users").then((d) => setUsers(d.users || [])); };
  useEffect(() => { load(); if (owner) { const t = setInterval(() => api("/api/admin/sessions").then((d) => setSessions(d.sessions || [])), 5000); return () => clearInterval(t); } }, [owner]);
  const setRole = async (email, role) => { await aj("/api/admin/users/role", { email, role }); toast("Role updated", "ok"); load(); };
  const del = async (email) => { if (!confirm("Delete " + email + "?")) return; const r = await aj("/api/admin/users/delete", { email }); r.ok ? toast("Deleted", "ok") : toast(r.error, "err"); load(); };
  if (!owner) return <div className="card p-6" style={{ maxWidth: 420 }}><div className="lbl mb-2">Account</div><div className="text-[14px]">{me.email}</div><div className="text-[12px]" style={{ color: COL.mut }}>role: {me.role}</div></div>;
  return <div className="h-full overflow-auto space-y-4">
    <h1 style={{ fontSize: 28, fontWeight: 600 }}>Owner Console</h1>
    <div><div className="lbl mb-2">Active sessions ({sessions.filter((s) => s.active).length} live)</div>
      <div className="card overflow-auto"><table className="w-full text-[12.5px]"><thead><tr className="lbl">{["User", "Role", "IP", "Idle", "Status"].map((h, i) => <th key={i} className="px-3 py-2.5 text-left">{h}</th>)}</tr></thead>
        <tbody>{sessions.map((s) => <tr key={s.sid} style={{ borderTop: "1px solid var(--c-low)" }}><td className="px-3 py-2.5">{s.email}</td><td className="px-3 py-2.5 mono">{s.role}</td><td className="px-3 py-2.5 mono text-[11px]">{s.ip}</td><td className="px-3 py-2.5 mono">{s.idle_s}s</td><td className="px-3 py-2.5"><span style={{ color: s.active ? COL.sec : COL.mut }}>{s.active ? "● live" : "idle"}</span></td></tr>)}
          {!sessions.length && <tr><td colSpan="5" className="text-center py-8" style={{ color: COL.mut }}>No sessions.</td></tr>}</tbody></table></div></div>
    <div><div className="lbl mb-2">Users</div>
      <div className="card overflow-auto"><table className="w-full text-[12.5px]"><thead><tr className="lbl">{["Email", "Role", ""].map((h, i) => <th key={i} className="px-3 py-2.5 text-left">{h}</th>)}</tr></thead>
        <tbody>{users.map((u) => <tr key={u.id} style={{ borderTop: "1px solid var(--c-low)" }}><td className="px-3 py-2.5">{u.email}</td>
          <td className="px-3 py-2.5"><select className="inp mono" value={u.role} onChange={(e) => setRole(u.email, e.target.value)} disabled={u.email === me.email}><option>owner</option><option>admin</option><option>viewer</option></select></td>
          <td className="px-3 py-2.5">{u.email !== me.email && <button onClick={() => del(u.email)} style={{ color: COL.err }}><Icon n="x" s={15} /></button>}</td></tr>)}</tbody></table></div></div>
  </div>;
}

/* ===================== SHELL ===================== */
export default function App() {
  const [me, setMe] = useState(undefined); const [view, setView] = useState("home"); const [meta, setMeta] = useState({ counts: {}, alerts: 0 });
  useEffect(() => { api("/api/me").then((d) => setMe(d && d.email ? d : null)); }, []);
  useEffect(() => { if (!me) return; const f = () => api("/api/meta").then((d) => d.counts && setMeta((m) => JSON.stringify(m) === JSON.stringify(d) ? m : d)); f(); const t = setInterval(f, 15000); return () => clearInterval(t); }, [me]);
  if (me === undefined) return <div className="h-full flex items-center justify-center" style={{ color: COL.mut }}>Loading…</div>;
  if (!me) return <><Toaster /><Auth onIn={(d) => setMe(d)} /></>;
  const admin = me.role === "admin" || me.role === "owner";
  const nav = [["home", "Home", "home"], ["pipeline", "Pipeline", "pipeline"], ["review", "Review", "review"], ["history", "History", "clock"], ["alerts", "Alerts", "alerts"], ["integrations", "Integrations", "plug"]];
  const titles = { home: "Insights", pipeline: "Pipeline", review: "Review", history: "History", alerts: "Alerts", integrations: "Integrations", settings: "Settings" };
  return <div className="flex h-screen"><Toaster />
    <nav className="shrink-0 flex flex-col p-3" style={{ width: 220, background: "var(--surface)", borderRight: "1px solid var(--border)" }}>
      <div className="flex items-center gap-2.5 px-2 py-2 mb-4"><div style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#3b82f6,#4ae176)" }} /><div><div style={{ fontWeight: 800 }}>MBO Tracker</div><div className="lbl">Terminal v2.4</div></div></div>
      {nav.map(([k, l, ic]) => <button key={k} onClick={() => setView(k)} className="navi flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-semibold mb-1" style={{ background: view === k ? "rgba(59,130,246,.14)" : "transparent", color: view === k ? "#fff" : COL.mut, borderLeft: "2px solid " + (view === k ? COL.primary : "transparent") }}><Icon n={ic} s={16} />{l}{k === "review" && meta.counts.awaiting > 0 && <span className="ml-auto mono text-[10px] px-1.5 rounded" style={{ background: COL.ter + "22", color: COL.ter }}>{meta.counts.awaiting}</span>}{k === "alerts" && meta.alerts > 0 && <span className="ml-auto mono text-[10px] px-1.5 rounded" style={{ background: COL.err + "22", color: COL.err }}>{meta.alerts}</span>}</button>)}
      <div className="mt-auto">
        <button onClick={() => setView("settings")} className="navi flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-semibold w-full" style={{ color: view === "settings" ? "#fff" : COL.mut }}><Icon n="gear" s={16} />Settings</button>
        <div className="pt-2 mt-2 flex items-center gap-2 text-[11px]" style={{ borderTop: "1px solid var(--border)", color: COL.mut }}><span className="w-2 h-2 rounded-full pdot" style={{ background: COL.sec }} />Supabase · live</div></div>
    </nav>
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center justify-between px-5 py-3" style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <h1 className="text-[15px] font-bold">{titles[view]}</h1>
        <div className="flex items-center gap-3"><div className="text-right leading-tight"><div className="text-[12px] font-semibold">{me.email}</div><div className="lbl" style={{ color: me.role === "owner" ? COL.sec : COL.mut }}>{me.role}</div></div>
          <div className="rounded-full flex items-center justify-center text-[12px] font-bold" style={{ width: 32, height: 32, background: COL.primary, color: "#fff" }}>{me.email[0].toUpperCase()}</div>
          <button onClick={async () => { await api("/api/logout"); setMe(null); }} title="Sign out" style={{ color: COL.mut }}><Icon n="logout" s={17} /></button></div></div>
      <div className="flex-1 min-h-0 p-5">
        {view === "home" && <Home go={setView} />}{view === "pipeline" && <Pipeline admin={admin} />}{view === "review" && <Review admin={admin} />}
        {view === "history" && <History admin={admin} />}{view === "alerts" && <Alerts />}{view === "integrations" && <Integrations admin={admin} />}
        {view === "settings" && <Settings me={me} />}
      </div></div></div>;
}
