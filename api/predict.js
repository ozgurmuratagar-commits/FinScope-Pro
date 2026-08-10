const FUNDS = ["PBR", "PHE", "TLY"];

const MODEL_KEY = "v5_tefas_smoothing";
const MODEL_NAME = "FinScope Prediction Engine v5 - TEFAS Realistic Smoothing Model";

const DEFAULT_REPO_DAILY_CHANGE = Number(process.env.REPO_DAILY_CHANGE || 0.12);
const DEFAULT_CASH_DAILY_CHANGE = Number(process.env.CASH_DAILY_CHANGE || 0);
const DEFAULT_BOND_DAILY_CHANGE = Number(process.env.BOND_DAILY_CHANGE || 0.06);

const FUND_PROFILE = {
  PBR: {
    stockSensitivity: 0.72,
    residualSensitivity: 0.62,
    maxDailyMove: 1.15,
    residualStyle: "balanced_income_equity"
  },
  PHE: {
    stockSensitivity: 0.78,
    residualSensitivity: 0.68,
    maxDailyMove: 1.25,
    residualStyle: "equity_heavy"
  },
  TLY: {
    stockSensitivity: 0.66,
    residualSensitivity: 0.58,
    maxDailyMove: 1.05,
    residualStyle: "mixed_tefas"
  }
};

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 4) {
  const n = Number(v || 0);
  return Number(n.toFixed(d));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function confidenceText(v) {
  v = Number(v || 0);
  if (v >= 90) return "Çok yüksek";
  if (v >= 75) return "Yüksek";
  if (v >= 60) return "Orta";
  if (v > 0) return "Düşük";
  return "—";
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

async function supabaseRequest(method, path, key, body, extraHeaders = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...extraHeaders
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase ${method} ${path} HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function supabaseGet(path, key) {
  return supabaseRequest("GET", path, key);
}

async function fetchMarketFromSelf(req) {
  try {
    const host = req.headers.host;
    const protocol =
      req.headers["x-forwarded-proto"] ||
      (host && host.includes("localhost") ? "http" : "https");

    const url = `${protocol}://${host}/api/market?t=${Date.now()}`;

    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) throw new Error(`market HTTP ${response.status}`);

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

    if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);

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

    if (!last || !prev) throw new Error(`Yahoo fiyat eksik: ${symbol}`);

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
  const list = Array.from(symbols).slice(0, 150);

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

  const bistBlend = xu100 * 0.55 + xu030 * 0.25 + xu050 * 0.2;
  const repo = DEFAULT_REPO_DAILY_CHANGE;
  const bond = DEFAULT_BOND_DAILY_CHANGE;
  const cash = DEFAULT_CASH_DAILY_CHANGE;

  if (fundCode === "PBR") {
    return {
      change: repo * 0.48 + bistBlend * 0.22 + bond * 0.20 + cash * 0.10,
      source: "PBR residual v5: repo + fon proxy + borçlanma + nakit",
      direct: false,
      bucket: "residual"
    };
  }

  if (fundCode === "PHE") {
    return {
      change: bistBlend * 0.50 + repo * 0.30 + cash * 0.20,
      source: "PHE residual v5: hisse/fon proxy + repo + nakit",
      direct: false,
      bucket: "residual"
    };
  }

  if (fundCode === "TLY") {
    return {
      change: repo * 0.50 + bistBlend * 0.20 + bond * 0.20 + cash * 0.10,
      source: "TLY residual v5: repo + fon/gyo proxy + borçlanma + nakit",
      direct: false,
      bucket: "residual"
    };
  }

  return {
    change: repo * 0.50 + bistBlend * 0.30 + cash * 0.20,
    source: "residual v5 genel varsayım",
    direct: false,
    bucket: "residual"
  };
}

function assetChangeFromMarket(asset, marketAssets, stockMoveMap) {
  const fundCode = String(asset.fundCode || asset.fund_code || "").toUpperCase();
  const type = String(asset.asset_type || asset.assetType || "").toUpperCase();
  const symbol = normalizeSymbol(asset.symbol);

  if (symbol === "RESIDUAL") return residualChangeForFund(fundCode, marketAssets);

  if (type === "CASH" || symbol === "TRY") {
    return {
      change: DEFAULT_CASH_DAILY_CHANGE,
      source: "cash/TRY varsayımı",
      direct: true,
      bucket: "cash"
    };
  }

  if (type === "MONEY_MARKET" || type === "REPO" || symbol === "REPO") {
    return {
      change: DEFAULT_REPO_DAILY_CHANGE,
      source: "repo/para piyasası günlük varsayım",
      direct: true,
      bucket: "repo"
    };
  }

  if (type === "STOCK") {
    if (symbol === "XU100" || symbol === "XU030" || symbol === "XU050") {
      return {
        change: marketChangeForIndex(symbol, marketAssets),
        source: symbol,
        direct: true,
        bucket: "stock"
      };
    }

    if (stockMoveMap[symbol]) {
      return {
        change: num(stockMoveMap[symbol].change) || 0,
        source: stockMoveMap[symbol].source,
        direct: !!stockMoveMap[symbol].direct,
        bucket: "stock"
      };
    }

    return {
      change: marketChangeForIndex("XU100", marketAssets),
      source: "XU100 proxy - hisse eşleşmedi",
      direct: false,
      bucket: "stock"
    };
  }

  if (type === "BIST" || symbol === "XU100" || symbol === "XU030" || symbol === "XU050") {
    return {
      change: marketChangeForIndex(symbol || "XU100", marketAssets),
      source: symbol || "XU100",
      direct: true,
      bucket: "stock"
    };
  }

  if (type === "FX" || symbol === "USDTRY" || symbol === "EURTRY" || symbol === "GBPTRY") {
    return {
      change: num(marketAssets[symbol] && marketAssets[symbol].change) || 0,
      source: symbol,
      direct: true,
      bucket: "fx"
    };
  }

  if (type === "GOLD" || type === "PRECIOUS_METAL" || symbol === "XAU") {
    return {
      change: num(marketAssets.XAU && marketAssets.XAU.change) || 0,
      source: "XAU",
      direct: true,
      bucket: "commodity"
    };
  }

  if (type === "SILVER" || symbol === "XAG") {
    return {
      change: num(marketAssets.XAG && marketAssets.XAG.change) || 0,
      source: "XAG",
      direct: true,
      bucket: "commodity"
    };
  }

  if (type === "BOND" || type === "EUROBOND" || type === "DEBT") {
    return {
      change: DEFAULT_BOND_DAILY_CHANGE,
      source: "tahvil/borçlanma günlük proxy",
      direct: false,
      bucket: "bond"
    };
  }

  return {
    change: 0,
    source: "bilinmeyen varlık tipi",
    direct: false,
    bucket: "unknown"
  };
}

function smoothPredictionForFund(code, raw, bucketContributions, confidence, residualWeight) {
  const profile = FUND_PROFILE[code] || FUND_PROFILE.PBR;

  const stock = bucketContributions.stock || 0;
  const residual = bucketContributions.residual || 0;
  const repo = bucketContributions.repo || 0;
  const cash = bucketContributions.cash || 0;
  const bond = bucketContributions.bond || 0;
  const fx = bucketContributions.fx || 0;
  const commodity = bucketContributions.commodity || 0;
  const unknown = bucketContributions.unknown || 0;

  const smoothed =
    stock * profile.stockSensitivity +
    residual * profile.residualSensitivity +
    repo +
    cash +
    bond * 0.85 +
    fx * 0.75 +
    commodity * 0.75 +
    unknown * 0.50;

  const residualDrag =
    residualWeight >= 30 ? 0.92 :
    residualWeight >= 20 ? 0.95 :
    1.00;

  const confidenceDrag =
    confidence >= 90 ? 1.00 :
    confidence >= 80 ? 0.96 :
    confidence >= 70 ? 0.92 :
    0.88;

  const tefasLagFactor = 0.96;

  const adjusted = smoothed * residualDrag * confidenceDrag * tefasLagFactor;

  const capped = clamp(adjusted, -profile.maxDailyMove, profile.maxDailyMove);

  return {
    unsmoothedChange: round(raw, 4),
    smoothedChange: round(capped, 4),
    smoothingImpact: round(capped - raw, 4),
    maxDailyMove: profile.maxDailyMove,
    stockSensitivity: profile.stockSensitivity,
    residualSensitivity: profile.residualSensitivity,
    tefasLagFactor,
    residualDrag,
    confidenceDrag
  };
}

async function updateActualsFromFundPrices(key) {
  const latestRows = await supabaseGet(
    "fund_prices?select=fund_code,daily_change,price_date&fund_code=in.(PBR,PHE,TLY)&order=price_date.desc&limit=90",
    key
  ).catch(() => []);

  const latestByFund = {};

  for (const row of latestRows || []) {
    const code = String(row.fund_code || "").toUpperCase();
    if (!FUNDS.includes(code)) continue;
    if (latestByFund[code]) continue;

    latestByFund[code] = {
      priceDate: row.price_date,
      actualChange: num(row.daily_change)
    };
  }

  const pending = await supabaseGet(
    "prediction_history?select=id,fund_code,prediction_date,predicted_change,calibrated_change,actual_change&fund_code=in.(PBR,PHE,TLY)&actual_change=is.null&order=prediction_date.asc&limit=300",
    key
  ).catch(() => []);

  let updated = 0;

  for (const row of pending || []) {
    const code = String(row.fund_code || "").toUpperCase();
    const latest = latestByFund[code];

    if (!latest || latest.actualChange === null || !latest.priceDate) continue;
    if (String(latest.priceDate) <= String(row.prediction_date)) continue;

    const predicted = num(row.calibrated_change) ?? num(row.predicted_change);
    if (predicted === null) continue;

    const actual = latest.actualChange;
    const error = actual - predicted;

    await supabaseRequest(
      "PATCH",
      `prediction_history?id=eq.${row.id}`,
      key,
      {
        actual_change: round(actual, 4),
        error_change: round(error, 4),
        actual_price_date: latest.priceDate,
        updated_at: new Date().toISOString()
      },
      { Prefer: "return=minimal" }
    ).catch(() => null);

    updated++;
  }

  return {
    updated,
    latestByFund
  };
}

async function readCalibration(key) {
  const rows = await supabaseGet(
    "prediction_history?select=fund_code,error_change&fund_code=in.(PBR,PHE,TLY)&actual_change=not.is.null&order=prediction_date.desc&limit=120",
    key
  ).catch(() => []);

  const grouped = {};
  for (const code of FUNDS) grouped[code] = [];

  for (const row of rows || []) {
    const code = String(row.fund_code || "").toUpperCase();
    const err = num(row.error_change);
    if (!FUNDS.includes(code) || err === null) continue;
    if (grouped[code].length < 40) grouped[code].push(err);
  }

  const out = {};

  for (const code of FUNDS) {
    const arr = grouped[code] || [];
    const n = arr.length;

    if (!n) {
      out[code] = {
        sampleSize: 0,
        averageError: 0,
        offset: 0,
        status: "no_history"
      };
      continue;
    }

    const avg = arr.reduce((a, b) => a + b, 0) / n;
    const learningStrength = Math.min(1, n / 7);
    const offset = clamp(avg * learningStrength, -0.30, 0.30);

    out[code] = {
      sampleSize: n,
      averageError: round(avg, 4),
      offset: round(offset, 4),
      status: n >= 7 ? "active" : "warming_up"
    };
  }

  return out;
}

function buildPredictions(holdingsRows, marketJson, stockMoveMap, calibration) {
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

    let rawUnsmoothed = 0;
    let totalWeight = 0;
    let directPricedWeight = 0;
    let proxyWeight = 0;
    let positiveContribution = 0;
    let negativeContribution = 0;
    let residualWeight = 0;

    const bucketContributions = {
      stock: 0,
      residual: 0,
      repo: 0,
      cash: 0,
      bond: 0,
      fx: 0,
      commodity: 0,
      unknown: 0
    };

    const details = [];

    for (const h of holdings) {
      const weight = num(h.weight) || 0;
      totalWeight += weight;

      const move = assetChangeFromMarket(h, marketAssets, stockMoveMap);
      const change = num(move.change) || 0;
      const contribution = (weight * change) / 100;
      const bucket = move.bucket || "unknown";

      rawUnsmoothed += contribution;
      bucketContributions[bucket] = (bucketContributions[bucket] || 0) + contribution;

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
        bucket,
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
      residualWeight >= 35 ? 11 :
      residualWeight >= 30 ? 9 :
      residualWeight >= 20 ? 6 :
      residualWeight >= 10 ? 3 :
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

    const cal = calibration[code] || {
      sampleSize: 0,
      averageError: 0,
      offset: 0,
      status: "no_history"
    };

    const calibrationBonus =
      cal.sampleSize >= 12 ? 5 :
      cal.sampleSize >= 7 ? 3 :
      cal.sampleSize >= 3 ? 1 :
      0;

    const calibrationPenalty =
      cal.sampleSize === 0 ? 4 :
      cal.sampleSize < 3 ? 2 :
      0;

    const confidence = Math.min(
      97,
      Math.max(
        35,
        Math.round(
          96 -
          residualPenalty -
          coveragePenalty -
          directPenalty +
          calibrationBonus -
          calibrationPenalty +
          Math.min(details.length, 60) * 0.04
        )
      )
    );

    const smoothing = smoothPredictionForFund(
      code,
      rawUnsmoothed,
      bucketContributions,
      confidence,
      residualWeight
    );

    const rawPredicted = smoothing.smoothedChange;
    const calibrationOffset = num(cal.offset) || 0;
    const calibrated = rawPredicted + calibrationOffset;

    const volatilityBuffer =
      confidence >= 90 ? 0.18 :
      confidence >= 80 ? 0.26 :
      confidence >= 70 ? 0.38 :
      0.55;

    const rangeLow = calibrated - volatilityBuffer;
    const rangeHigh = calibrated + volatilityBuffer;

    const topPositive = details
      .filter(x => x.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 5);

    const topNegative = details
      .filter(x => x.contribution < 0)
      .sort((a, b) => a.contribution - b.contribution)
      .slice(0, 5);

    predictions[code] = {
      status: holdings.length ? "holdings_weighted_v5_tefas_smoothing" : "no_holdings",
      unsmoothedChange: round(rawUnsmoothed, 4),
      rawPredictedChange: round(rawPredicted, 4),
      smoothingImpact: round(smoothing.smoothingImpact, 4),
      calibrationOffset: round(calibrationOffset, 4),
      predictedChange: round(calibrated, 4),
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
      bucketContributions: Object.fromEntries(
        Object.entries(bucketContributions).map(([k, v]) => [k, round(v, 4)])
      ),
      smoothing,
      calibration: {
        status: cal.status,
        sampleSize: cal.sampleSize,
        averageError: cal.averageError,
        appliedOffset: round(calibrationOffset, 4)
      },
      topPositive,
      topNegative,
      methodology:
        "Holdings ağırlıklı v5: gerçek hisse fiyatı + residual dağılım + TEFAS yumuşatma + fon tipi freni + geçmiş sapma kalibrasyonu.",
      horizon: "next published daily fund return",
      details
    };
  }

  return predictions;
}

async function upsertTodayPredictions(key, predictions) {
  const predictionDate = todayIso();

  const rows = FUNDS.map(code => {
    const p = predictions[code] || {};

    return {
      fund_code: code,
      prediction_date: predictionDate,
      model: MODEL_KEY,
      model_version: MODEL_NAME,
      raw_predicted_change: p.rawPredictedChange ?? null,
      predicted_change: p.predictedChange ?? null,
      calibrated_change: p.predictedChange ?? null,
      calibration_offset: p.calibrationOffset ?? null,
      confidence: p.confidence ?? null,
      coverage: p.coverage ?? null,
      residual_weight: p.residualWeight ?? null,
      sample_size: p.calibration?.sampleSize ?? 0,
      source: "api/predict v5",
      updated_at: new Date().toISOString()
    };
  });

  await supabaseRequest(
    "POST",
    "prediction_history?on_conflict=fund_code,prediction_date,model",
    key,
    rows,
    {
      Prefer: "resolution=merge-duplicates,return=minimal"
    }
  ).catch(() => null);

  return rows.length;
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

    const actualUpdate = await updateActualsFromFundPrices(supabaseKey);
    const calibration = await readCalibration(supabaseKey);

    const holdingsRows = await supabaseGet(
      "fund_holdings?select=*&order=fund_code.asc,weight.desc",
      supabaseKey
    );

    const marketJson = await fetchMarketFromSelf(req);
    const stockMoveMap = await buildStockMoveMap(holdingsRows, marketJson.assets || {});
    const predictions = buildPredictions(holdingsRows, marketJson, stockMoveMap, calibration);

    const savedToday = await upsertTodayPredictions(supabaseKey, predictions);

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      model: MODEL_NAME,
      modelKey: MODEL_KEY,
      horizon: "next published daily fund return",
      marketSource: marketJson.version || "api/market",
      holdingsSource: "supabase.fund_holdings",
      calibrationSource: "supabase.prediction_history",
      actualUpdate,
      savedToday,
      stockPricing: {
        provider: "Yahoo Finance delayed where symbol exists",
        mappedSymbols: Object.keys(stockMoveMap).length
      },
      funds: FUNDS,
      calibration,
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
