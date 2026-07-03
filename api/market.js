
function dmy(d){return String(d.getDate()).padStart(2,"0")+"."+String(d.getMonth()+1).padStart(2,"0")+"."+d.getFullYear();}
function n(x){if(x==null)return null; if(typeof x==="number")return Number.isFinite(x)?x:null; const y=Number(String(x).replace(/\./g,"").replace(",",".").replace(/[^\d.-]/g,"")); return Number.isFinite(y)?y:null;}
async function jfetch(url,opt={}){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),opt.timeout||12000);
  try{
    const r=await fetch(url,{...opt,signal:c.signal,headers:{"User-Agent":"Mozilla/5.0 FinScope/4.2","Accept":"application/json,text/plain,*/*",...(opt.headers||{})}});
    const text=await r.text();
    if(!r.ok) throw new Error("HTTP "+r.status+" "+text.slice(0,80));
    try{return JSON.parse(text)}catch(e){throw new Error("JSON parse hatası: "+text.slice(0,80))}
  } finally { clearTimeout(t); }
}
async function fx(){const j=await jfetch("https://open.er-api.com/v6/latest/USD");const r=j.rates||{};const TRY=Number(r.TRY),EUR=Number(r.EUR),GBP=Number(r.GBP);if(!TRY||!EUR||!GBP)throw new Error("FX eksik");return {USDTRY:TRY,EURTRY:TRY/EUR,GBPTRY:TRY/GBP,EURUSD:1/EUR,GBPUSD:1/GBP};}
async function yahoo(s){const j=await jfetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=5d&interval=1d`);const res=j?.chart?.result?.[0]||{};const m=res.meta||{};const q=res.indicators?.quote?.[0]||{};const closes=(q.close||[]).filter(v=>typeof v==="number");const last=Number(m.regularMarketPrice||closes.at(-1)||m.previousClose||m.chartPreviousClose);const prev=closes.length>1?closes.at(-2):Number(m.previousClose||m.chartPreviousClose);if(!last)throw new Error("Yahoo veri yok");return {value:last,change:prev?((last-prev)/prev)*100:0};}
async function tefas(code){
  const today=new Date(), start=new Date(Date.now()-20*86400000);
  const body=new URLSearchParams({fontip:"YAT",fonkod:code,bastarih:dmy(start),bittarih:dmy(today)});
  const started=Date.now();
  const j=await jfetch("https://www.tefas.gov.tr/api/DB/BindHistoryInfo",{
    method:"POST",timeout:14000,
    headers:{
      "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
      "Origin":"https://www.tefas.gov.tr",
      "Referer":`https://www.tefas.gov.tr/FonAnaliz.aspx?FonKod=${code}`,
      "X-Requested-With":"XMLHttpRequest"
    },body
  });
  const rows=Array.isArray(j?.data)?j.data:(Array.isArray(j)?j:[]);
  if(!rows.length) throw new Error("TEFAS boş sonuç");
  const sorted=rows.slice().sort((a,b)=>String(a.TARIH||a.Tarih||"").localeCompare(String(b.TARIH||b.Tarih||"")));
  const last=sorted.at(-1), prev=sorted.at(-2);
  const price=n(last.FIYAT??last.Fiyat??last.fiyat), pp=prev?n(prev.FIYAT??prev.Fiyat??prev.fiyat):null;
  if(!price) throw new Error("TEFAS fiyat okunamadı");
  return {value:price,change:pp?((price-pp)/pp)*100:0,date:String(last.TARIH??last.Tarih??""),latencyMs:Date.now()-started,history:sorted.slice(-10).map(r=>({date:String(r.TARIH??r.Tarih??""),value:n(r.FIYAT??r.Fiyat??r.fiyat)})).filter(x=>x.value)};
}
module.exports=async function(req,res){
  res.setHeader("Cache-Control","no-store, max-age=0");res.setHeader("Access-Control-Allow-Origin","*");
  const assets={}, diagnostics={tefas:{}}; const set=(k,v)=>assets[k]=v;
  try{const f=await fx();Object.entries(f).forEach(([k,v])=>set(k,{value:v,change:0,status:"canlı",source:"open.er-api.com"}));}catch(e){["USDTRY","EURTRY","GBPTRY","EURUSD","GBPUSD"].forEach(k=>set(k,{value:null,change:null,status:"veri alınamadı",source:"open.er-api.com",error:String(e.message||e)}));}
  const ym={XAU:"GC=F",XAG:"SI=F",XU100:"XU100.IS",XU050:"XU050.IS",XU030:"XU030.IS",BTC:"BTC-USD",BRENT:"BZ=F"};
  await Promise.all(Object.entries(ym).map(async([k,s])=>{try{const q=await yahoo(s);set(k,{...q,status:"canlı/gecikmeli",source:"Yahoo Finance • "+s});}catch(e){set(k,{value:null,change:null,status:"veri alınamadı",source:"Yahoo Finance • "+s,error:String(e.message||e)});}}));
  await Promise.all(["PBR","PHE","TLY","TZL","IIF","IRV","UZY"].map(async code=>{
    try{const f=await tefas(code);set(code,{...f,status:"canlı/gecikmeli",source:"TEFAS"});diagnostics.tefas[code]={ok:true,latencyMs:f.latencyMs,date:f.date};}
    catch(e){set(code,{value:null,change:null,status:"TEFAS erişim yok",source:"TEFAS",error:String(e.message||e)});diagnostics.tefas[code]={ok:false,error:String(e.message||e).slice(0,180)};}
  }));
  res.status(200).json({version:"FinScope Professional v4.2.0 TEFAS Diagnostic",updatedAt:new Date().toISOString(),assets,diagnostics});
}
