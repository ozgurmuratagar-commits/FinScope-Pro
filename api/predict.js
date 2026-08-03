
const FUNDS = ["PBR","PHE","TLY"];
const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
function std(a){if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));}
async function history(url,key,code){
  const r=await fetch(`${url}/rest/v1/fund_prices?select=price,daily_change,price_date&fund_code=eq.${code}&order=price_date.desc&limit=20`,{headers:{apikey:key,Accept:"application/json"}});
  const t=await r.text(); if(!r.ok) throw new Error(t); return JSON.parse(t);
}
function predict(rows){
  const v=rows.filter(x=>Number.isFinite(Number(x.daily_change))).map(x=>Number(x.daily_change));
  if(v.length<3)return {status:"insufficient_history",observations:v.length,predictedChange:null,confidence:20};
  const r=v.slice(0,Math.min(7,v.length)), w=r.map((_,i)=>r.length-i);
  const wm=r.reduce((s,x,i)=>s+x*w[i],0)/w.reduce((a,b)=>a+b,0);
  const vol=std(r), shrink=Math.max(.35,Math.min(.75,1-vol/5)), p=wm*shrink, u=Math.max(.2,vol*.85);
  return {status:"preliminary",predictedChange:+p.toFixed(4),rangeLow:+(p-u).toFixed(4),rangeHigh:+(p+u).toFixed(4),confidence:Math.round(Math.max(25,Math.min(82,78-vol*10+Math.min(v.length,10)))),observations:v.length,methodology:"7 günlük ağırlıklı momentum + volatilite küçültmesi"};
}
module.exports=async function(req,res){
  res.setHeader("Cache-Control","no-store");
  const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_ANON_KEY;
  if(!url||!key)return res.status(500).json({ok:false,error:"Supabase değişkenleri eksik"});
  const predictions={};
  for(const f of FUNDS){try{predictions[f]=predict(await history(url,key,f));}catch(e){predictions[f]={status:"error",error:String(e.message||e)}}}
  return res.status(200).json({ok:true,generatedAt:new Date().toISOString(),model:"FinScope Preliminary Momentum v1",horizon:"next published daily fund return",predictions,disclaimer:"Ön tahmindir; yatırım tavsiyesi değildir."});
};
