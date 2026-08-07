const FUNDS = ["PBR", "PHE", "TLY"];

const DEFAULT_REPO_DAILY_CHANGE = Number(process.env.REPO_DAILY_CHANGE || 0.12);
const DEFAULT_CASH_DAILY_CHANGE = Number(process.env.CASH_DAILY_CHANGE || 0);
const DEFAULT_BOND_DAILY_CHANGE = Number(process.env.BOND_DAILY_CHANGE || 0.06);

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 4) {
  const n = Number(v || 0);
  return Number(n.toFixed(d));
}

function confidenceText(v) {
  v = Number(v || 0);
  if (v >= 90) return "Çok yüksek";
  if (v >= 75) return "Yüksek";
  if (v >= 60) return "Orta";
  if (v > 0) return "Düşük";
  return "—";
}

async function supabaseGet(path, key) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase GET ${path} HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Supabase JSON parse error: ${text.slice(0, 500)}`);
  }
}

async function fetchMarketFromSelf(req) {
  try {
    const host = req.headers.host;
    const protocol =
      req.headers["x-forwarded-proto"] ||
      (host && host.includes("localhost") ? "http" : "https");

    const url = `${protocol}://${host}/api/market?t=${Date.now()}`;

    const response = await fetch(url, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`market HTTP ${response.status}`);
    }

    return await response.json();
  } catch (e) {
    return {
      assets: {},
      error: String(e.message || e)
    };
  }
}

function normalizeSymbol(symbol) {
  const s = String(symbol || "").trim().toUpperCase();

  if (!s) return "";

  if (s === "XU100" || s === "BIST100" || s === "BIST 100") return "XU100";
  if (s === "XU030" || s === "BIST30" || s === "BIST 30") return "XU030";
  if (s === "XU050" || s === "BIST50" || s === "BIST 50") return "XU050";

  if (s === "TRY" || s === "CASH" || s === "TL") return "TRY";
  if (s === "REPO" || s === "MONEY_MARKET" || s === "PARA_PIYASASI") return "REPO";
  if (s === "RESIDUAL" || s === "KALAN") return "RESIDUAL";

  if (s === "USD" || s === "USDTRY") return "USDTRY";
  if (s === "EUR" || s === "EURTRY") return "EURTRY";
  if (s === "GBP" || s === "GBPTRY") return "GBPTRY";

  if (s === "GOLD" || s === "ALTIN" || s === "XAU") return "XAU";
  if (s === "SILVER" || s === "GUMUS" || s === "GÜMÜŞ" || s === "XAG") return "XAG";

  return s.replace(".IS", "");
}

function yahooSymbolForBist(symbol) {
  const s = normalizeSymbol(symbol);

  if (!s) return null;

  if (["XU100", "XU030", "XU050"].includes(s)) return null;

  if (
    ["TRY", "REPO", "RESIDUAL", "USDTRY", "EURTRY", "GBPTRY", "XAU", "XAG"].includes(s)
  ) {
    return null;
  }

  return `${s}.IS`;
}

