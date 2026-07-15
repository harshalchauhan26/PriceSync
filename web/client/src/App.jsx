import React, { useState, useEffect, useRef, useCallback } from "react";
import Chart from "chart.js/auto";

/* ─── helpers ──────────────────────────────────────────────── */
const fmt   = (n) => (n == null || n === "") ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtInt= (n) => (n == null ? "0" : Number(n).toLocaleString());
const inr   = (n) => n == null ? "—" : "₹" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const roundFinal = (n) => { const v = Number(n); if (n == null || !Number.isFinite(v)) return n; const r = Math.round(v); const t = Math.floor(r/10)*10; const d = r-t; return d<=2?t:d<=5?t+5:t+10; };
const trunc = (u, n=44) => { if (!u) return "—"; let l = u.replace(/^https?:\/\//,""); return l.length>n ? l.slice(0,n-1)+"…":l; };
const elapsed = (s) => `${String(Math.floor(s/60)).padStart(2,"0")}m ${String(s%60).padStart(2,"0")}s`;
async function api(path, opts) { const r = await fetch(path, opts); try { return await r.json(); } catch { return {}; } }
const aj = (path, body) => api(path, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body||{}) });

/* ─── toasts ───────────────────────────────────────────────── */
let _toast = () => {};
function Toaster() {
  const [xs, setXs] = useState([]);
  _toast = (text, kind) => { const id = Math.random(); setXs(a=>[...a,{id,text,kind}]); setTimeout(()=>setXs(a=>a.filter(i=>i.id!==id)),3500); };
  return <div style={{ position:"fixed", top:16, right:16, zIndex:9999, display:"flex", flexDirection:"column", gap:8 }}>
    {xs.map(t=><div key={t.id} className="toastin card2" style={{ padding:"10px 16px", fontSize:12.5, fontWeight:600, border:"1px solid "+(t.kind==="err"?"rgba(239,68,68,.4)":"rgba(34,197,94,.35)"), color: t.kind==="err"?"#ef4444":"#e2e0ee", minWidth:280, maxWidth:380, boxShadow:"0 8px 32px rgba(0,0,0,.6)" }}>{t.text}</div>)}
  </div>;
}
const toast = (t, k="ok") => _toast(t, k);

/* ─── icons ────────────────────────────────────────────────── */
const PATHS = {
  pipeline:"M3 3v18h18M7 14l3-3 3 3 5-6",
  review:"M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  clock:"M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  alerts:"M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a2 2 0 0 0 3.4 0",
  plug:"M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v6",
  gear:"M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8M4.6 9a1.6 1.6 0 0 0-.3-1.8",
  home:"M3 11l9-8 9 8M5 10v10h14V10",
  play:"M8 5v14l11-7z",
  refresh:"M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5",
  stop:"M6 6h12v12H6z",
  upload:"M12 16V4M7 9l5-5 5 5M5 20h14",
  dl:"M12 3v12m-5-5 5 5 5-5M5 21h14",
  check:"M20 6 9 17l-5-5",
  x:"M18 6 6 18M6 6l12 12",
  search:"M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  share:"M4 12v8h16v-8M12 16V4M8 8l4-4 4 4",
  up:"M12 19V5M5 12l7-7 7 7",
  down:"M12 5v14M5 12l7 7 7-7",
  logout:"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  trash:"M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  db:"M12 2C7.58 2 4 3.79 4 6v12c0 2.21 3.58 4 8 4s8-1.79 8-4V6c0-2.21-3.58-4-8-4ZM4 12c0 2.21 3.58 4 8 4s8-1.79 8-4M4 9c0 2.21 3.58 4 8 4s8-1.79 8-4",
  warn:"M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z",
  filter:"M22 3H2l8 9.46V19l4 2v-8.54L22 3",
  mail:"M4 4h16v16H4zM4 6l8 6 8-6",
  plus:"M12 5v14M5 12h14",
};
const Icon = ({n,s=15,c="currentColor"}) =>
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {(PATHS[n]||"").split("M").filter(Boolean).map((d,i)=><path key={i} d={"M"+d}/>)}
  </svg>;

/* ─── Toggle ───────────────────────────────────────────────── */
function Toggle({on, onChange}) {
  return <button onClick={()=>onChange(!on)} className="tog-wrap"
    style={{ background: on?"#22c55e":"rgba(255,255,255,.08)" }}>
    <span className="tog-knob" style={{ left: on?20:3, background: on?"#03120a":"#5c5a72" }} />
  </button>;
}

/* ─── Vendor select (single) ───────────────────────────────── */
function VendorSelect({value, onChange, kind, source}) {
  const [vs, setVs] = useState([]);
  useEffect(()=>{ let u="/api/vendors"+(kind?"?kind="+kind:""); if(source) u+=(kind?"&":"?")+"source="+source; api(u).then(d=>setVs(d.vendors||[])); },[kind,source]);
  return <select className="inp mono" style={{minWidth:180}} value={value} onChange={e=>onChange(e.target.value)}>
    <option value="">All vendors ({vs.length})</option>
    {vs.map(v=><option key={v.vendor} value={v.vendor}>{v.vendor.replace(/^www\./,"")} · {v.count}</option>)}
  </select>;
}

/* ─── Brand multi-select ───────────────────────────────────── */
function BrandMultiSelect({value, onChange, kind}) {
  const [vs,setVs]=useState([]); const [open,setOpen]=useState(false); const [q,setQ]=useState(""); const ref=useRef(null);
  useEffect(()=>{ api("/api/vendors"+(kind?"?kind="+kind:"")).then(d=>setVs(d.vendors||[])); },[kind]);
  useEffect(()=>{ const h=(e)=>{ if(ref.current&&!ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown",h); return()=>document.removeEventListener("mousedown",h); },[]);
  const sel=new Set(value);
  const toggle=(v)=>{ const n=new Set(sel); n.has(v)?n.delete(v):n.add(v); onChange([...n]); };
  const shown=vs.filter(v=>!q||v.vendor.toLowerCase().includes(q.toLowerCase()));
  const label=value.length===0?`All brands (${vs.length})`:`${value.length} brand${value.length>1?"s":""} selected`;
  return <div className="relative" ref={ref} style={{position:"relative"}}>
    <button onClick={()=>setOpen(o=>!o)} className="inp" style={{minWidth:200,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,cursor:"pointer"}}>
      <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12}}>{label}</span>
      <Icon n="search" s={12} c="var(--on3)" />
    </button>
    {open&&<div className="card2" style={{position:"absolute",zIndex:50,top:"calc(100% + 4px)",left:0,width:260,padding:10,boxShadow:"0 16px 48px rgba(0,0,0,.7)"}}>
      <input className="inp" style={{width:"100%",marginBottom:8}} placeholder="Search brands…" value={q} onChange={e=>setQ(e.target.value)} autoFocus />
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:11}}>
        <span style={{color:"var(--blue)",cursor:"pointer"}} onClick={()=>onChange([...new Set([...value,...shown.map(v=>v.vendor)])])}>Select all</span>
        <span style={{color:"var(--on3)",cursor:"pointer"}} onClick={()=>onChange([])}>Clear</span>
      </div>
      <div style={{maxHeight:220,overflowY:"auto",display:"flex",flexDirection:"column",gap:2}}>
        {shown.map(v=><label key={v.vendor} className="vendor-row">
          <input type="checkbox" checked={sel.has(v.vendor)} onChange={()=>toggle(v.vendor)} />
          <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.vendor.replace(/^www\./,"")}</span>
          <span style={{color:"var(--on3)",fontSize:11}}>{v.count}</span>
        </label>)}
        {!shown.length&&<div style={{textAlign:"center",padding:"12px 0",color:"var(--on3)",fontSize:12}}>No brands</div>}
      </div>
    </div>}
  </div>;
}

