async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "FinScope/6.4",
        "Accept": "application/json,*/*"
      }
    });

    if (!response.ok) throw new Error("HTTP " + response.status);

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function openRates() {
  const data = await fetchJson("https://open.er-api.com/v6/latest/USD");
  const r = data.rates || {};

  const TRY = Number(r.TRY);
  const EUR = Number(r.EUR);
  const GBP = Number(r.GBP);

  if (!TRY || !EUR || !GBP) throw new Error("FX eksik");

  return {
    USDTRY: TRY,
    EURTRY: TRY / EUR,
    GBPTRY: TRY / GBP,
    EURUSD: 1 / EUR,
    GBPUSD: 1 / GBP
  };
}

async function yahooQuote(symbol) {
  const data = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`
  );

  const result = data?.chart?.result?.[0] || {};
  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};
  const closes = (quote.close || []).filter(
    v => typeof v === "number" && Number.isFinite(v)
  );

  const last = Number(
    meta.regularMarketPrice ||
      closes[closes.length - 1] ||
      meta.previousClose ||
      meta.chartPreviousClose
  );

  const prev =
    closes.length > 1
      ? closes[closes.length - 2]
      : Number(meta.previousClose || meta.chartPreviousClose);

  if (!last) throw new Error("Yahoo veri yok: " + symbol);

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
  const set = (key, value) => {
    assets[key] = value;
  };

  try {
    const fx = await fxAssets();
    Object.entries(fx).forEach(([key, value]) => set(key, value));
  } catch (e) {
    ["USDTRY", "EURTRY", "GBPTRY", "EURUSD", "GBPUSD"].forEach(key =>
      set(key, {
        value: null,
        change: null,
        status: "veri alınamadı",
        source: "FX provider",
        error: String(e.message || e)
      })
    );
  }

  const marketSymbols = {
    DXY: "DX-Y.NYB",
    XAU: "GC=F",
    XAG: "SI=F",
    XU100: "XU100.IS",
    XU050: "XU050.IS",
    XU030: "XU030.IS",
    BTC: "BTC-USD",
    BRENT: "BZ=F"
  };

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
    version: "FinScope Professional v6.4 Market Data + DXY Fix",
    updatedAt: new Date().toISOString(),
    assets
  });
};
