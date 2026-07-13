async function jf(u) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 10000);

  try {
    const r = await fetch(u, {
      signal: c.signal,
      headers: {
        "User-Agent": "FinScope/6.2.1",
        "Accept": "application/json,*/*"
      }
    });

    if (!r.ok) throw Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function openRates() {
  const j = await jf("https://open.er-api.com/v6/latest/USD");
  const r = j.rates || {};

  const TRY = +r.TRY;
  const EUR = +r.EUR;
  const GBP = +r.GBP;

  if (!TRY || !EUR || !GBP) throw Error("FX eksik");

  return {
    USDTRY: TRY,
    EURTRY: TRY / EUR,
    GBPTRY: TRY / GBP,
    EURUSD: 1 / EUR,
    GBPUSD: 1 / GBP
  };
}

async function yahooQuote(symbol) {
  const j = await jf(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`
  );

  const result = j?.chart?.result?.[0] || {};
  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};
  const closes = (quote.close || []).filter(v => typeof v === "number");

  const last = +(
    meta.regularMarketPrice ||
    closes.at(-1) ||
    meta.previousClose ||
    meta.chartPreviousClose
  );

  const prev =
    closes.length > 1
      ? closes.at(-2)
      : +(meta.previousClose || meta.chartPreviousClose);

  if (!last) throw Error("Yahoo veri yok: " + symbol);

  return {
    value: last,
    change: prev ? ((last - prev) / prev) * 100 : null
  };
}

async function fxAssets() {
  const fallback = await openRates().catch(() => ({}));

  const pairs = {
    USDTRY: "USDTRY=X",
    EURTRY: "EURTRY=X",
    GBPTRY: "GBPTRY=X",
    EURUSD: "EURUSD=X",
    GBPUSD: "GBPUSD=X"
  };

  const out = {};

  await Promise.all(
    Object.entries(pairs).map(async ([key, symbol]) => {
      try {
        const q = await yahooQuote(symbol);

        out[key] = {
          value: q.value,
          change: q.change,
          status: "canlı/gecikmeli",
          source: "Yahoo Finance • " + symbol
        };
      } catch (e) {
        if (fallback[key]) {
          out[key] = {
            value: fallback[key],
            change: null,
            status: "canlı",
            source: "open.er-api.com",
            note: "Yüzde değişim alınamadı"
          };
        } else {
          out[key] = {
            value: null,
            change: null,
            status: "veri alınamadı",
            source: "FX provider",
            error: String(e.message || e)
          };
        }
      }
    })
  );

  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const assets = {};
  const set = (k, v) => (assets[k] = v);

  try {
    const fx = await fxAssets();
    Object.entries(fx).forEach(([k, v]) => set(k, v));
  } catch (e) {
    ["USDTRY", "EURTRY", "GBPTRY", "EURUSD", "GBPUSD"].forEach(k =>
      set(k, {
        value: null,
        change: null,
        status: "veri alınamadı",
        source: "FX provider",
        error: String(e.message || e)
      })
    );
  }

  const ym={DXY:"DX-Y.NYB",XAU:"GC=F",XAG:"SI=F",XU100:"XU100.IS",XU050:"XU050.IS",XU030:"XU030.IS",BTC:"BTC-USD",BRENT:"BZ=F"};

  await Promise.all(
    Object.entries(marketSymbols).map(async ([key, symbol]) => {
      try {
        const q = await yahooQuote(symbol);

        set(key, {
          value: q.value,
          change: q.change,
          status: "canlı/gecikmeli",
          source: "Yahoo Finance • " + symbol
        });
      } catch (e) {
        set(key, {
          value: null,
          change: null,
          status: "veri alınamadı",
          source: "Yahoo Finance • " + symbol,
          error: String(e.message || e)
        });
      }
    })
  );

  res.status(200).json({
    version: "FinScope Professional v6.2.1 FX Percentage Fix",
    updatedAt: new Date().toISOString(),
    assets
  });
};
