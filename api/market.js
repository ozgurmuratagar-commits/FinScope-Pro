const FUNDS = ["PBR","PHE","TLY"];

async function jfetch(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), options.timeout || 12000);
  try {
    const r = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 FinScope/5.2.1",
        "Accept": "application/json,*/*",
        ...(options.headers || {})
      }
    });
    const text = await r.text();
    if (!r.ok) throw new Error("HTTP " + r.status + " " + text.slice(0, 120));
    try { return JSON.parse(text); } catch(e) { throw new Error("JSON parse: " + text.slice(0, 120)); }
  } finally { clearTimeout(t); }
}

async function fx(){
  const j = await jfetch("https://open.er-api.com/v6/latest/USD");
  const r = j.rates || {};
  const TRY=+r.TRY, EUR=+r.EUR, GBP=+r.GBP;
  if(!TRY||!EUR||!GBP) throw new Error("FX eksik");
  return {USDTRY:TRY, EURTRY:TRY/EUR, GBPTRY:TRY/GBP, EURUSD:1/EUR, GBPUSD:1/GBP};
}

async function yahoo(s){
  const j = await jfetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=5d&interval=1d`);
  const res=j?.chart?.result?.[0]||{}, m=res.meta||{}, q=res.indicators?.quote?.[0]||{};
  const closes=(q.close||[]).filter(v=>typeof v==="number");
  const last=+(m.regularMarketPrice||closes.at(-1)||m.previousClose||m.chartPreviousClose);
  const prev=closes.length>1?closes.at(-2):+(m.previousClose||m.chartPreviousClose);
  if(!last) throw new Error("Yahoo veri yok");
  return {value:last, change:prev?((last-prev)/prev)*100:0};
}

function normalizeFund(code, payload) {
  const f = payload?.fund || payload || {};
  const value = Number(f.current_price ?? f.price ?? f.nav ?? f.value);
  const ret = Number(f.return_1d ?? f.daily_return ?? f.change ?? 0);
  return {
    value: Number.isFinite(value) ? value : null,
    change: Number.isFinite(ret) ? ret * 100 : null,
    date: f.current_date || f.date || f.last_seen || "",
    fundName: f.name || code,
    riskScore: f.risk_score ?? null,
    aum: f.aum ?? null,
    investorCount: f.investor_count ?? null,
    managementCompany: f.management_company || "",
    status: Number.isFinite(value) ? "gerçek veri" : "veri alınamadı",
    source: "Fonoloji / TEFAS",
    provider: "fonoloji"
  };
}

function normalizeHoldings(payload) {
  const raw = payload?.holdings || payload?.positions || payload?.items || payload?.data || [];
  if (!Array.isArray(raw)) return [];
  return raw.map(x => ({
    stock: String(x.ticker || x.symbol || x.code || x.asset_code || x.name || "").toUpperCase(),
    name: x.name || x.asset_name || "",
    weight: Number(x.weight ?? x.ratio ?? x.percentage ?? x.portfolio_weight ?? 0),
    change: Number(x.daily_return ?? x.return_1d ?? x.change ?? 0) * (Math.abs(Number(x.daily_return ?? x.return_1d ?? x.change ?? 0)) < 1 ? 100 : 1),
    source: "Fonoloji"
  })).filter(x => x.stock && Number.isFinite(x.weight)).slice(0, 20);
}

async function fonolojiFund(code, key) {
  const headers = {"X-API-Key": key};
  const fund = await jfetch(`https://fonoloji.com/v1/funds/${code}`, {headers});
  let holdings = [];
  try {
    const h = await jfetch(`https://fonoloji.com/v1/funds/${code}/holdings`, {headers});
    holdings = normalizeHoldings(h);
  } catch(e) {
    try {
      const h2 = await jfetch(`https://fonoloji.com/v1/funds/${code}/holdings-data`, {headers});
      holdings = normalizeHoldings(h2);
    } catch(_) {}
  }
  return {...normalizeFund(code, fund), holdings};
}

module.exports = async function(req, res) {
  res.setHeader("Cache-Control","no-store");
  res.setHeader("Access-Control-Allow-Origin","*");

  const assets = {};
  const diagnostics = { provider: "fonoloji", keyPresent: Boolean(process.env.FONOLOJI_KEY), funds: {} };
  const set=(k,v)=>assets[k]=v;

  try { const f=await fx(); Object.entries(f).forEach(([k,v])=>set(k,{value:v,change:0,status:"canlı",source:"open.er-api.com",provider:"market"})); }
  catch(e){ ["USDTRY","EURTRY","GBPTRY","EURUSD","GBPUSD"].forEach(k=>set(k,{value:null,change:null,status:"veri alınamadı",source:"open.er-api.com",provider:"market",error:String(e.message||e)})); }

  const ym={XAU:"GC=F",XAG:"SI=F",XU100:"XU100.IS",XU050:"XU050.IS",XU030:"XU030.IS",BTC:"BTC-USD",BRENT:"BZ=F"};
  await Promise.all(Object.entries(ym).map(async([k,s])=>{
    try { set(k,{...(await yahoo(s)),status:"canlı/gecikmeli",source:"Yahoo Finance • "+s,provider:"market"}); }
    catch(e){ set(k,{value:null,change:null,status:"veri alınamadı",source:"Yahoo Finance • "+s,provider:"market",error:String(e.message||e)}); }
  }));

  const key = process.env.FONOLOJI_KEY || "";
  if (!key) {
    FUNDS.forEach(code => {
      set(code,{value:null,change:null,status:"API anahtarı bekliyor",source:"Fonoloji / TEFAS",provider:"fonoloji"});
      diagnostics.funds[code] = {ok:false, error:"FONOLOJI_KEY environment variable missing"};
    });
  } else {
    await Promise.all(FUNDS.map(async code => {
      try {
        const f = await fonolojiFund(code, key);
        set(code, f);
        diagnostics.funds[code] = {ok:true, date:f.date, holdings:f.holdings?.length || 0};
      } catch(e) {
        set(code,{value:null,change:null,status:"gerçek veri alınamadı",source:"Fonoloji / TEFAS",provider:"fonoloji",error:String(e.message||e)});
        diagnostics.funds[code] = {ok:false, error:String(e.message||e).slice(0,220)};
      }
    }));
  }

  res.status(200).json({version:"FinScope Professional v5.2.1 Real Fund Provider",updatedAt:new Date().toISOString(),assets,diagnostics});
};