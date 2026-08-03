
const FUNDS=["PBR","PHE","TLY"], ENDPOINT="https://www.tefas.gov.tr/api/funds/fonFiyatBilgiGetir";
function num(v){if(v==null||v==="")return null;let t=String(v).trim();t=t.includes(",")&&t.includes(".")?t.replace(/\./g,"").replace(",","."):t.replace(",",".");const n=Number(t);return Number.isFinite(n)?n:null}
function iso(v){if(!v)return null;const t=String(v),a=t.match(/^(\d{4})-(\d{2})-(\d{2})/),b=t.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/),c=t.match(/\/Date\((\d+)\)\//);if(a)return `${a[1]}-${a[2]}-${a[3]}`;if(b)return `${b[3]}-${b[2]}-${b[1]}`;if(c)return new Date(Number(c[1])).toISOString().slice(0,10);const d=new Date(v);return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10)}
function field(o,n){for(const k of n)if(Object.prototype.hasOwnProperty.call(o,k))return o[k];return null}
async function get(code){
  const r=await fetch(ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json",Origin:"https://www.tefas.gov.tr",Referer:`https://www.tefas.gov.tr/tr/fon-detayli-analiz/${code}`,"User-Agent":"Mozilla/5.0 FinScope/1.0"},body:JSON.stringify({fonKodu:code,dil:"TR",periyod:13})});
  const t=await r.text();if(!r.ok)throw new Error(`TEFAS ${code} ${r.status}: ${t.slice(0,300)}`);const p=JSON.parse(t),rows=Array.isArray(p)?p:Array.isArray(p.resultList)?p.resultList:Array.isArray(p.data)?p.data:[];
  const x=rows.map(o=>({date:iso(field(o,["tarih","Tarih","TARIH","date","Date"])),price:num(field(o,["fiyat","Fiyat","FIYAT","price","Price"]))})).filter(o=>o.date&&o.price!=null).sort((a,b)=>a.date.localeCompare(b.date));
  if(x.length<2)throw new Error(`TEFAS ${code}: yeterli tarihsel veri yok`);return x;
}
async function put(url,key,row){
  const table=`${url}/rest/v1/fund_prices`,h={apikey:key,"Content-Type":"application/json",Accept:"application/json"};
  let r=await fetch(`${table}?fund_code=eq.${row.fund_code}&price_date=eq.${row.price_date}`,{method:"DELETE",headers:h});if(!r.ok)throw new Error(await r.text());
  r=await fetch(table,{method:"POST",headers:{...h,Prefer:"return=minimal"},body:JSON.stringify(row)});if(!r.ok)throw new Error(await r.text());
}
module.exports=async function(req,res){
  res.setHeader("Cache-Control","no-store");
  const s=process.env.CRON_SECRET;if(!s||req.headers.authorization!==`Bearer ${s}`)return res.status(401).json({ok:false,error:"Yetkisiz istek."});
  const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SECRET_KEY;if(!url||!key)return res.status(500).json({ok:false,error:"Supabase değişkenleri eksik"});
  const results=[];
  for(const f of FUNDS){try{const h=await get(f);for(let i=0;i<h.length;i++){const c=h[i],p=i?h[i-1]:null;await put(url,key,{fund_code:f,price:c.price,daily_change:p?((c.price-p.price)/p.price)*100:null,price_date:c.date,portfolio_size:null,investor_count:null,source:"TEFAS v2 history"})}results.push({fund:f,ok:true,inserted:h.length})}catch(e){results.push({fund:f,ok:false,error:String(e.message||e)})}}
  const n=results.filter(x=>x.ok).length;return res.status(n?200:502).json({ok:n===FUNDS.length,updatedFunds:n,results,timestamp:new Date().toISOString()});
};