async function yahooQuote(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=5d&interval=1d`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "FinScope/7.0",
        Accept: "application/json,*/*"
      }
    });

    if (!response.ok) {
      throw new Error(`Yahoo HTTP ${response.status}`);
    }

    const json = await response.json();
    const result = json?.chart?.result?.[0] || {};
    const meta = result.meta || {};
    const quote = result.indicators?.quote?.[0] || {};
    const closes = (quote.close || []).filter(v => typeof v === "number");

    const last = Number(
      meta.regularMarketPrice ||
      closes[closes.length - 1] ||
      meta.previousClose ||
      meta.chartPreviousClose
    );

    const prev =
      closes.length > 1
        ? Number(closes[closes.length - 2])
        : Number(meta.previousClose || meta.chartPreviousClose);

    if (!last || !prev) {
      throw new Error(`Yahoo fiyat eksik: ${symbol}`);
    }

    return {
      value: last,
      change: ((last - prev) / prev) * 100,
      source: `Yahoo Finance • ${symbol}`
    };
  } finally {
    clearTimeout(timer);
  }
}

async function buildStockMoveMap(holdingsRows, marketAssets) {
  const symbols = new Set();

  for (const row of holdingsRows || []) {
    const type = String(row.asset_type || "").toUpperCase();
    const symbol = normalizeSymbol(row.symbol);

    if (type === "STOCK") {
      const yahoo = yahooSymbolForBist(symbol);
      if (yahoo) symbols.add(yahoo);
    }
  }

  const out = {};
  const list = Array.from(symbols).slice(0, 120);

  await Promise.all(
    list.map(async yahoo => {
      const baseSymbol = yahoo.replace(".IS", "");

      try {
        const q = await yahooQuote(yahoo);

        out[baseSymbol] = {
          change: num(q.change),
          value: num(q.value),
          source: q.source,
          direct: true
        };
      } catch (e) {
        const proxy =
          marketAssets.XU100 && marketAssets.XU100.change != null
            ? num(marketAssets.XU100.change)
            : 0;

        out[baseSymbol] = {
          change: proxy,
          value: null,
          source: "XU100 proxy - hisse fiyatı alınamadı",
          direct: false,
          error: String(e.message || e)
        };
      }
    })
  );

  return out;
}

function marketChangeForIndex(symbol, marketAssets) {
  const s = normalizeSymbol(symbol);

  if (s === "XU100") return num(marketAssets.XU100 && marketAssets.XU100.change) || 0;
  if (s === "XU030") return num(marketAssets.XU030 && marketAssets.XU030.change) || 0;
  if (s === "XU050") return num(marketAssets.XU050 && marketAssets.XU050.change) || 0;

  return num(marketAssets.XU100 && marketAssets.XU100.change) || 0;
}

function residualChangeForFund(fundCode, marketAssets) {
  const xu100 = marketChangeForIndex("XU100", marketAssets);
  const xu030 = marketChangeForIndex("XU030", marketAssets);
  const xu050 = marketChangeForIndex("XU050", marketAssets);

  const bistBlend = (xu100 * 0.55) + (xu030 * 0.25) + (xu050 * 0.20);
  const repo = DEFAULT_REPO_DAILY_CHANGE;
  const bond = DEFAULT_BOND_DAILY_CHANGE;
  const cash = DEFAULT_CASH_DAILY_CHANGE;

  if (fundCode === "PBR") {
    return {
      change: (repo * 0.45) + (bistBlend * 0.25) + (bond * 0.20) + (cash * 0.10),
      source: "PBR residual v3: repo + fon proxy + borçlanma + nakit",
      direct: false
    };
  }

  if (fundCode === "PHE") {
    return {
      change: (bistBlend * 0.55) + (repo * 0.25) + (cash * 0.20),
      source: "PHE residual v3: fon/hisse proxy + repo + nakit",
      direct: false
    };
  }

  if (fundCode === "TLY") {
    return {
      change: (repo * 0.45) + (bistBlend * 0.25) + (bond * 0.20) + (cash * 0.10),
      source: "TLY residual v3: repo + fon/gyo proxy + borçlanma + nakit",
      direct: false
    };
  }

  return {
    change: (repo * 0.50) + (bistBlend * 0.30) + (cash * 0.20),
    source: "residual v3 genel varsayım",
    direct: false
  };
}

function assetChangeFromMarket(asset, marketAssets, stockMoveMap) {
  const fundCode = String(asset.fundCode || asset.fund_code || "").toUpperCase();
  const type = String(asset.asset_type || asset.assetType || "").toUpperCase();
  const symbol = normalizeSymbol(asset.symbol);

  if (symbol === "RESIDUAL") {
    return residualChangeForFund(fundCode, marketAssets);
  }

  if (type === "CASH" || symbol === "TRY") {
    return {
      change: DEFAULT_CASH_DAILY_CHANGE,
      source: "cash/TRY varsayımı",
      direct: true
    };
  }

  if (
    type === "MONEY_MARKET" ||
    type === "REPO" ||
    symbol === "REPO" ||
    symbol === "MONEY_MARKET"
  ) {
    return {
      change: DEFAULT_REPO_DAILY_CHANGE,
      source: "repo/para piyasası günlük varsayım",
      direct: true
    };
  }

  if (type === "STOCK") {
    if (symbol === "XU100" || symbol === "XU030" || symbol === "XU050") {
      return {
        change: marketChangeForIndex(symbol, marketAssets),
        source: symbol,
        direct: true
      };
    }

    if (stockMoveMap[symbol]) {
      return {
        change: num(stockMoveMap[symbol].change) || 0,
        source: stockMoveMap[symbol].source,
        direct: !!stockMoveMap[symbol].direct
      };
    }

    return {
      change: marketChangeForIndex("XU100", marketAssets),
      source: "XU100 proxy - hisse eşleşmedi",
      direct: false
    };
  }

  if (type === "BIST" || symbol === "XU100" || symbol === "XU030" || symbol === "XU050") {
    return {
      change: marketChangeForIndex(symbol || "XU100", marketAssets),
      source: symbol || "XU100",
      direct: true
    };
  }

  if (type === "FX" || symbol === "USDTRY" || symbol === "EURTRY" || symbol === "GBPTRY") {
    const key = symbol;
    return {
      change: num(marketAssets[key] && marketAssets[key].change) || 0,
      source: key,
      direct: true
    };
  }

  if (type === "GOLD" || type === "PRECIOUS_METAL" || symbol === "XAU") {
    return {
      change: num(marketAssets.XAU && marketAssets.XAU.change) || 0,
      source: "XAU",
      direct: true
    };
  }

  if (type === "SILVER" || symbol === "XAG") {
    return {
      change: num(marketAssets.XAG && marketAssets.XAG.change) || 0,
      source: "XAG",
      direct: true
    };
  }

  if (
    type === "BOND" ||
    type === "EUROBOND" ||
    type === "DEBT" ||
    type === "PRIVATE_BOND" ||
    type === "GOV_BOND"
  ) {
    return {
      change: DEFAULT_BOND_DAILY_CHANGE,
      source: "tahvil/borçlanma günlük proxy",
      direct: false
    };
  }

  return {
    change: 0,
    source: "bilinmeyen varlık tipi",
    direct: false
  };
}

function buildPredictions(holdingsRows, marketJson, stockMoveMap) {
  const marketAssets = marketJson.assets || {};
  const grouped = {};

  for (const row of holdingsRows || []) {
    const code = String(row.fund_code || "").toUpperCase();
    if (!FUNDS.includes(code)) continue;

    if (!grouped[code]) grouped[code] = [];

    grouped[code].push({
      fundCode: code,
      asset_type: row.asset_type || "",
      symbol: row.symbol || "",
      name: row.name || row.symbol || "",
      weight: num(row.weight) || 0,
      reportDate: row.report_date || "",
      source: row.source || ""
    });
  }

  const predictions = {};

  for (const code of FUNDS) {
    const holdings = grouped[code] || [];

    let predicted = 0;
    let totalWeight = 0;
    let directPricedWeight = 0;
    let proxyWeight = 0;
    let positiveContribution = 0;
    let negativeContribution = 0;
    let residualWeight = 0;

    const details = [];

    for (const h of holdings) {
      const weight = num(h.weight) || 0;
      totalWeight += weight;

      const move = assetChangeFromMarket(h, marketAssets, stockMoveMap);
      const change = num(move.change) || 0;
      const contribution = (weight * change) / 100;

      predicted += contribution;

      if (normalizeSymbol(h.symbol) === "RESIDUAL") residualWeight += weight;

      if (move.direct) directPricedWeight += weight;
      else proxyWeight += weight;

      if (contribution >= 0) positiveContribution += contribution;
      else negativeContribution += contribution;

      details.push({
        assetType: h.asset_type,
        symbol: h.symbol,
        name: h.name,
        weight: round(weight, 4),
        marketChange: round(change, 4),
        contribution: round(contribution, 4),
        pricingSource: move.source,
        directPricing: !!move.direct,
        reportDate: h.reportDate,
        source: h.source
      });
    }

    const coverage = Math.min(100, totalWeight);
    const missingWeight = Math.max(0, 100 - coverage);
    const directRatio = coverage > 0 ? directPricedWeight / coverage : 0;

    const residualPenalty =
      residualWeight >= 30 ? 10 :
      residualWeight >= 20 ? 7 :
      residualWeight >= 10 ? 4 :
      0;

    const coveragePenalty =
      coverage >= 99 ? 0 :
      coverage >= 95 ? 4 :
      coverage >= 90 ? 8 :
      15;

    const directPenalty =
      directRatio >= 0.75 ? 0 :
      directRatio >= 0.55 ? 5 :
      directRatio >= 0.35 ? 10 :
      18;

    const confidence = Math.min(
      96,
      Math.max(
        35,
        Math.round(
          96 -
          residualPenalty -
          coveragePenalty -
          directPenalty +
          Math.min(details.length, 50) * 0.05
        )
      )
    );

    const volatilityBuffer =
      confidence >= 90 ? 0.22 :
      confidence >= 80 ? 0.32 :
      confidence >= 70 ? 0.45 :
      0.65;

    const rangeLow = predicted - volatilityBuffer;
    const rangeHigh = predicted + volatilityBuffer;

    const topPositive = details
      .filter(x => x.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 5);

    const topNegative = details
      .filter(x => x.contribution < 0)
      .sort((a, b) => a.contribution - b.contribution)
      .slice(0, 5);

    predictions[code] = {
      status: holdings.length ? "holdings_weighted_v3" : "no_holdings",
      predictedChange: round(predicted, 4),
      rangeLow: round(rangeLow, 4),
      rangeHigh: round(rangeHigh, 4),
      confidence,
      confidenceText: confidenceText(confidence),
      coverage: round(coverage, 2),
      missingWeight: round(missingWeight, 2),
      residualWeight: round(residualWeight, 2),
      observations: details.length,
      directPricedWeight: round(directPricedWeight, 2),
      proxyWeight: round(proxyWeight, 2),
      positiveContribution: round(positiveContribution, 4),
      negativeContribution: round(negativeContribution, 4),
      topPositive,
      topNegative,
      methodology:
        "Holdings ağırlıklı v3: gerçek hisse fiyatı + BIST proxy + fon bazlı residual dağılımı + güven skoru.",
      horizon: "next published daily fund return",
      details
    };
  }

  return predictions;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_URL veya Supabase key eksik."
      });
    }

    const holdingsRows = await supabaseGet(
      "fund_holdings?select=*&order=fund_code.asc,weight.desc",
      supabaseKey
    );

    const marketJson = await fetchMarketFromSelf(req);
    const stockMoveMap = await buildStockMoveMap(holdingsRows, marketJson.assets || {});
    const predictions = buildPredictions(holdingsRows, marketJson, stockMoveMap);

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      model: "FinScope Holdings Weighted Prediction v3 - Residual Smart Model",
      horizon: "next published daily fund return",
      marketSource: marketJson.version || "api/market",
      holdingsSource: "supabase.fund_holdings",
      stockPricing: {
        provider: "Yahoo Finance delayed where symbol exists",
        mappedSymbols: Object.keys(stockMoveMap).length
      },
      funds: FUNDS,
      predictions,
      disclaimer:
        "Bu tahminler model bazlıdır, kesinlik içermez ve yatırım tavsiyesi değildir."
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
};