/* ─── Shopify push job progress (batches of 10) ────────────── */
function PushJobPanel({job:initial, onDone, onClose}) {
  const [job,setJob]=useState(initial);
  const cbRef=useRef({onDone}); cbRef.current={onDone};
  useEffect(()=>{
    setJob(initial);
    if(!initial?.id||initial.state==="done") return;
    let alive=true, t=null;
    const tick=async()=>{
      const r=await api(`/api/push/job?id=${encodeURIComponent(initial.id)}`);
      if(!alive) return;
      const j=r.job;
      if(j) setJob(j);
      if(!j||j.state==="done"){
        if(j) toast(j.fail?`Shopify push finished — ${j.ok} ok, ${j.fail} failed`:`Shopify push finished — all ${j.ok} updated`, j.fail?"err":"ok");
        cbRef.current.onDone?.(); return;
      }
      t=setTimeout(tick,1200);
    };
    t=setTimeout(tick,700);
    return ()=>{ alive=false; clearTimeout(t); };
  },[initial?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if(!job) return null;
  const pct=job.total?Math.round(job.done/job.total*100):100;
  const running=job.state==="running";
  const itemDot=(s)=>s==="ok"?["✓","var(--green)"]:s==="failed"?["✗","var(--red)"]:s==="pushing"?["●","var(--blue)"]:["·","var(--on3)"];
  return <div className="card" style={{padding:"12px 16px",marginBottom:12,border:"1px solid "+(running?"rgba(59,130,246,.35)":job.fail?"rgba(239,68,68,.35)":"rgba(34,197,94,.3)")}}>
    <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <span className="lbl">Shopify Push</span>
      <span style={{fontSize:12,color:"var(--on2)"}}>{job.label}</span>
      <span className="mono" style={{fontSize:12}}>{job.done}/{job.total}</span>
      <span className="mono" style={{fontSize:12,color:"var(--green)"}}>✓ {job.ok}</span>
      {job.fail>0&&<span className="mono" style={{fontSize:12,color:"var(--red)"}}>✗ {job.fail}</span>}
      <span style={{fontSize:11,color:running?"var(--blue)":"var(--on3)"}}>{running?"pushing in batches of "+(job.batch_size||10)+"…":"finished"}</span>
      {job.error&&<span style={{fontSize:11,color:"var(--red)"}}>{job.error}</span>}
      <div style={{flex:1}}/>
      {!running&&<button className="btn btn-ghost btn-sm" onClick={onClose}><Icon n="x" s={12}/>Dismiss</button>}
    </div>
    <div className="progress-track" style={{margin:"10px 0"}}>
      <div className="progress-fill" style={{width:pct+"%"}}/>
    </div>
    <div style={{maxHeight:280,overflowY:"auto",display:"flex",flexDirection:"column",gap:10}}>
      {job.batches.map(b=>{
        const c=b.status==="done"?(b.fail?"var(--red)":"var(--green)"):b.status==="running"?"var(--blue)":"var(--on3)";
        return <div key={b.n}>
          <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,fontWeight:700,letterSpacing:.4,color:c}}>
            <span>BATCH {b.n}</span>
            <span className="mono" style={{fontWeight:400,fontSize:11.5}}>
              {b.status==="waiting"?"waiting":b.status==="running"?`pushing ${b.ok+b.fail}/${b.items.length}…`:`done · ${b.ok} ok${b.fail?` · ${b.fail} failed`:""}`}
            </span>
          </div>
          {b.status!=="waiting"&&<div style={{marginTop:4,display:"flex",flexDirection:"column",gap:2}}>
            {b.items.map((it,i)=>{ const [dot,dc]=itemDot(it.status); return <div key={i} style={{display:"flex",gap:8,alignItems:"center",fontSize:11.5,paddingLeft:14}}>
              <span className="mono" style={{width:10,textAlign:"center",color:dc}}>{dot}</span>
              <span className="mono" style={{color:"var(--on3)",minWidth:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{(it.brand||"").replace(/^www\./,"")}</span>
              <span style={{color:"var(--on2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:300}}>{trunc(it.url,44)}</span>
              <span className="mono" style={{color:"var(--green)"}}>{fmt(it.price)}</span>
              <span style={{color:it.status==="failed"?"var(--red)":"var(--on3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{it.message}</span>
            </div>;})}
          </div>}
        </div>;
      })}
    </div>
  </div>;
}

/* ─── Stat card ────────────────────────────────────────────── */
const Stat = ({k,v,c}) =>
  <div className="stat-card">
    <div className="lbl">{k}</div>
    <div className="stat-val mono" style={{color:c||"var(--on)"}}>{v}</div>
  </div>;

/* ─── Chart box ────────────────────────────────────────────── */
function ChartBox({type,labels,datasets,options,h=200}) {
  const ref=useRef(null), inst=useRef(null);
  const sig=JSON.stringify({type,labels,datasets,options});
  useEffect(()=>{
    if(!ref.current) return; if(inst.current) inst.current.destroy();
    inst.current=new Chart(ref.current.getContext("2d"),{type,data:{labels,datasets},
      options:Object.assign({responsive:true,maintainAspectRatio:false,animation:false,
        plugins:{legend:{labels:{color:"#5c5a72",font:{size:10}}}},
        scales:(type==="doughnut")?{}:{
          x:{ticks:{color:"#5c5a72",font:{size:10}},grid:{color:"rgba(255,255,255,.04)"}},
          y:{ticks:{color:"#5c5a72",font:{size:10}},grid:{color:"rgba(255,255,255,.04)"}}}},options||{})});
    return()=>inst.current&&inst.current.destroy();
  },[sig,h]);
  return <div style={{height:h}}><canvas ref={ref}/></div>;
}

/* ─── Clear-view button — never deletes rows or price data. On History
       it just resets what's rendered locally; on Review it persists a
       "don't show me this again" flag via onClear (see dismissView). ── */
function ClearViewBtn({onClear, title}) {
  return <button className="btn btn-ghost btn-sm" onClick={onClear} title={title||"Clear the rows shown below"}>
    <Icon n="x" s={12}/>Clear view
  </button>;
}

/* ─── Page toolbar (vendor filter + clear) ─────────────────── */
function PageBar({title, subtitle, admin, vendor, onVendor, onClear, extraLeft, extraRight, kind, source}) {
  return <div style={{marginBottom:20}}>
    <div style={{marginBottom:12}}>
      <h1 style={{fontSize:22,fontWeight:700,letterSpacing:"-.01em"}}>{title}</h1>
      {subtitle&&<div style={{fontSize:12,color:"var(--on2)",marginTop:3}}>{subtitle}</div>}
    </div>
    <div className="toolbar">
      {extraLeft}
      <div className="toolbar-sep"/>
      <Icon n="filter" s={13} c="var(--on3)"/>
      <VendorSelect value={vendor} onChange={onVendor} kind={kind} source={source}/>
      <button className="btn btn-sm btn-ghost" onClick={onClear} title="Clear filters & screen">
        <Icon n="x" s={12}/>Clear
      </button>
      {extraRight}
    </div>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════════════ */
function Auth({onIn}) {
  const [mode,setMode]=useState("login"); const [email,setE]=useState(""); const [pw,setPw]=useState(""); const [err,setErr]=useState(""); const [busy,setBusy]=useState(false);
  const gRef=useRef(null); const [gReady,setGReady]=useState(false);
  const submit=async(e)=>{ e.preventDefault(); setBusy(true); setErr(""); const d=await aj(mode==="login"?"/api/login":"/api/register",{email,password:pw}); setBusy(false); if(d.ok) onIn(d); else setErr(d.error||"Failed"); };
  useEffect(()=>{
    let dead=false;
    api("/api/auth/google/config").then(cfg=>{
      if(dead||!cfg.client_id) return;
      const init=()=>{ if(dead||!gRef.current) return;
        window.google.accounts.id.initialize({client_id:cfg.client_id,callback:async(resp)=>{
          const d=await aj("/api/auth/google",{credential:resp.credential});
          d.ok?onIn(d):setErr(d.error||"Google sign-in failed");
        }});
        window.google.accounts.id.renderButton(gRef.current,{theme:"outline",size:"large",width:286});
        setGReady(true);
      };
      if(window.google?.accounts?.id) init();
      else{ const s=document.createElement("script"); s.src="https://accounts.google.com/gsi/client"; s.async=true; s.onload=init; document.head.appendChild(s); }
    });
    return()=>{dead=true;};
  },[]);
  return <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",background:"var(--bg)"}}>
    <form onSubmit={submit} className="card" style={{width:360,padding:36}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:24}}>
        <div style={{width:38,height:38,borderRadius:10,background:"linear-gradient(135deg,#3b82f6,#22c55e)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⚡</div>
        <div>
          <div style={{fontWeight:800,fontSize:17,letterSpacing:"-.02em"}}>MBO Tracker</div>
          <div className="lbl">Terminal v2.4</div>
        </div>
      </div>
      <div className="lbl" style={{marginBottom:4}}>Email</div>
      <input className="inp" style={{width:"100%",marginBottom:12}} type="email" value={email} onChange={e=>setE(e.target.value)} autoFocus required/>
      <div className="lbl" style={{marginBottom:4}}>Password</div>
      <input className="inp" style={{width:"100%"}} type="password" value={pw} onChange={e=>setPw(e.target.value)} required/>
      <button disabled={busy} style={{width:"100%",marginTop:20,padding:"11px 0",borderRadius:8,background:"#3b82f6",color:"#fff",fontWeight:700,fontSize:14,border:"none",cursor:"pointer"}}>
        {busy?"…":(mode==="login"?"Sign in":"Create account")}
      </button>
      <div style={{marginTop:14}}>
        {gReady&&<div style={{display:"flex",alignItems:"center",gap:8,color:"var(--on3)",fontSize:11,marginBottom:10}}>
          <div style={{flex:1,height:1,background:"var(--border)"}}/>or<div style={{flex:1,height:1,background:"var(--border)"}}/>
        </div>}
        <div ref={gRef} style={{display:"flex",justifyContent:"center"}}/>
      </div>
      <div style={{marginTop:10,fontSize:12,color:"#ef4444",minHeight:16}}>{err}</div>
      <div style={{fontSize:12,color:"var(--on3)"}}>
        {mode==="login"
          ? <>No account? <span onClick={()=>setMode("register")} style={{color:"#3b82f6",cursor:"pointer"}}>Create one</span></>
          : <>Have an account? <span onClick={()=>setMode("login")} style={{color:"#3b82f6",cursor:"pointer"}}>Sign in</span></>}
      </div>
    </form>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════
   HOME / INSIGHTS
═══════════════════════════════════════════════════════════════ */
function Home({go, admin}) {
  const [d,setD]=useState(null); const [brand,setBrand]=useState("");
  const load=useCallback(()=>{ setD(null); api("/api/insights?brand="+encodeURIComponent(brand)).then(setD); },[brand]);
  useEffect(()=>{ load(); },[load]);
  const clear=()=>{ setBrand(""); };
  const Row=({l,v,c})=><div style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid var(--border)"}}>
    <span style={{fontSize:12,color:"var(--on2)"}}>{l}</span>
    <b className="mono" style={{color:c||"var(--on)"}}>{v}</b>
  </div>;
  if(!d) return <div style={{height:"100%",overflow:"auto"}}>
    <PageBar title="Insights" admin={admin} vendor={brand} onVendor={setBrand} onClear={clear} extraRight={<button className="btn btn-sm btn-ghost" onClick={load}><Icon n="refresh" s={12}/>Refresh</button>}/>
    <div style={{textAlign:"center",padding:"80px 0",color:"var(--on3)"}}>Loading insights…</div>
  </div>;
  const c=d.counts||{}, ex=d.exposure||{}, fxr=d.fx||{};
  return <div style={{height:"100%",overflow:"auto"}}>
    <PageBar title="Insights" admin={admin} vendor={brand} onVendor={setBrand} onClear={clear}
      extraRight={<button className="btn btn-sm btn-ghost" onClick={load}><Icon n="refresh" s={12}/>Refresh</button>}/>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:16}}>
      {[["Total Products",fmtInt(c.total),"var(--on)"],["Matched",fmtInt(c.matched),"var(--green)"],["Mismatches",fmtInt(c.mismatch),"var(--amber)"],["Errors",fmtInt(c.error),"var(--red)"],["Vendors",fmtInt(d.vendors),"var(--blue)"],["Awaiting",fmtInt(c.awaiting),"var(--amber)"],["Approved",fmtInt(d.approved_count),"var(--green)"],["Overpriced",inr(Math.round(ex.over||0)),"var(--red)"]].map(([a,b,c2])=><Stat key={a} k={a} v={b} c={c2}/>)}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
      <div className="card" style={{padding:16}}>
        <div className="lbl" style={{marginBottom:12}}>Catalog Status</div>
        <ChartBox type="doughnut" h={200} labels={["Matched","Mismatch","Error","Pending"]} datasets={[{data:[c.matched,c.mismatch,c.error,c.pending],backgroundColor:["#22c55e","#f59e0b","#ef4444","#27273a"],borderWidth:0}]} options={{plugins:{legend:{position:"bottom"}},cutout:"60%"}}/>
      </div>
      <div className="card" style={{padding:16}}>
        <div className="lbl" style={{marginBottom:12}}>Top Vendors by Mismatch</div>
        <ChartBox type="bar" h={200} labels={d.top_mismatch.map(v=>v.brand.replace(/\.(com|in|co).*/,""))} datasets={[{data:d.top_mismatch.map(v=>v.count),backgroundColor:"#f59e0b",borderRadius:4}]} options={{indexAxis:"y",plugins:{legend:{display:false}}}}/>
      </div>
      <div className="card" style={{padding:16}}>
        <div className="lbl" style={{marginBottom:12}}>Largest Vendors</div>
        <ChartBox type="bar" h={200} labels={d.top_products.map(v=>v.brand.replace(/\.(com|in|co).*/,""))} datasets={[{data:d.top_products.map(v=>v.count),backgroundColor:"#3b82f6",borderRadius:4}]} options={{indexAxis:"y",plugins:{legend:{display:false}}}}/>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
      <div className="card" style={{padding:16}}>
        <div className="lbl" style={{marginBottom:10}}>Exposure (Mismatch Gap)</div>
        <Row l="Overpriced" v={inr(Math.round(ex.over||0))} c="var(--red)"/>
        <Row l="Underpriced" v={inr(Math.round(ex.under||0))} c="var(--green)"/>
        <Row l="Avg gap" v={inr(Math.round(ex.avg||0))}/>
        <Row l="Approved value" v={inr(Math.round(d.approved_value||0))} c="var(--green)"/>
      </div>
      <div className="card" style={{padding:16}}>
        <div className="lbl" style={{marginBottom:10}}>Live FX → INR</div>
        {["USD","CAD"].map(cu=><Row key={cu} l={cu} v={"₹"+fmt(fxr[cu])} c="var(--blue)"/>)}
      </div>
      <div className="card" style={{padding:16}}>
        <div className="lbl" style={{marginBottom:10}}>Quick Actions</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <button className="btn btn-primary" style={{justifyContent:"center"}} onClick={()=>go("pipeline")}><Icon n="play" s={14}/>Run Pipeline</button>
          <button className="btn btn-ghost" style={{justifyContent:"center"}} onClick={()=>go("review")}><Icon n="review" s={14}/>Review {fmtInt(c.awaiting)} awaiting</button>
          <button className="btn btn-ghost" style={{justifyContent:"center"}} onClick={()=>go("history")}><Icon n="clock" s={14}/>Approval History</button>
        </div>
      </div>
    </div>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════
   PIPELINE
═══════════════════════════════════════════════════════════════ */
function Pipeline({admin}) {
  const [st,setSt]=useState({entries:[],matched:0,mismatch:0,errors:0,total_rows:0,current_row:0,elapsed:0,message:"Idle.",running:false,phase:"idle",log_total:0});
  const [cfg,setCfg]=useState({concurrency:16,timeout_ms:12000,batch_size:250,rest_between:2,threads:4,safe_retry:true,simulation:false,data_source:"database"});
  const [vendors,setVendors]=useState([]); const [vsel,setVsel]=useState([]); const [cat,setCat]=useState({total:0}); const [curSel,setCurSel]=useState("INR");
  const cursor=useRef(0), logRef=useRef(null);

  useEffect(()=>{ api("/api/pipe/status?cursor=0").then(d=>d.config&&setCfg(c=>({...c,...d.config}))); },[]);
  const refreshMeta=useCallback(()=>{
    api("/api/vendors?source="+cfg.data_source).then(d=>setVendors(d.vendors||[]));
    api("/api/meta").then(d=>d.counts&&setCat({...d.counts,imported:d.imported_count||0}));
  },[cfg.data_source]);
  useEffect(()=>{ refreshMeta(); },[refreshMeta]);

  const poll=useCallback(async()=>{
    const d=await api("/api/pipe/status?cursor="+cursor.current);
    if(d.running===undefined) return;
    cursor.current=d.cursor;
    setSt(s=>({...d,entries:[...s.entries,...(d.entries||[])].slice(-500)}));
  },[]);
  useEffect(()=>{ let live=true; const loop=async()=>{ if(!live) return; await poll(); setTimeout(loop,st.running?700:2500); }; loop(); return()=>{live=false;}; },[poll,st.running]);
  useEffect(()=>{ if(logRef.current) logRef.current.scrollTop=logRef.current.scrollHeight; },[st.entries.length]);

  const send=(extra)=>aj("/api/pipe/config",{...cfg,...extra});
  const run=async(mode)=>{
    await send({fresh_start:mode==="fresh",retry_errors:mode==="update",vendors:vsel});
    const d=await aj("/api/pipe/start",{});
    d.error?toast(d.error,"err"):toast("Pipeline started","ok");
    setSt(s=>({...s,entries:[]})); cursor.current=0;
  };
  const clearLog=()=>{ setSt(s=>({...s,entries:[]})); aj("/api/pipe/clear_log",{}); };
  const onFile=async(f)=>{
    if(!f||!admin) return;
    const fd=new FormData(); fd.append("file",f);
    toast("Reading "+f.name+"…");
    const p=await api("/api/import/preview",{method:"POST",body:fd});
    if(!p.ok) return toast(p.error||"Preview failed","err");
    const fd2=new FormData(); fd2.append("file",f);
    const r=await api("/api/import",{method:"POST",body:fd2});
    r.ok?toast(`Staged: ${r.rows} products · click Sync to save`,"ok"):toast(r.error||"Import failed","err");
    refreshMeta();
  };
  const setCurrency=async()=>{
    if(!admin) return toast("Admin only","err");
    if(!confirm(`Set currency to ${curSel} for ${vsel.length?"selected":"ALL"} products?\n\nPrice numbers are NOT changed — only the currency label.`)) return;
    const scope=vsel.length?vendors.filter(v=>vsel.includes(v.vendor)).reduce((a,v)=>a+v.count,0):(cfg.data_source==="imported"?cat.imported:cat.total);
    const r=await aj("/api/products/set_currency",{currency:curSel,vendors:vsel});
    r.ok?toast(`Currency set to ${r.currency} on ${fmtInt(r.updated)} products`,"ok"):toast(r.error||"Failed","err");
    refreshMeta();
  };
  const commitSheet=async()=>{
    if(!admin) return toast("Admin only","err");
    if(!cat.imported) return toast("Upload a sheet first","err");
    if(!confirm(`Sync database to the sheet?\n\nThe ${fmtInt(cat.imported)} products in the sheet will be added/updated in the database. Nothing already in the database is ever removed by this.`)) return;
    toast("Syncing…");
    const r=await aj("/api/import/commit",{});
    r.ok?toast(`Synced → ${fmtInt(r.total)} in DB (${fmtInt(r.added)} added)`,"ok"):toast(r.error||"Failed","err");
    refreshMeta();
  };

  const pct=st.total_rows?Math.min(100,st.current_row/st.total_rows*100):0;
  const sourceTotal=cfg.data_source==="imported"?cat.imported:cat.total;
  const getTagClass=(status)=>{
    if(!status) return "tag tag-info";
    if(status.startsWith("Price Matched")||status==="MATCH"||status==="DONE") return "tag tag-done";
    if(status.startsWith("Fetch Error")||status==="ERR"||status==="FAIL") return "tag tag-fail";
    if(status.startsWith("Price Mismatch!")) return "tag tag-warn";
    return "tag tag-info";
  };
  const getTagLabel=(status)=>{
    if(!status) return "INFO";
    if(status.startsWith("Price Matched")) return "DONE";
    if(status.startsWith("Fetch Error")) return "FAIL";
    if(status.startsWith("Price Mismatch!")) return "WARN";
    return "INFO";
  };

  return <div style={{display:"grid",gridTemplateColumns:"290px 1fr",gap:16,height:"100%",minHeight:0}}>
    {/* ── Left sidebar ── */}
    <div style={{overflowY:"auto",display:"flex",flexDirection:"column",gap:12}}>
      {/* Source Config */}
      <div className="card" style={{padding:14}}>
        <div className="lbl" style={{marginBottom:10}}>Source Configuration</div>
        <div className="dropzone" onClick={()=>document.getElementById("pipe-fi").click()}>
          <div className="dz-icon"><Icon n="upload" s={18} c="var(--on3)"/></div>
          <div style={{fontSize:12,color:"var(--on2)",fontWeight:600}}>Drop .MBO or .JSON</div>
          <div className="lbl" style={{marginTop:4}}>MAX 50MB</div>
        </div>
        <input id="pipe-fi" type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={e=>onFile(e.target.files[0])}/>
        <div style={{fontSize:11,color:"var(--on3)",marginTop:8}}>{fmtInt(sourceTotal)} products in source</div>
        <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:12,fontWeight:600}}>{cfg.data_source==="imported"?"Sheet products":"Database products"}</div>
            <div style={{fontSize:10,color:"var(--on3)",marginTop:2}}>{cfg.data_source==="imported"?"Scrape uploaded sheet":"Scrape permanent DB"}</div>
          </div>
          <Toggle on={cfg.data_source==="imported"} onChange={on=>{
            const data_source=on?"imported":"database";
            const next={...cfg,data_source,vendors:[]};
            setCfg(next); setVsel([]); aj("/api/pipe/config",next);
          }}/>
        </div>
        <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid var(--border)"}}>
          <button className="btn btn-primary btn-sm" style={{width:"100%",justifyContent:"center"}} onClick={commitSheet} disabled={!admin||!cat.imported}>
            <Icon n="dl" s={12}/>Sync database to sheet
          </button>
          <div style={{fontSize:10,color:"var(--on3)",marginTop:6}}>Staged: <b style={{color:"var(--on)"}}>{fmtInt(cat.imported)}</b></div>
        </div>
      </div>

      {/* Designer Domain */}
      <div className="card" style={{padding:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div className="lbl">Designer Domain</div>
          <span style={{fontSize:11,color:"var(--blue)",cursor:"pointer"}} onClick={()=>setVsel([])}>clear</span>
        </div>
        <div style={{maxHeight:160,overflowY:"auto",display:"flex",flexDirection:"column",gap:2}}>
          {vendors.map(v=><label key={v.vendor} className="vendor-row">
            <input type="checkbox" checked={vsel.includes(v.vendor)} onChange={()=>{ const n=new Set(vsel); n.has(v.vendor)?n.delete(v.vendor):n.add(v.vendor); setVsel([...n]); }}/>
            <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.vendor.replace(/^www\./,"")}</span>
            <span style={{color:"var(--on3)",fontSize:11}}>{v.count}</span>
          </label>)}
        </div>
        <div style={{fontSize:11,color:"var(--on3)",marginTop:8}}>
          Scope: <b style={{color:"var(--on)"}}>{fmtInt(vsel.length?vendors.filter(v=>vsel.includes(v.vendor)).reduce((a,v)=>a+v.count,0):sourceTotal)}</b>
        </div>
        <button className="btn btn-ghost btn-sm" style={{width:"100%",justifyContent:"center",marginTop:8}}
          onClick={()=>{
            if(cfg.data_source==="imported"){ window.location="/api/export?kind=all&source=imported"; return; }
            const bq=vsel.length?`&brands=${encodeURIComponent(vsel.join(","))}`:"";
            window.location=`/api/export?kind=all${bq}`;
          }}
          title={cfg.data_source==="imported"?`Export exactly the ${fmtInt(cat.imported)} staged sheet products`:vsel.length?`Export just the ${vsel.length} selected brand(s)`:"No brands selected — this exports everything"}>
          <Icon n="dl" s={12}/>Export{cfg.data_source==="imported"?` (${fmtInt(cat.imported)} from sheet)`:vsel.length?` (${vsel.length} brand${vsel.length>1?"s":""})`:" (all brands)"}
        </button>
      </div>

      {/* Engine Settings */}
      <div className="card" style={{padding:14}}>
        <div className="lbl" style={{marginBottom:10}}>Engine Settings</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          {[["Concurrency","concurrency"],["Timeout (ms)","timeout_ms"],["Batch Size","batch_size"],["Interval (s)","rest_between"],["Threads (1-4)","threads"]].map(([l,k])=>
            <div key={k}>
              <div className="lbl" style={{marginBottom:4}}>{l}</div>
              <input type="number" className="inp mono" style={{width:"100%"}} value={cfg[k]} onChange={e=>setCfg({...cfg,[k]:+e.target.value})}/>
            </div>
          )}
        </div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderTop:"1px solid var(--border)"}}>
          <div>
            <div style={{fontSize:12,fontWeight:600}}>Safe Retry Mode</div>
            <div style={{fontSize:10,color:"var(--on3)"}}>Backoff algorithm active</div>
          </div>
          <Toggle on={cfg.safe_retry} onChange={v=>setCfg({...cfg,safe_retry:v})}/>
        </div>
        <button className="btn btn-ghost btn-sm" style={{width:"100%",justifyContent:"center",marginTop:8}} onClick={()=>{ send({}); toast("Config applied","ok"); }}>
          <Icon n="check" s={12}/>Apply Settings
        </button>
      </div>
    </div>

    {/* ── Right main ── */}
    <div style={{display:"flex",flexDirection:"column",minHeight:0,gap:10}}>
      {/* Phase banner */}
      {st.phase!=="idle"&&<div className="phase-banner">
        <Icon n="warn" s={14}/>
        <span>CURRENT PHASE: {st.message.toUpperCase()}</span>
      </div>}

      {/* Action row */}
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <button className="btn btn-primary" onClick={()=>run("fresh")} disabled={st.running||!admin} style={{minWidth:130,justifyContent:"center"}}>
          <Icon n="play" s={14}/>[Run from Start]
        </button>
        <button className="btn btn-ghost" onClick={()=>run("update")} disabled={st.running||!admin} style={{minWidth:130,justifyContent:"center"}}>
          <Icon n="refresh" s={14}/>[Check Updates]
        </button>
        <button className="btn btn-abort" onClick={()=>aj("/api/pipe/abort",{})} disabled={!st.running} style={{minWidth:100,justifyContent:"center"}}>
          <Icon n="stop" s={14}/>[Abort]
        </button>
        <div style={{display:"flex",alignItems:"center",gap:6,marginLeft:"auto"}}>
          <span className="engine-dot" style={{background:st.running?"var(--green)":"var(--on3)",...(st.running?{animation:"pulseDot 2s infinite"}:{})}}/>
          <span style={{fontSize:11,fontWeight:700,letterSpacing:".06em",color:st.running?"var(--green)":"var(--on3)"}}>ENGINE {st.running?"LIVE":"IDLE"}</span>
        </div>
      </div>

      {/* Currency + clear */}
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <span style={{fontSize:11,color:"var(--on3)"}}>Currency</span>
        <div className="pill-group">
          {["INR","USD","CAD"].map(c=><button key={c} className={`pill${curSel===c?" active":""}`} onClick={()=>setCurSel(c)}>{c}</button>)}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={setCurrency} disabled={!admin}><Icon n="check" s={12}/>Set currency</button>
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          <button className="btn btn-ghost btn-sm" onClick={clearLog}><Icon n="x" s={12}/>Clear log</button>
        </div>
      </div>

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8}}>
        <Stat k="Total Units" v={fmtInt(st.total_rows)}/>
        <Stat k="Done"        v={fmtInt(st.current_row)}/>
        <Stat k="Matched"     v={fmtInt(st.matched)}     c="var(--green)"/>
        <Stat k="Mismatch"    v={fmtInt(st.mismatch)}    c="var(--amber)"/>
        <Stat k="Errors"      v={fmtInt(st.errors)}      c="var(--red)"/>
        <Stat k="Pending"     v={fmtInt(Math.max(0,(st.total_rows||0)-(st.current_row||0)))} c="var(--blue)"/>
      </div>

      {/* Progress */}
      <div className="progress-track">
        <div className="progress-fill" style={{width:pct+"%"}}>
          {st.running&&<div className="shine" style={{position:"absolute",inset:0}}/>}
        </div>
      </div>

      {/* Console */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <span className="lbl">Stream Console</span>
          <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,background:"rgba(34,197,94,.12)",color:"var(--green)",fontWeight:700}}>WebSocket Active</span>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button className="btn btn-ghost btn-sm" onClick={()=>{const bq=vsel.length?`&brands=${encodeURIComponent(vsel.join(","))}`:""; window.location=`/api/export?kind=all${bq}`;}} title={vsel.length?`Export ${vsel.length} selected brand(s)`:"Export all brands"}><Icon n="dl" s={12}/>{vsel.length?` ${vsel.length}`:""}</button>
          <button className="btn btn-ghost btn-sm" onClick={clearLog} title="Clear"><Icon n="trash" s={12}/></button>
        </div>
      </div>
      <div ref={logRef} className="console-wrap" style={{flex:1,minHeight:0}}>
        {st.entries.map((e,i)=><div key={i} className="console-row fadeup">
          <span style={{color:"var(--on3)"}}>{e.t}</span>
          <span style={{color:"var(--blue)",fontWeight:600}}>[{(e.domain||"?").replace(/^www\./,"").toUpperCase().slice(0,11)}]</span>
          <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--on2)"}}>
            {e.url?<a href={e.url} target="_blank" rel="noopener" style={{color:"var(--blue)"}}>{trunc(e.url,48)}</a>:"Invoking engine task :: "+e.msg}
          </span>
          <span className={getTagClass(e.status)} style={{justifySelf:"end"}}>{getTagLabel(e.status)}</span>
        </div>)}
        {!st.entries.length&&<div style={{textAlign:"center",padding:"48px 0",color:"var(--on3)"}}>No log yet — Run from Start.</div>}
      </div>
    </div>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════
   ADD PRODUCTS — purely additive: manual entry or a standalone sheet.
   Never touches or removes an existing row (unlike Pipeline's sheet sync).
═══════════════════════════════════════════════════════════════ */
const ADD_COLS = ["Designer URL *","MBO URL","Platform","Custom Regex","Base Price *"];
const blankAddRow = () => ({url:"",mbo_url:"",platform:"",custom_regex:"",base_price:""});

function AddProducts({admin}) {
  const [mode,setMode]=useState("manual");
  const [rows,setRows]=useState([blankAddRow()]);
  const [preview,setPreview]=useState(null);
  const [busy,setBusy]=useState(false);

  const setCell=(i,k,v)=>setRows(rs=>rs.map((r,idx)=>idx===i?{...r,[k]:v}:r));
  const addRow=()=>setRows(rs=>[...rs,blankAddRow()]);
  const removeRow=(i)=>setRows(rs=>rs.filter((_,idx)=>idx!==i));

  const onFile=async(f)=>{
    if(!f||!admin) return;
    const fd=new FormData(); fd.append("file",f);
    toast("Reading "+f.name+"…");
    const r=await api("/api/products/add_preview",{method:"POST",body:fd});
    r.ok?setPreview(r.rows):toast(r.error||"Could not read file","err");
  };

  const submit=async(payload,after)=>{
    if(!admin) return toast("Admin only","err");
    const valid=payload.filter(r=>r.url&&!r._error&&Number(r.base_price)>0);
    if(!valid.length) return toast("Nothing valid to add — need a Designer URL and Base Price","err");
    const skipped=payload.length-valid.length;
    if(!confirm(`Add ${valid.length} new product(s) to the database?${skipped?` (${skipped} row(s) skipped — missing URL/price)`:""}\n\nThis only adds rows — nothing existing is changed or removed.`)) return;
    setBusy(true);
    const r=await aj("/api/products/add",{rows:valid});
    setBusy(false);
    r.ok?toast(`Added ${fmtInt(r.added)} product(s)${r.added<valid.length?` (${valid.length-r.added} already existed)`:""}`,"ok"):toast(r.error||"Failed","err");
    if(r.ok) after();
  };

  return <div style={{height:"100%",overflow:"auto"}}>
    <div style={{marginBottom:20}}>
      <h1 style={{fontSize:22,fontWeight:700,letterSpacing:"-.01em"}}>Add Products</h1>
      <div style={{fontSize:12,color:"var(--on2)",marginTop:3}}>Add brand-new products straight to the catalog — this never edits or removes anything already tracked.</div>
    </div>

    <div className="tab-bar" style={{marginBottom:14}}>
      <button className={`tab${mode==="manual"?" active":""}`} onClick={()=>setMode("manual")}>Type it in</button>
      <button className={`tab${mode==="upload"?" active":""}`} onClick={()=>setMode("upload")}>Upload a sheet</button>
    </div>

    {mode==="manual" && <div className="card" style={{padding:16}}>
      <table className="tbl">
        <thead><tr>{[...ADD_COLS,""].map((h,i)=><th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r,i)=><tr key={i}>
            <td><input className="inp mono" style={{width:"100%",minWidth:220}} placeholder="https://brand.com/products/..." value={r.url} onChange={e=>setCell(i,"url",e.target.value)}/></td>
            <td><input className="inp mono" style={{width:"100%",minWidth:180}} placeholder="optional" value={r.mbo_url} onChange={e=>setCell(i,"mbo_url",e.target.value)}/></td>
            <td>
              <select className="inp mono" value={r.platform} onChange={e=>setCell(i,"platform",e.target.value)}>
                <option value="">auto-detect</option>
                <option value="shopify">shopify</option>
                <option value="wordpress">wordpress</option>
                <option value="Custom">custom</option>
              </select>
            </td>
            <td><input className="inp mono" style={{width:"100%",minWidth:140}} placeholder="optional regex" value={r.custom_regex} onChange={e=>setCell(i,"custom_regex",e.target.value)}/></td>
            <td><input type="number" className="inp mono" style={{width:120}} placeholder="e.g. 45000" value={r.base_price} onChange={e=>setCell(i,"base_price",e.target.value)}/></td>
            <td>{rows.length>1&&<button onClick={()=>removeRow(i)} style={{color:"var(--red)",background:"none",border:"none",cursor:"pointer"}}><Icon n="x" s={14}/></button>}</td>
          </tr>)}
        </tbody>
      </table>
      <div style={{display:"flex",gap:8,marginTop:12}}>
        <button className="btn btn-ghost btn-sm" onClick={addRow}><Icon n="plus" s={12}/>Add row</button>
        <button className="btn btn-primary btn-sm" style={{marginLeft:"auto"}} disabled={!admin||busy}
          onClick={()=>submit(rows,()=>setRows([blankAddRow()]))}>
          <Icon n="check" s={12}/>{busy?"Adding…":"Add to database"}
        </button>
      </div>
    </div>}

    {mode==="upload" && <div className="card" style={{padding:16}}>
      {!preview ? <>
        <div className="dropzone" onClick={()=>document.getElementById("add-fi").click()}>
          <div className="dz-icon"><Icon n="upload" s={18} c="var(--on3)"/></div>
          <div style={{fontSize:12,color:"var(--on2)",fontWeight:600}}>Drop .xlsx or .csv</div>
          <div className="lbl" style={{marginTop:4}}>Columns: Designer Product URL *, MBO Product URL, Platform Type, Custom Regex, Studio East Price *</div>
        </div>
        <input id="add-fi" type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={e=>onFile(e.target.files[0])}/>
      </> : <>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:12,color:"var(--on3)"}}>{preview.length} row(s) parsed · {preview.filter(r=>r._error).length} invalid (will be skipped)</div>
          <button className="btn btn-ghost btn-sm" onClick={()=>setPreview(null)}><Icon n="x" s={12}/>Start over</button>
        </div>
        <div style={{maxHeight:420,overflow:"auto"}}>
          <table className="tbl">
            <thead><tr>{["Brand","Designer URL","Platform","Base Price",""].map((h,i)=><th key={i}>{h}</th>)}</tr></thead>
            <tbody>
              {preview.map((r,i)=><tr key={i} style={r._error?{opacity:.5}:{}}>
                <td style={{fontSize:11}}>{r.brand||"—"}</td>
                <td style={{fontSize:11}}>{trunc(r.url,50)}</td>
                <td style={{fontSize:11}}>{r.platform||"—"}</td>
                <td className="mono">{fmt(r.base_price)}</td>
                <td>{r._error?<span style={{color:"var(--red)",fontSize:11}}>{r._error}</span>:<span style={{color:"var(--green)"}}>✓</span>}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <button className="btn btn-primary btn-sm" style={{marginTop:12}} disabled={!admin||busy}
          onClick={()=>submit(preview,()=>setPreview(null))}>
          <Icon n="check" s={12}/>{busy?"Adding…":`Add ${preview.filter(r=>!r._error).length} to database`}
        </button>
      </>}
    </div>}
  </div>;
}

/* ═══════════════════════════════════════════════════════════════
   REVIEW
═══════════════════════════════════════════════════════════════ */
function Review({admin}) {
  const [tab,setTab]=useState("mismatch");
  const [items,setItems]=useState([]); const [counts,setCounts]=useState({});
  const [brands,setBrands]=useState([]); const [sel,setSel]=useState(()=>new Set());
  const [gm,setGm]=useState(0); const [convCur,setConvCur]=useState("USD"); const [fxr,setFxr]=useState({});
  const [usd,setUsd]=useState(""); const [cad,setCad]=useState("");
  const [vendor,setVendor]=useState("");
  const [pushJob,setPushJob]=useState(null);
  const [rerunning,setRerunning]=useState(()=>new Set());
  const [rerunAllBusy,setRerunAllBusy]=useState(false);
  const [rerunProgress,setRerunProgress]=useState(null);
  const convOn=convCur!=="INR";

  const load=useCallback(async()=>{
    const bList=vendor?[vendor]:brands;
    const d=await api(`/api/review/items?kind=${tab}&brands=${encodeURIComponent(bList.join(","))}`);
    setItems((d.items||[]).map(it=>({...it,_m:it.markup_pct||gm,_amt:"",_cur:(it.currency||"INR").toUpperCase()})));
    setCounts(d.counts||{}); setSel(new Set());
  },[tab,brands,vendor]);
  useEffect(()=>{ load(); },[load]);
  useEffect(()=>{ api("/api/fx").then(d=>{ if(d.rates) setFxr(d.rates); if(d.markup!=null) setGm(d.markup); setUsd(d.overrides?.USD??""); setCad(d.overrides?.CAD??""); }); },[]);

  const liveInr=(it)=>{ if(it.live_price==null) return null; const c=(it.currency||"INR").toUpperCase(); if(c==="INR") return it.live_price; return it.live_price*(fxr[c]||1); };
  const dInr=(it)=>{ const li=liveInr(it); return li!=null&&it.base_price!=null?li-it.base_price:null; };
  const targetRate=convCur==="INR"?1:(fxr[convCur]||1);
  const amtInr=(amount,currency)=>{ const n=Number(amount); if(!Number.isFinite(n)||n<=0) return null; const c=(currency||"INR").toUpperCase(); const r=(c==="INR"||c==="UNKNOWN")?1:(fxr[c]||1); return Math.round(n*r*100)/100; };
  const previewFinal=(it)=>{ const manual=amtInr(it._amt,it._cur); if(manual!=null) return roundFinal(manual/targetRate); const refInr=liveInr(it)??it.base_price; if(refInr==null) return null; return roundFinal(refInr/targetRate+Number(gm||0)); };
  const saveFx=async()=>{ const r=await aj("/api/fx/override",{usd,cad,markup:gm}); if(r.rates) setFxr(r.rates); if(r.overrides){setUsd(r.overrides.USD??"");setCad(r.overrides.CAD??"");} toast(r.ok?"Rates & markup saved":"Save failed",r.ok?"ok":"err"); };
  const decide=async(it,decision)=>{ setItems(xs=>xs.filter(x=>x.id!==it.id)); const r=await aj("/api/review/decide",{row:it.id,decision,markup_pct:gm,price_amount:it._amt,price_currency:it._cur,convert:convOn,convert_currency:convOn?convCur:""}); r.ok?toast(decision==="approved"?`Approved ${fmt(r.final_price)} ${r.push_currency||""}`:".Rejected",r.shopify&&!r.shopify.ok?"err":"ok"):toast(r.error,"err"); load(); };
  const del=async(it)=>{ if(!admin) return toast("Admin only","err"); if(!confirm(`Remove ${trunc(it.url,56)}?`)) return; setItems(xs=>xs.filter(x=>x.id!==it.id)); const r=await aj("/api/review/delete",{row:it.id}); r.ok?toast("Removed","ok"):toast(r.error||"Failed","err"); load(); };
  const setBase=async(it)=>{ if(!admin) return toast("Admin only","err"); if(it.live_price==null) return toast("No live price on this row","err");
    if(!confirm(`Set base price = ${fmt(it.live_price)} ${it._cur}${it._cur==="INR"?"":" (converted to ₹)"} and clear live price?`)) return;
    setItems(xs=>xs.filter(x=>x.id!==it.id));
    const r=await aj("/api/review/update_base",{row:it.id,currency:it._cur});
    r.ok?toast(`Base updated to ₹${fmt(r.base_price)} — live cleared`,"ok"):toast(r.error||"Failed","err"); load(); };
  const approveSel=async()=>{
    if(!sel.size) return toast("Select rows first","err");
    const rows=[...sel].map(id=>{ const it=items.find(x=>x.id===id);
      return {id, markup_pct:gm, price_amount:it._amt, price_currency:it._cur, convert:convOn, convert_currency:convOn?convCur:""}; });
    setItems(xs=>xs.filter(x=>!sel.has(x.id)));
    const r=await aj("/api/review/approve_selected",{rows});
    if(r.ok){ toast(`Approved ${r.approved}${r.job?` — pushing ${r.queued} to Shopify`:""}`,"ok"); if(r.job) setPushJob(r.job); }
    else { toast(r.error||"Failed","err"); if(r.job) setPushJob(r.job); }
    setSel(new Set()); load();
  };
  const approveAll=async()=>{ if(!confirm(`Approve ALL ${items.length} ${tab}? Prices are pushed to Shopify in batches of 10.`)) return; setItems([]); const bList=vendor?[vendor]:brands; const r=await aj("/api/review/approve_all",{markup_pct:gm,convert:convOn,convert_currency:convOn?convCur:"",kind:tab,brands:bList}); if(r.ok){ toast(`Approved ${r.approved}${r.job?` — pushing ${r.queued} to Shopify`:""}`,"ok"); if(r.job) setPushJob(r.job); } else { toast(r.error,"err"); if(r.job) setPushJob(r.job); } load(); };
  const rejectAll=async()=>{ if(!admin) return toast("Admin only","err"); if(!confirm(`Reject ALL ${items.length} ${tab}?`)) return; setItems([]); const bList=vendor?[vendor]:brands; const r=await aj("/api/review/reject_all",{kind:tab,brands:bList}); r.ok?toast(`Rejected ${r.rejected}`,"ok"):toast(r.error||"Failed","err"); load(); };
  const updateBaseAll=async()=>{ if(!admin) return toast("Admin only","err"); if(!items.length) return toast("Nothing to update","err"); if(!confirm(`Set base price = live price (currency-converted, no markup) for ALL ${items.length} ${tab} rows, then clear live?`)) return; setItems([]); const bList=vendor?[vendor]:brands; const r=await aj("/api/review/update_base_all",{kind:tab,brands:bList}); r.ok?toast(`Base updated on ${r.updated} row(s)`,"ok"):toast(r.error||"Failed","err"); load(); };
  const emailReport=async()=>{ const bList=vendor?[vendor]:brands; const scope=bList.length?`${bList.length} brand(s)`:"all brands"; if(!confirm(`Email a per-brand mismatch sheet for ${scope}?`)) return; toast("Sending…","ok"); const r=await aj("/api/alerts/email_mismatch",{brands:bList}); r.ok?toast(`Emailed ${r.count} mismatch(es) to ${r.to}`,"ok"):toast(r.error||"Email failed","err"); };
  const clear=()=>{ setBrands([]); setVendor(""); setTab("mismatch"); setSel(new Set()); };
  const rerunOne=async(it)=>{
    if(!admin) return toast("Admin only","err");
    setRerunning(s=>new Set(s).add(it.id));
    const r=await aj("/api/review/rerun",{row:it.id});
    setRerunning(s=>{ const n=new Set(s); n.delete(it.id); return n; });
    if(!r.ok) return toast(r.error||"Failed","err");
    const st=r.item?.state;
    if(st&&st!=="error"){ toast(`Recovered — ${fmt(r.item.live_price)} ${r.item.currency||""} (${st})`,"ok"); setItems(xs=>xs.filter(x=>x.id!==it.id)); }
    else { toast(`Still failing — ${r.item?.status||"error"}`,"err"); setItems(xs=>xs.map(x=>x.id===it.id?{...x,...r.item,_amt:x._amt,_cur:x._cur}:x)); }
  };
  const rerunAll=async()=>{
    if(!admin) return toast("Admin only","err");
    if(!items.length) return toast("Nothing to rerun","err");
    if(!confirm(`Re-fetch live prices for all ${items.length} error row(s)?\n\nThis runs one at a time (with a short gap between each) so no single site gets hammered with requests — it may take a while for a large batch.`)) return;
    setRerunAllBusy(true);
    const targets=[...items]; let done=0, recovered=0;
    setRerunProgress({done:0,total:targets.length});
    for(const it of targets){
      const r=await aj("/api/review/rerun",{row:it.id});
      done++;
      if(r.ok && r.item?.state && r.item.state!=="error"){ recovered++; setItems(xs=>xs.filter(x=>x.id!==it.id)); }
      setRerunProgress({done,total:targets.length});
      await new Promise(res=>setTimeout(res,1200));
    }
    setRerunAllBusy(false); setRerunProgress(null);
    toast(`Rerun complete — ${recovered}/${targets.length} recovered`,"ok");
    load();
  };
  const dismissView=async()=>{
    const bList=vendor?[vendor]:brands;
    const scope=bList.length?(bList.length===1?bList[0]:`${bList.length} vendors`):"ALL vendors";
    if(!confirm(`Hide these ${fmtInt(items.length)} ${tab} row(s) (${scope}) from the review queue for good?\n\nThe products and their prices stay exactly as they are in the database — this only stops them showing up here.`)) return;
    setItems([]);
    const r=await aj("/api/review/dismiss_view",{kind:tab,brands:bList});
    r.ok?toast(`Hid ${fmtInt(r.removed)} row(s) from this view`,"ok"):toast(r.error||"Failed","err");
    load();
  };
  const tog=(id)=>{ const n=new Set(sel); n.has(id)?n.delete(id):n.add(id); setSel(n); };
  const tabs=[["mismatch","Mismatches",counts.awaiting,"var(--amber)"],["error","Errors",counts.error_awaiting,"var(--red)"],["resolved","Resolved",counts.resolved_awaiting,"var(--green)"]];

  return <div style={{height:"100%",minHeight:0,display:"flex",flexDirection:"column"}}>
    <PageBar title="Review & Approval Queue" subtitle="Approving archives the row and pushes the final price to Shopify."
      admin={admin} vendor={vendor} onVendor={setVendor} onClear={clear} kind={tab}
      extraLeft={<>
        <button className="btn btn-ghost btn-sm" onClick={load}><Icon n="refresh" s={12}/>Refresh</button>
        <button className="btn btn-ghost btn-sm" onClick={()=>{const bList=vendor?[vendor]:brands; const bq=bList.length?`&brands=${encodeURIComponent(bList.join(","))}`:""; window.location=`/api/export?kind=${tab==="resolved"?"all":tab}${bq}`;}} title={(vendor?[vendor]:brands).length?`Export selected ${(vendor?[vendor]:brands).length} brand(s)`:"Export all brands"}><Icon n="dl" s={12}/>Export{(vendor?[vendor]:brands).length?` (${(vendor?[vendor]:brands).length})`:""}</button>
        {tab==="mismatch"&&<button className="btn btn-ghost btn-sm" onClick={emailReport} title="Email a per-brand mismatch workbook"><Icon n="mail" s={12}/>Email</button>}
      </>}
      extraRight={<>
        <button className="btn btn-primary btn-sm" onClick={approveSel} disabled={!admin}><Icon n="check" s={12}/>Approve Selected</button>
      </>}/>

    {/* Global pricing strip */}
    <div className="card" style={{padding:"12px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <span className="lbl">Global Pricing</span>
      <span style={{fontSize:12,color:"var(--on3)"}}>Markup</span>
      <input type="number" className="inp mono" style={{width:70}} value={gm} onChange={e=>setGm(e.target.value)}/>
      <span style={{fontSize:12}}>{convCur}</span>
      <div className="toolbar-sep"/>
      <span style={{fontSize:12,color:"var(--on3)"}}>USD→₹</span>
      <input type="number" step=".01" className="inp mono" style={{width:80}} placeholder={fmt(fxr.USD)} value={usd} onChange={e=>setUsd(e.target.value)}/>
      <span style={{fontSize:12,color:"var(--on3)"}}>CAD→₹</span>
      <input type="number" step=".01" className="inp mono" style={{width:80}} placeholder={fmt(fxr.CAD)} value={cad} onChange={e=>setCad(e.target.value)}/>
      <button className="btn btn-ghost btn-sm" onClick={saveFx} disabled={!admin}><Icon n="check" s={12}/>Save rates</button>
      <div className="toolbar-sep"/>
      <div className="pill-group">
        {[["INR","INR"],["USD","USD→₹"],["CAD","CAD→₹"]].map(([k,l])=><button key={k} className={`pill${convCur===k?" active":""}`} onClick={()=>setConvCur(k)}>{l}</button>)}
      </div>
      <button className="btn btn-success btn-sm" onClick={approveAll} disabled={!admin||!items.length}><Icon n="check" s={12}/>Approve all ({items.length})</button>
      <button className="btn btn-danger btn-sm" onClick={rejectAll} disabled={!admin||!items.length}><Icon n="x" s={12}/>Reject all</button>
      <button className="btn btn-ghost btn-sm" onClick={updateBaseAll} disabled={!admin||!items.length}
        title="Set base price = current live price (currency-converted, no markup) for every row below, then clear live">
        <Icon n="up" s={12}/>Update base = live (all)
      </button>
      {tab==="error" && <button className="btn btn-ghost btn-sm" onClick={rerunAll} disabled={!admin||!items.length||rerunAllBusy}
        title="Re-fetch a fresh live price for every failed row below">
        <Icon n="refresh" s={12}/>{rerunAllBusy?`Rerunning ${rerunProgress?.done??0}/${rerunProgress?.total??0}…`:"Rerun all errors"}
      </button>}
      <div className="toolbar-sep"/>
      <ClearViewBtn onClear={dismissView} title="Hide this view's rows from the review queue for good — prices/decisions are untouched"/>
    </div>

    {/* Shopify push progress (batches of 10) */}
    {pushJob&&<PushJobPanel job={pushJob} onDone={load} onClose={()=>setPushJob(null)}/>}

    {/* Tabs */}
    <div className="tab-bar" style={{marginBottom:10}}>
      {tabs.map(([k,l,n,c])=><button key={k} onClick={()=>{setTab(k);setBrands([]);}} className={`tab${tab===k?" active":""}`}>
        {l} <span className="mono" style={{color:c,marginLeft:4}}>{fmtInt(n)}</span>
      </button>)}
    </div>

    {/* Multi-brand filter */}
    <div style={{marginBottom:10,display:"flex",alignItems:"center",gap:8}}>
      <Icon n="filter" s={13} c="var(--on3)"/>
      <BrandMultiSelect value={brands} onChange={setBrands} kind={tab}/>
    </div>

    {/* Table */}
    <div className="card" style={{flex:1,minHeight:0,overflow:"auto"}}>
      <table className="tbl">
        <thead><tr>{["","Brand","Product","Base ₹","Live","≈₹","Δ₹",`Markup ${convCur}`,"Amount","Cur",`Final ${convCur}`,""].map((h,i)=><th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {items.map(it=>{ const li=liveInr(it),dl=dInr(it),up=(dl||0)>0; return <tr key={it.id}>
            <td><input type="checkbox" checked={sel.has(it.id)} onChange={()=>tog(it.id)}/></td>
            <td className="mono" style={{fontSize:11,color:"var(--on2)"}}>{(it.brand||"").replace(/^www\./,"")}</td>
            <td><a href={it.url} target="_blank" rel="noopener" style={{color:"var(--blue)"}}>{trunc(it.url,28)}</a></td>
            <td className="mono" style={{textAlign:"right"}}>{fmt(it.base_price)}</td>
            <td className="mono" style={{textAlign:"right"}}>{fmt(it.live_price)} <span style={{color:"var(--on3)",fontSize:10}}>{it.currency}</span></td>
            <td className="mono" style={{textAlign:"right"}}>{fmt(li)}</td>
            <td className="mono" style={{textAlign:"right",color:up?"var(--red)":"var(--green)"}}>{dl!=null?(up?"+":"")+fmt(dl):"—"}</td>
            <td><input type="number" className="inp mono" style={{width:60,opacity:.6,textAlign:"right"}} value={gm} readOnly/></td>
            <td><input type="number" className="inp mono" style={{width:76,textAlign:"right"}} placeholder="amount" value={it._amt} onChange={e=>setItems(xs=>xs.map(x=>x.id===it.id?{...x,_amt:e.target.value}:x))}/></td>
            <td><select className="inp mono" style={{width:70}} value={it._cur} onChange={e=>setItems(xs=>xs.map(x=>x.id===it.id?{...x,_cur:e.target.value}:x))}><option>INR</option><option>USD</option><option>CAD</option><option>EUR</option><option>GBP</option></select></td>
            <td className="mono" style={{textAlign:"right",color:"var(--green)"}}>{fmt(previewFinal(it))}</td>
            <td><div style={{display:"flex",gap:6}}>{it.decision==="approved"?<span style={{color:"var(--green)"}}>✓</span>:<>
              {tab==="error" && <button title="Re-fetch live price now" onClick={()=>rerunOne(it)} style={{color:"var(--blue)",background:"none",border:"none",cursor:rerunning.has(it.id)?"wait":"pointer"}} disabled={!admin||rerunning.has(it.id)}>
                <Icon n="refresh" s={15}/>
              </button>}
              <button title="Approve" onClick={()=>decide(it,"approved")} style={{color:"var(--green)",background:"none",border:"none",cursor:"pointer"}} disabled={!admin}><Icon n="check" s={15}/></button>
              <button title={`Update base price: live ${fmt(it.live_price)} ${it._cur} becomes the new base (uses the Cur column), live is cleared`} onClick={()=>setBase(it)} style={{color:"var(--blue)",background:"none",border:"none",cursor:"pointer"}} disabled={!admin}><Icon n="up" s={15}/></button>
              <button title="Delete" onClick={()=>del(it)} style={{color:"var(--red)",background:"none",border:"none",cursor:"pointer"}} disabled={!admin}><Icon n="x" s={15}/></button>
            </>}</div></td>
          </tr>;})}
          {!items.length&&<tr><td colSpan={12} style={{textAlign:"center",padding:"48px 0",color:"var(--on3)"}}>Nothing here.</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════
   HISTORY
═══════════════════════════════════════════════════════════════ */
function History({admin}) {
  const [d,setD]=useState({items:[],count:0,value:0,pushed:0,failed:0}); const [brand,setBrand]=useState(""); const [status,setStatus]=useState("");
  const [pushJob,setPushJob]=useState(null);
  const load=useCallback(()=>api(`/api/history?brand=${encodeURIComponent(brand)}&status=${status}`).then(setD),[brand,status]);
  useEffect(()=>{ load(); },[load]);
  const push=async(it)=>{ if(!admin) return toast("Admin only","err"); toast("Pushing…"); const r=await aj("/api/history/push",{row:it.id}); toast(r.status||"done",r.ok?"ok":"err"); load(); };
  const pushAll=async()=>{ if(!admin||!confirm("Re-push all prices not yet successfully pushed? Runs in batches of 10.")) return; const r=await aj("/api/history/push_all",{}); if(r.ok){ if(!r.queued) return toast("Nothing to push — everything is already up to date","ok"); toast(`Pushing ${fmtInt(r.queued)} in batches of 10`,"ok"); setPushJob(r.job); } else { toast(r.error||"Failed","err"); if(r.job) setPushJob(r.job); } };
  const clearView=()=>setD(x=>({...x,items:[]}));
  const clear=()=>{ setBrand(""); setStatus(""); };

  return <div style={{height:"100%",overflow:"auto"}}>
    <PageBar title="Approval History" subtitle="Approved prices archived from review."
      admin={admin} vendor={brand} onVendor={setBrand} onClear={clear}
      extraLeft={<>
        <select className="inp mono" style={{width:160}} value={status} onChange={e=>setStatus(e.target.value)}>
          <option value="">All push status</option>
          <option value="failed">Failed / 429</option>
          <option value="not_pushed">Not pushed</option>
          <option value="pushed">Pushed ✓</option>
        </select>
        <button className="btn btn-ghost btn-sm" onClick={()=>window.location="/api/history/export"}><Icon n="dl" s={12}/>Export</button>
        <button className="btn btn-primary btn-sm" onClick={pushAll} disabled={!admin}><Icon n="share" s={12}/>Retry / Push all</button>
        <ClearViewBtn onClear={clearView}/>
      </>}/>

    {pushJob&&<PushJobPanel job={pushJob} onDone={load} onClose={()=>setPushJob(null)}/>}

    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
      <Stat k="Approved"      v={fmtInt(d.count)}/>
      <Stat k="Total Value"   v={inr(d.value)} c="var(--green)"/>
      <Stat k="Pushed"        v={fmtInt(d.pushed)+"/"+fmtInt(d.count)} c="var(--blue)"/>
      <Stat k="Failed / 429"  v={fmtInt(d.failed)} c="var(--red)"/>
    </div>

    <div className="card" style={{overflow:"auto"}}>
      <table className="tbl">
        <thead><tr>{["Brand","Product","Base ₹","Final ₹","Markup","By","When","Store",""].map((h,i)=><th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {d.items.map(it=><tr key={it.id}>
            <td className="mono" style={{fontSize:11}}>{(it.brand||"").replace(/^www\./,"")}</td>
            <td><a href={it.url} target="_blank" rel="noopener" style={{color:"var(--blue)"}}>{trunc(it.url,30)}</a></td>
            <td className="mono" style={{textAlign:"right"}}>{fmt(it.base_price)}</td>
            <td className="mono" style={{textAlign:"right",color:"var(--green)"}}>{fmt(it.final_price)}</td>
            <td className="mono" style={{textAlign:"right"}}>{it.markup_pct!=null?(+it.markup_pct).toFixed(2):"—"}</td>
            <td style={{fontSize:11,color:"var(--on3)"}}>{it.approved_by||"—"}</td>
            <td className="mono" style={{fontSize:11,color:"var(--on3)"}}>{(it.approved_at||"").slice(0,16).replace("T"," ")}</td>
            <td style={{fontSize:11}}>{it.shopify_status?<span style={{color:"var(--green)"}}>{it.shopify_status.slice(0,22)}</span>:<span style={{color:"var(--on3)"}}>not pushed</span>}</td>
            <td><button onClick={()=>push(it)} style={{color:"var(--blue)",background:"none",border:"none",cursor:"pointer"}}><Icon n="share" s={15}/></button></td>
          </tr>)}
          {!d.items.length&&<tr><td colSpan={9} style={{textAlign:"center",padding:"48px 0",color:"var(--on3)"}}>No approvals yet.</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════
   ALERTS
═══════════════════════════════════════════════════════════════ */
function Alerts({admin}) {
  const [thr,setThr]=useState(15); const [dir,setDir]=useState("all"); const [brand,setBrand]=useState(""); const [d,setD]=useState({items:[],total:0,drops:0,spikes:0});
  const load=useCallback(()=>api(`/api/alerts?threshold=${thr}&direction=${dir}&brand=${encodeURIComponent(brand)}`).then(setD),[thr,dir,brand]);
  useEffect(()=>{ load(); },[load]);
  const clear=()=>{ setBrand(""); setDir("all"); setThr(15); };

  return <div style={{height:"100%",minHeight:0,display:"flex",flexDirection:"column"}}>
    <PageBar title="Price Movement Alerts" subtitle="Volatility monitoring across designer brands."
      admin={admin} vendor={brand} onVendor={setBrand} onClear={clear}
      extraLeft={<>
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <div className="lbl">Threshold %</div>
          <input type="number" className="inp mono" style={{width:80}} value={thr} onChange={e=>setThr(e.target.value)}/>
        </div>
        <div className="pill-group">
          {[["all","All"],["drop","Drops"],["spike","Spikes"]].map(([k,l])=><button key={k} className={`pill${dir===k?" active":""}`} onClick={()=>setDir(k)}>{l}</button>)}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}><Icon n="refresh" s={12}/></button>
      </>}/>

    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
      <Stat k="Alerts"    v={fmtInt(d.total)}/>
      <Stat k="Drops"     v={fmtInt(d.drops)}   c="var(--green)"/>
      <Stat k="Spikes"    v={fmtInt(d.spikes)}   c="var(--red)"/>
      <Stat k="Threshold" v={"≥"+thr+"%"}         c="var(--blue)"/>
    </div>

    <div className="card" style={{flex:1,minHeight:0,overflow:"auto"}}>
      <table className="tbl">
        <thead><tr>{["Product","Brand","Direction","Prev Price","Now","Delta","Change %","When"].map((h,i)=><th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {d.items.map((it,i)=>{ const up=it.direction==="spike",c=up?"var(--red)":"var(--green)"; return <tr key={i}>
            <td><a href={it.url} target="_blank" rel="noopener" style={{color:"var(--blue)"}}>{trunc(it.url,30)}</a></td>
            <td className="mono" style={{fontSize:11,color:"var(--on2)"}}>{(it.brand||"").replace(/^www\./,"")}</td>
            <td><span style={{display:"inline-flex",alignItems:"center",gap:4,fontWeight:700,fontSize:11,color:c}}><Icon n={up?"up":"down"} s={13} c={c}/>{up?"SPIKE":"DROP"}</span></td>
            <td className="mono" style={{textAlign:"right"}}>{fmt(it.prev)}</td>
            <td className="mono" style={{textAlign:"right"}}>{fmt(it.live_price)}</td>
            <td className="mono" style={{textAlign:"right",color:c}}>{fmt(it.abs_change)}</td>
            <td className="mono" style={{textAlign:"right",fontWeight:700,color:c}}>{it.pct>0?"+":""}{it.pct}%</td>
            <td className="mono" style={{fontSize:11,color:"var(--on3)"}}>{(it.created_at||"").slice(0,16).replace("T"," ")}</td>
          </tr>;})}
          {!d.items.length&&<tr><td colSpan={8} style={{textAlign:"center",padding:"48px 0",color:"var(--on3)"}}>No movements ≥ {thr}% — run the pipeline twice to generate history.</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════
   INTEGRATIONS
═══════════════════════════════════════════════════════════════ */
function Integrations({admin}) {
  const [cfg,setCfg]=useState({shop_domain:"",api_version:"2024-10",dry_run:true,has_token:false,price_url_source:"mbo"});
  const [token,setToken]=useState(""); const [brands,setBrands]=useState([]); const [fb,setFb]=useState(""); const [v,setV]=useState("");
  const load=()=>{ api("/api/integration").then(d=>setCfg(c=>({...c,...d}))); api("/api/integrations").then(d=>setBrands(d.brands||[])); };
  useEffect(()=>{ load(); const t=setInterval(()=>api("/api/integrations").then(d=>setBrands(d.brands||[])),8000); return()=>clearInterval(t); },[]);
  const save=async()=>{ const r=await aj("/api/integration/save",{...cfg,access_token:token}); r.ok?toast("Saved","ok"):toast("Failed","err"); setToken(""); load(); };
  const verify=async()=>{ setV("…"); const r=await aj("/api/integration/verify",{}); setV(r.status); toast(r.status,r.ok?"ok":"err"); };
  const clear=()=>{ setFb(""); };

  return <div style={{height:"100%",overflow:"auto"}}>
    <PageBar title="Integrations" subtitle="Configure store connection and sync parameters for live inventory tracking."
      admin={admin} vendor={fb} onVendor={setFb} onClear={clear}/>

    {/* Config card */}
    <div className="card" style={{padding:20,maxWidth:520,marginBottom:16}}>
      <div className="lbl" style={{marginBottom:14}}>Shopify Store</div>
      <div className="lbl" style={{marginBottom:4}}>Store domain</div>
      <input className="inp" style={{width:"100%",marginBottom:10}} placeholder="store.myshopify.com" value={cfg.shop_domain} onChange={e=>setCfg({...cfg,shop_domain:e.target.value})} disabled={!admin}/>
      <div className="lbl" style={{marginBottom:4}}>Access token {cfg.has_token&&<span style={{color:"var(--green)"}}>· saved ✓</span>}</div>
      <input className="inp" style={{width:"100%",marginBottom:10}} type="password" placeholder={cfg.has_token?"••••••••":"shpat_…"} value={token} onChange={e=>setToken(e.target.value)} disabled={!admin}/>
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span className="lbl">API version</span>
          <input className="inp mono" style={{width:100}} value={cfg.api_version} onChange={e=>setCfg({...cfg,api_version:e.target.value})} disabled={!admin}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <Toggle on={!cfg.dry_run} onChange={x=>setCfg({...cfg,dry_run:!x})}/>
          <span style={{fontSize:12,color:cfg.dry_run?"var(--amber)":"var(--green)",fontWeight:600}}>{cfg.dry_run?"Dry Run":"Live"}</span>
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 12px",borderRadius:7,background:"var(--card2)",border:"1px solid var(--border2)",marginBottom:14}}>
        <div>
          <div style={{fontSize:12,fontWeight:600}}>Shopify price-update URL</div>
          <div style={{fontSize:10,color:"var(--on3)",marginTop:2}}>{cfg.price_url_source==="mbo"?"MBO Shopify Admin URL":"Designer Product URL"}</div>
        </div>
        <Toggle on={cfg.price_url_source==="mbo"} onChange={on=>setCfg({...cfg,price_url_source:on?"mbo":"designer"})}/>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={!admin}><Icon n="check" s={12}/>Save</button>
        <button className="btn btn-ghost btn-sm" onClick={verify}><Icon n="plug" s={12}/>Verify Connection</button>
      </div>
      {v&&<div style={{fontSize:11,color:"var(--on2)",marginTop:8}}>{v}</div>}
    </div>

    {/* Brands table */}
    <div className="lbl" style={{marginBottom:8}}>Brands in catalog (live)</div>
    <div className="card" style={{overflow:"auto"}}>
      <table className="tbl">
        <thead><tr>{["Brand","Products","Mismatches"].map((h,i)=><th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {brands.filter(b=>!fb||b.brand===fb).map(b=><tr key={b.brand}>
            <td className="mono">{b.brand}</td>
            <td className="mono">{fmtInt(b.products)}</td>
            <td className="mono" style={{color:"var(--amber)"}}>{fmtInt(b.mismatches)}</td>
          </tr>)}
          {!brands.filter(b=>!fb||b.brand===fb).length&&<tr><td colSpan={3} style={{textAlign:"center",padding:"40px 0",color:"var(--on3)"}}>No brands.</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════
   SETTINGS
═══════════════════════════════════════════════════════════════ */
function Settings({me, admin}) {
  const [sessions,setSessions]=useState([]); const [users,setUsers]=useState([]);
  const owner=me.role==="owner";
  const load=()=>{ if(!owner) return; api("/api/admin/sessions").then(d=>setSessions(d.sessions||[])); api("/api/admin/users").then(d=>setUsers(d.users||[])); };
  useEffect(()=>{ load(); if(owner){ const t=setInterval(()=>api("/api/admin/sessions").then(d=>setSessions(d.sessions||[])),5000); return()=>clearInterval(t); } },[owner]);
  const setRole=async(email,role)=>{ await aj("/api/admin/users/role",{email,role}); toast("Role updated","ok"); load(); };
  const del=async(email)=>{ if(!confirm("Delete "+email+"?")) return; const r=await aj("/api/admin/users/delete",{email}); r.ok?toast("Deleted","ok"):toast(r.error,"err"); load(); };

  if(!owner) return <div className="card" style={{padding:24,maxWidth:400}}>
    <div className="lbl" style={{marginBottom:8}}>Account</div>
    <div style={{fontSize:15,fontWeight:600,marginBottom:4}}>{me.email}</div>
    <div style={{fontSize:12,color:"var(--on3)"}}>role: {me.role}</div>
  </div>;

  return <div style={{height:"100%",overflow:"auto",display:"flex",flexDirection:"column",gap:16}}>
    <div style={{marginBottom:4}}>
      <h1 style={{fontSize:22,fontWeight:700}}>Owner Console</h1>
    </div>
    <div>
      <div className="lbl" style={{marginBottom:8}}>Active Sessions ({sessions.filter(s=>s.active).length} live)</div>
      <div className="card" style={{overflow:"auto"}}>
        <table className="tbl">
          <thead><tr>{["User","Role","IP","Idle","Status"].map((h,i)=><th key={i}>{h}</th>)}</tr></thead>
          <tbody>
            {sessions.map(s=><tr key={s.sid}>
              <td>{s.email}</td><td className="mono">{s.role}</td><td className="mono" style={{fontSize:11}}>{s.ip}</td><td className="mono">{s.idle_s}s</td>
              <td><span style={{color:s.active?"var(--green)":"var(--on3)"}}>● {s.active?"live":"idle"}</span></td>
            </tr>)}
            {!sessions.length&&<tr><td colSpan={5} style={{textAlign:"center",padding:"32px 0",color:"var(--on3)"}}>No sessions.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
    <div>
      <div className="lbl" style={{marginBottom:8}}>Users</div>
      <div className="card" style={{overflow:"auto"}}>
        <table className="tbl">
          <thead><tr>{["Email","Role",""].map((h,i)=><th key={i}>{h}</th>)}</tr></thead>
          <tbody>
            {users.map(u=><tr key={u.id}>
              <td>{u.email}</td>
              <td><select className="inp mono" value={u.role} onChange={e=>setRole(u.email,e.target.value)} disabled={u.email===me.email}><option>owner</option><option>admin</option><option>viewer</option></select></td>
              <td>{u.email!==me.email&&<button onClick={()=>del(u.email)} style={{color:"var(--red)",background:"none",border:"none",cursor:"pointer"}}><Icon n="x" s={14}/></button>}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
  </div>;
}

/* ═══════════════════════════════════════════════════════════════
   SHELL
═══════════════════════════════════════════════════════════════ */
export default function App() {
  const [me,setMe]=useState(undefined); const [view,setView]=useState("pipeline"); const [meta,setMeta]=useState({counts:{},alerts:0});
  useEffect(()=>{ api("/api/me").then(d=>setMe(d&&d.email?d:null)); },[]);
  useEffect(()=>{ if(!me) return; const f=()=>{
    api("/api/meta").then(d=>d.counts&&setMeta(m=>JSON.stringify(m)===JSON.stringify(d)?m:d));
    api("/api/me").then(d=>{ if(!d||!d.email) setMe(null); else setMe(m=>m&&m.role===d.role?m:d); });
  }; f(); const t=setInterval(f,15000); return()=>clearInterval(t); },[me]);

  if(me===undefined) return <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--on3)"}}>Loading…</div>;
  if(!me) return <><Toaster/><Auth onIn={d=>setMe(d)}/></>;

  const admin=me.role==="admin"||me.role==="owner";
  const nav=[
    ["pipeline","Pipeline","pipeline"],
    ["add","Add Products","plus"],
    ["review","Review","review"],
    ["alerts","Alerts","alerts"],
    ["history","History","clock"],
    ["integrations","Integrations","plug"],
  ];

  return <div style={{display:"flex",height:"100vh",overflow:"hidden"}}>
    <Toaster/>
    {/* ── Sidebar ── */}
    <nav style={{width:200,background:"var(--surface)",borderRight:"1px solid var(--border)",display:"flex",flexDirection:"column",padding:"12px 8px",flexShrink:0}}>
      {/* Logo */}
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",marginBottom:20}}>
        <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#3b82f6,#22c55e)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>⚡</div>
        <div>
          <div style={{fontWeight:800,fontSize:14,letterSpacing:"-.02em",lineHeight:1.2}}>MBO Tracker</div>
          <div className="lbl" style={{marginTop:1}}>Terminal v2.4</div>
        </div>
      </div>

      {/* Nav items */}
      {nav.map(([k,l,ic])=><button key={k} onClick={()=>setView(k)} className={`nav-item${view===k?" active":""}`}>
        <Icon n={ic} s={16}/>
        <span>{l}</span>
        {k==="review"&&meta.counts?.awaiting>0&&
          <span className="badge" style={{marginLeft:"auto",background:"rgba(245,158,11,.15)",color:"var(--amber)"}}>{meta.counts.awaiting}</span>}
        {k==="alerts"&&meta.alerts>0&&
          <span className="badge" style={{marginLeft:"auto",background:"rgba(239,68,68,.15)",color:"var(--red)"}}>{meta.alerts}</span>}
      </button>)}

      {/* Bottom */}
      <div style={{marginTop:"auto",paddingTop:12,borderTop:"1px solid var(--border)",display:"flex",flexDirection:"column",gap:4}}>
        <button onClick={()=>setView("settings")} className={`nav-item${view==="settings"?" active":""}`}><Icon n="gear" s={16}/>Settings</button>
        <div style={{padding:"8px 10px",display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--on3)"}}>
          <span style={{width:6,height:6,borderRadius:"50%",background:"var(--green)",display:"inline-block"}}/>
          Supabase · live
        </div>
        <div style={{padding:"4px 10px",fontSize:11,color:"var(--on3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{me.email}</div>
        <button onClick={async()=>{ await api("/api/logout"); setMe(null); }} className="nav-item" style={{color:"var(--red)"}}>
          <Icon n="logout" s={16}/>Sign out
        </button>
      </div>
    </nav>

    {/* ── Main area ── */}
    <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,overflow:"hidden"}}>
      {/* Topbar */}
      <div style={{background:"var(--surface)",borderBottom:"1px solid var(--border)",padding:"10px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:11,color:"var(--on3)",fontFamily:"JetBrains Mono,monospace"}}>Search parameters…</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:12,fontWeight:600}}>{me.email}</div>
            <div className="lbl" style={{color:me.role==="owner"?"var(--green)":"var(--on3)"}}>{me.role}</div>
          </div>
          <div style={{width:30,height:30,borderRadius:"50%",background:"var(--blue)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:13}}>
            {me.email[0].toUpperCase()}
          </div>
        </div>
      </div>

      {/* Page content */}
      <div style={{flex:1,minHeight:0,padding:"20px 24px",overflow:"auto"}}>
        {view==="pipeline"    && <Pipeline    admin={admin}/>}
        {view==="add"         && <AddProducts admin={admin}/>}
        {view==="review"      && <Review      admin={admin}/>}
        {view==="history"     && <History     admin={admin}/>}
        {view==="alerts"      && <Alerts      admin={admin}/>}
        {view==="integrations"&& <Integrations admin={admin}/>}
        {view==="home"        && <Home        go={setView} admin={admin}/>}
        {view==="settings"    && <Settings    me={me} admin={admin}/>}
      </div>
    </div>
  </div>;
}