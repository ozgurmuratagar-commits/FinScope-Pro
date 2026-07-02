const DAY_MS = 24 * 60 * 60 * 1000;

function ddmmyyyy(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}.${m}.${y}`;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 9000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 FinScope/3.1",
        "Accept": "application/json,text/plain,*/*",
        ...(options.headers || {})
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getFx() {
  const j = await fetchJson("https://open.er-api.com/v6/latest/USD", { timeout: 8000 });
  const r = j.rates || {};
  const TRY = Number(r.TRY);
  const EUR = Number(r.EUR);
  const GBP = Number(r.GBP);
  if (!TRY || !EUR || !GBP) throw new Error("FX rates missing");
  return {
    USDTRY: TRY,
    EURTRY: TRY / EUR,
    GBPTRY: TRY / GBP,
    EURUSD: 1 / EUR,
    GBPUSD: 1 / GBP,
    source: "open.er-api.com",
    status: "canlı"
  };
}

async function yahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const j = await fetchJson(url, { timeout: 9000 });
  const result = j?.chart?.result?.[0];
  const meta = result?.meta || {};
  const price =
    Number(meta.regularMarketPrice) ||
    Number(meta.previousClose) ||
    Number(meta.chartPreviousClose);
  if (!price) throw new Error(`Yahoo price missing for ${symbol}`);
  return {
    value: price,
    source: "Yahoo Finance",
    status: "canlı/gecikmeli"
  };
}

async function tefasFund(code) {
  const today = new Date();
  const start = new Date(Date.now() - 10 * DAY_MS);
  const body = new URLSearchParams({
    fontip: "YAT",
    fonkod: code,
    bastarih: ddmmyyyy(start),
    bittarih: ddmmyyyy(today)
  });

  const j = await fetchJson("https://www.tefas.gov.tr/api/DB/BindHistoryInfo", {
    method: "POST",
    timeout: 10000,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Origin": "https://www.tefas.gov.tr",
      "Referer": `https://www.tefas.gov.tr/FonAnaliz.aspx?FonKod=${code}`
    },
    body
  });

  const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
  if (!arr.length) throw new Error(`TEFAS data missing for ${code}`);
  const last = arr[arr.length - 1];
  const prev = arr.length > 1 ? arr[arr.length - 2] : null;
  const price = Number(String(last.FIYAT || last.Fiyat || last.fiyat || "").replace(",", "."));
  const prevPrice = prev ? Number(String(prev.FIYAT || prev.Fiyat || prev.fiyat || "").replace(",", ".")) : null;
  if (!price) throw new Error(`TEFAS price parse failed for ${code}`);
  return {
    value: price,
    change: prevPrice ? ((price - prevPrice) / prevPrice) * 100 : 0,
    date: last.TARIH || last.Tarih || last.tarih || "",
    source: "TEFAS",
    status: "canlı/gecikmeli"
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const now = new Date();
  const out = {
    version: "Professional v3.1",
    updatedAt: now.toISOString(),
    assets: {}
  };

  try {
    const fx = await getFx();
    for (const k of ["USDTRY","EURTRY","GBPTRY","EURUSD","GBPUSD"]) {
      out.assets[k] = { value: fx[k], change: 0, status: fx.status, source: fx.source };
    }
  } catch (e) {
    for (const k of ["USDTRY","EURTRY","GBPTRY","EURUSD","GBPUSD"]) {
      out.assets[k] = { value: null, change: null, status: "veri alınamadı", source: "open.er-api.com", error: String(e.message || e) };
    }
  }

  const yahooMap = {
    XAU: "GC=F",
    XAG: "SI=F",
    XU100: "XU100.IS",
    XU050: "XU050.IS",
    XU030: "XU030.IS"
  };

  await Promise.all(Object.entries(yahooMap).map(async ([key, symbol]) => {
    try {
      const q = await yahooQuote(symbol);
      out.assets[key] = { value: q.value, change: 0, status: q.status, source: `${q.source} • ${symbol}` };
    } catch (e) {
      out.assets[key] = { value: null, change: null, status: "veri alınamadı", source: `Yahoo Finance • ${symbol}`, error: String(e.message || e) };
    }
  }));

  const funds = ["PBR","PHE","TLY","TZL","IIF","IRV","UZY"];
  await Promise.all(funds.map(async (code) => {
    try {
      const f = await tefasFund(code);
      out.assets[code] = { value: f.value, change: f.change, status: f.status, source: f.source, date: f.date };
    } catch (e) {
      out.assets[code] = { value: null, change: null, status: "veri alınamadı", source: "TEFAS", error: String(e.message || e) };
    }
  }));

  res.status(200).json(out);
};
