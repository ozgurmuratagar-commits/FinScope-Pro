// api/predict.js
// FinScope Predict API v10.2 - Causal NAV Core Weight Engine
// Purpose:
// - Keep the existing /api/predict endpoint.
// - Add a true Causal NAV calculation based on fund holdings, holding weights, and current market moves.
// - Do not create a new Vercel function.
// - report=1 returns diagnostics only and does not write predictions.

const API_VERSION = "FinScope Predict API v10.2 - Causal NAV Core Weight Engine";
const MODEL_KEY = "v7_1_accuracy_layer";
const MODEL_VERSION = "FinScope Prediction Engine v10.2 - Causal NAV Core Weight Engine";
const FUNDS = ["PBR", "PHE", "TLY", "THF"];
const TARGET_ABSOLUTE_ERROR = 0.1;

const MAX_YAHOO_BATCH_SIZE = 45;
const YAHOO_TIMEOUT_MS = 6500;
const CHART_FALLBACK_LIMIT = 24;

function json(res, status, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.status(status).send(JSON.stringify(payload));
}

function getQuery(req) {
  const url = new URL(req.url || "/api/predict", "https://finscope.local");
  return url.searchParams;
}

function isManualAuthorized(req) {
  const q = getQuery(req);
  const manual = q.get("manual");
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  const cronSecret = process.env.CRON_SECRET || process.env.FINSCOPE_CRON_SECRET || "";
  if (manual === "finscope") return true;
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  return false;
}

function n(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const cleaned = String(value).trim().replace("%", "").replace(/\./g, "").replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const p = Math.pow(10, digits);
  return Math.round(Number(value) * p) / p;
}

function clamp(value, min, max) {
  const x = Number(value);
  if (!Number.isFinite(x)) return 0;
  return Math.max(min, Math.min(max, x));
}

function abs(value) {
  const x = Number(value);
  return Number.isFinite(x) ? Math.abs(x) : 0;
}

function direction(value) {
  const x = Number(value);
  if (!Number.isFinite(x) || Math.abs(x) < 0.0001) return "flat";
  return x > 0 ? "up" : "down";
}

function confidenceText(score) {
  const s = Number(score) || 0;
  if (s >= 80) return "Yuksek";
  if (s >= 62) return "Orta";
  if (s >= 45) return "Dusuk";
  return "Cok dusuk";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return null;
  const a = new Date(`${dateA}T00:00:00Z`).getTime();
  const b = new Date(`${dateB}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function unique(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(path, options = {}) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) {
    throw new Error("Supabase environment variables are missing");
  }
  const endpoint = `${cfg.url}/rest/v1/${path}`;
  const headers = {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  const response = await fetch(endpoint, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  if (!response.ok) {
    const err = new Error(`Supabase ${options.method || "GET"} ${path} HTTP ${response.status}: ${text}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

function inFilter(values) {
  return `in.(${values.map(v => encodeURIComponent(v)).join(",")})`;
}

async function readFundPrices() {
  const path = `fund_prices?select=*&fund_code=${inFilter(FUNDS)}&order=price_date.desc&limit=1000`;
  const rows = await supabase(path);
  const byFund = {};
  const historyByFund = {};
  for (const row of rows || []) {
    const code = String(row.fund_code || row.fundCode || "").toUpperCase();
    if (!FUNDS.includes(code)) continue;
    if (!historyByFund[code]) historyByFund[code] = [];
    historyByFund[code].push(row);
    if (!byFund[code]) byFund[code] = row;
  }
  return { rows: rows || [], byFund, historyByFund };
}

async function readHoldings() {
  const path = `fund_holdings?select=*&fund_code=${inFilter(FUNDS)}&order=report_date.desc&limit=6000`;
  const rows = await supabase(path);
  const latestDateByFund = {};
  for (const row of rows || []) {
    const code = String(row.fund_code || row.fundCode || "").toUpperCase();
    if (!FUNDS.includes(code)) continue;
    const d = String(row.report_date || row.reportDate || row.date || "").slice(0, 10);
    if (!d) continue;
    if (!latestDateByFund[code] || d > latestDateByFund[code]) latestDateByFund[code] = d;
  }
  const latestRows = (rows || []).filter(row => {
    const code = String(row.fund_code || row.fundCode || "").toUpperCase();
    const d = String(row.report_date || row.reportDate || row.date || "").slice(0, 10);
    return FUNDS.includes(code) && d && d === latestDateByFund[code];
  });
  const byFund = {};
  for (const code of FUNDS) byFund[code] = [];
  for (const row of latestRows) {
    const code = String(row.fund_code || row.fundCode || "").toUpperCase();
    byFund[code].push(row);
  }
  return { rows: rows || [], latestRows, byFund, latestDateByFund };
}

async function readLearningStats() {
  try {
    const path = `model_learning_stats?select=*&fund_code=${inFilter(FUNDS)}&model=eq.${encodeURIComponent(MODEL_KEY)}&limit=100`;
    const rows = await supabase(path);
    const byFund = {};
    for (const row of rows || []) {
      const code = String(row.fund_code || row.fundCode || "").toUpperCase();
      if (FUNDS.includes(code)) byFund[code] = row;
    }
    return { rows: rows || [], byFund, ok: true };
  } catch (err) {
    return { rows: [], byFund: {}, ok: false, error: String(err.message || err) };
  }
}

function normalizeAssetType(row) {
  const raw = String(row.asset_type || row.assetType || row.type || row.asset_class || row.assetClass || "").toLowerCase();
  const symbol = String(row.symbol || row.asset_symbol || row.assetSymbol || row.code || row.holding_code || row.holdingCode || "").toUpperCase();
  const name = String(row.name || row.asset_name || row.assetName || row.title || "").toUpperCase();
  const joined = `${raw} ${symbol} ${name}`;
  if (/cash|nakit|repo|mevduat|vadeli|teminat|bpp|para piyasasi|money/.test(joined)) return "cash";
  if (/bond|tahvil|bono|fixed|kira|sukuk|trt|hazine/.test(joined)) return "fixed_income";
  if (/fund|fon|yatirim fonu|byf|etf/.test(joined)) return "fund";
  if (/stock|equity|hisse|pay|borsa/.test(joined)) return "stock";
  if (symbol && /^[A-Z]{2,6}(\.IS)?$/.test(symbol)) return "stock";
  return raw || "unknown";
}

function normalizeSymbol(row) {
  const candidates = [
    row.symbol,
    row.asset_symbol,
    row.assetSymbol,
    row.code,
    row.holding_code,
    row.holdingCode,
    row.ticker
  ];
  let s = "";
  for (const c of candidates) {
    if (c !== null && c !== undefined && String(c).trim()) {
      s = String(c).trim().toUpperCase();
      break;
    }
  }
  s = s.replace(".IST", ".IS").replace("BIST:", "").replace("TRY:", "");
  s = s.replace(/[^A-Z0-9.]/g, "");
  if (!s) return null;
  return s;
}

function toYahooSymbol(symbol) {
  if (!symbol) return null;
  const s = String(symbol).toUpperCase().replace(".IST", ".IS");
  if (s.endsWith(".IS")) return s;
  if (/^[A-Z]{2,6}$/.test(s)) return `${s}.IS`;
  return null;
}

function normalizeHolding(row) {
  const fundCode = String(row.fund_code || row.fundCode || "").toUpperCase();
  const symbol = normalizeSymbol(row);
  const name = String(row.name || row.asset_name || row.assetName || row.title || symbol || "").trim();
  const assetType = normalizeAssetType(row);
  const weight = n(
    row.effective_weight ?? row.effectiveWeight ?? row.weight ?? row.ratio ?? row.rate ?? row.percentage ?? row.portfolio_weight ?? row.portfolioWeight ?? row.share,
    0
  );
  const reportDate = String(row.report_date || row.reportDate || row.date || "").slice(0, 10) || null;
  const yahooSymbol = assetType === "stock" ? toYahooSymbol(symbol) : null;
  return { fundCode, symbol, yahooSymbol, name, assetType, weight: Number(weight) || 0, reportDate, raw: row };
}

function normalizeWeights(holdings) {
  const positive = holdings.filter(h => h.weight > 0);
  const total = positive.reduce((sum, h) => sum + h.weight, 0);
  const shouldNormalize = total > 0 && (total < 80 || total > 120);
  return holdings.map(h => ({
    ...h,
    originalWeight: round(h.weight, 6),
    effectiveWeight: shouldNormalize && total > 0 ? round((h.weight / total) * 100, 6) : round(h.weight, 6),
    normalized: shouldNormalize
  }));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = YAHOO_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 FinScope/10.2",
        Accept: "application/json,text/plain,*/*",
        ...(options.headers || {})
      }
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahooQuoteBatch(symbols) {
  const result = {};
  const chunks = chunk(unique(symbols), MAX_YAHOO_BATCH_SIZE);
  await Promise.allSettled(chunks.map(async part => {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(part.join(","))}`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) return;
    const data = await response.json();
    const quotes = (((data || {}).quoteResponse || {}).result || []);
    for (const q of quotes) {
      const symbol = String(q.symbol || "").toUpperCase();
      const price = n(q.regularMarketPrice, null);
      const previous = n(q.regularMarketPreviousClose ?? q.regularMarketOpen, null);
      let change = n(q.regularMarketChangePercent, null);
      if (change === null && price !== null && previous !== null && previous !== 0) {
        change = ((price - previous) / previous) * 100;
      }
      if (symbol && price !== null && change !== null) {
        result[symbol] = {
          symbol,
          price: round(price, 6),
          previous: previous === null ? null : round(previous, 6),
          marketChange: round(change, 6),
          pricingSource: "Yahoo quote",
          directPricing: true,
          issue: null
        };
      }
    }
  }));
  return result;
}

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return null;
  const data = await response.json();
  const chart = (((data || {}).chart || {}).result || [])[0];
  if (!chart) return null;
  const quote = (((chart.indicators || {}).quote || [])[0]) || {};
  const closes = (quote.close || []).filter(v => Number.isFinite(Number(v)));
  if (closes.length < 2) return null;
  const price = Number(closes[closes.length - 1]);
  const previous = Number(closes[closes.length - 2]);
  if (!Number.isFinite(price) || !Number.isFinite(previous) || previous === 0) return null;
  const change = ((price - previous) / previous) * 100;
  return {
    symbol,
    price: round(price, 6),
    previous: round(previous, 6),
    marketChange: round(change, 6),
    pricingSource: "Yahoo chart",
    directPricing: true,
    issue: null
  };
}

async function fetchMarketPrices(yahooSymbols) {
  const symbols = unique(yahooSymbols);
  const bySymbol = await fetchYahooQuoteBatch(symbols);
  const missing = symbols.filter(s => !bySymbol[s]).slice(0, CHART_FALLBACK_LIMIT);
  const fallbackResults = await Promise.allSettled(missing.map(fetchYahooChart));
  for (const item of fallbackResults) {
    if (item.status === "fulfilled" && item.value && item.value.symbol) {
      bySymbol[item.value.symbol] = item.value;
    }
  }
  for (const s of symbols) {
    if (!bySymbol[s]) {
      bySymbol[s] = {
        symbol: s,
        price: null,
        previous: null,
        marketChange: null,
        pricingSource: "not_priced",
        directPricing: false,
        issue: "not_priced"
      };
    }
  }
  return bySymbol;
}

function computeFreshness(reportDate) {
  const days = daysBetween(reportDate, todayISO());
  if (days === null) return { days: null, status: "unknown", penalty: 12 };
  if (days <= 20) return { days, status: "fresh", penalty: 0 };
  if (days <= 45) return { days, status: "watch", penalty: 6 };
  return { days, status: "stale", penalty: 14 };
}

function grade(absError) {
  const e = abs(absError);
  if (e <= 0.25) return "Hedefte";
  if (e <= 0.75) return "Cok iyi";
  if (e <= 1.25) return "Iyi";
  if (e <= 2.5) return "Zayif";
  return "Sok";
}

function estimateErrorBand(coverage, residualWeight, shockScore, freshnessPenalty, stats) {
  const base = 0.35;
  const residual = clamp(residualWeight, 0, 100) * 0.018;
  const coveragePenalty = (100 - clamp(coverage, 0, 100)) * 0.008;
  const shock = shockScore >= 2 ? 0.45 : shockScore === 1 ? 0.2 : 0;
  const freshness = freshnessPenalty * 0.025;
  const learning = n(stats && stats.average_absolute_error, null);
  const learningPart = learning === null ? 0.25 : clamp(learning * 0.25, 0, 1.25);
  return round(clamp(base + residual + coveragePenalty + shock + freshness + learningPart, 0.35, 4.5), 4);
}

function computeLearningOffset(stats, coverage) {
  if (!stats) return 0;
  const sample = n(stats.completed_prediction_count ?? stats.sample_size, 0) || 0;
  const avgError = n(stats.average_error, 0) || 0;
  if (sample < 4) return 0;
  const multiplier = coverage >= 70 ? 0.18 : coverage >= 45 ? 0.12 : 0.08;
  return round(clamp(avgError * multiplier, -1.25, 1.25), 4);
}

function buildFundPrediction({ fundCode, holdingRows, latestPrice, pricesHistory, learningStats, marketBySymbol }) {
  const normalized = normalizeWeights(holdingRows.map(normalizeHolding));
  const reportDate = normalized.find(h => h.reportDate)?.reportDate || null;
  const freshness = computeFreshness(reportDate);

  let totalWeight = 0;
  let stockWeight = 0;
  let pricedWeight = 0;
  let nonStockWeight = 0;
  let unresolvedWeight = 0;
  let causalRaw = 0;
  let pricedRows = 0;
  let unresolvedRows = 0;
  const pricedHoldings = [];
  const unresolvedHoldings = [];
  const nonStockHoldings = [];

  for (const h of normalized) {
    const w = Number(h.effectiveWeight) || 0;
    if (w <= 0) continue;
    totalWeight += w;
    if (h.assetType !== "stock") {
      nonStockWeight += w;
      nonStockHoldings.push({
        symbol: h.symbol,
        name: h.name,
        assetType: h.assetType,
        weight: round(w, 4),
        contribution: 0,
        issue: "non_stock"
      });
      continue;
    }
    stockWeight += w;
    const m = h.yahooSymbol ? marketBySymbol[h.yahooSymbol] : null;
    if (m && m.marketChange !== null && Number.isFinite(Number(m.marketChange))) {
      const contribution = (w / 100) * Number(m.marketChange);
      causalRaw += contribution;
      pricedWeight += w;
      pricedRows += 1;
      pricedHoldings.push({
        symbol: h.symbol,
        yahooSymbol: h.yahooSymbol,
        name: h.name,
        assetType: h.assetType,
        weight: round(w, 4),
        marketChange: round(m.marketChange, 4),
        price: m.price,
        previous: m.previous,
        contribution: round(contribution, 4),
        pricingSource: m.pricingSource,
        directPricing: true
      });
    } else {
      unresolvedWeight += w;
      unresolvedRows += 1;
      unresolvedHoldings.push({
        symbol: h.symbol,
        yahooSymbol: h.yahooSymbol,
        name: h.name,
        assetType: h.assetType,
        weight: round(w, 4),
        contribution: 0,
        issue: h.yahooSymbol ? "not_priced" : "not_stock_or_unresolved"
      });
    }
  }

  const coverage = round(clamp(pricedWeight, 0, 100), 4);
  const residualWeight = round(clamp(100 - coverage, 0, 100), 4);
  const latestFundActual = n(latestPrice && latestPrice.daily_change, null);
  const recentActuals = (pricesHistory || []).slice(0, 5).map(r => n(r.daily_change, null)).filter(v => v !== null);
  const recentAvg = recentActuals.length ? recentActuals.reduce((s, v) => s + v, 0) / recentActuals.length : 0;

  const topPositive = pricedHoldings.slice().sort((a, b) => (b.contribution || 0) - (a.contribution || 0)).slice(0, 8);
  const topNegative = pricedHoldings.slice().sort((a, b) => (a.contribution || 0) - (b.contribution || 0)).slice(0, 8);

  const largeNegativeContribs = topNegative.filter(h => h.contribution <= -0.35).length;
  const largePositiveContribs = topPositive.filter(h => h.contribution >= 0.35).length;
  const shockScore = (abs(causalRaw) >= 3 ? 1 : 0) + (abs(causalRaw) >= 6 ? 1 : 0) + Math.min(2, largeNegativeContribs + largePositiveContribs);

  const coverageRatio = coverage / 100;
  const causalWeight = coverage >= 75 ? 1 : coverage >= 55 ? 0.88 : coverage >= 35 ? 0.7 : 0.48;
  const residualFallback = clamp((1 - coverageRatio) * clamp(recentAvg, -3, 3) * 0.18, -0.75, 0.75);
  const learningOffset = computeLearningOffset(learningStats, coverage);

  const causalWeighted = causalRaw * causalWeight;
  const shockAmplifier = abs(causalRaw) >= 8 ? 1.0 : abs(causalRaw) >= 4 ? 0.95 : 0.88;
  const finalPrediction = clamp((causalWeighted * shockAmplifier) + residualFallback + learningOffset, -20, 20);

  const expectedErrorBand = estimateErrorBand(coverage, residualWeight, shockScore, freshness.penalty, learningStats);
  const confidence = round(clamp(32 + coverage * 0.55 + Math.min(pricedRows, 35) * 0.55 - freshness.penalty - Math.min(unresolvedRows, 25) * 0.45 - (shockScore >= 2 ? 8 : 0), 8, 92), 2);

  const rangeLow = round(finalPrediction - expectedErrorBand, 4);
  const rangeHigh = round(finalPrediction + expectedErrorBand, 4);
  const predDirection = direction(finalPrediction);

  const issues = [];
  if (!holdingRows.length) issues.push("no_holdings");
  if (coverage < 35) issues.push("low_priced_weight_coverage");
  if (freshness.status === "stale") issues.push("stale_holdings_report");
  if (unresolvedRows > 0) issues.push("unpriced_or_unresolved_holdings");
  if (shockScore >= 2) issues.push("strong_weighted_market_move");

  const prediction = {
    fundCode,
    code: fundCode,
    fund: fundCode,
    predictionDate: todayISO(),
    model: MODEL_KEY,
    modelKey: MODEL_KEY,
    modelVersion: MODEL_VERSION,
    source: "causal_nav_core_weight_engine",
    targetAbsoluteError: TARGET_ABSOLUTE_ERROR,

    rawPredictedChange: round(causalRaw, 4),
    predictedChange: round(finalPrediction, 4),
    calibratedChange: round(finalPrediction, 4),
    finalPredictionChange: round(finalPrediction, 4),
    currentPredictionChange: round(finalPrediction, 4),
    predictionDirection: predDirection,
    rangeLow,
    rangeHigh,
    expectedErrorBand,
    confidence,
    confidenceText: confidenceText(confidence),

    coverage,
    residualWeight,
    totalWeight: round(totalWeight, 4),
    stockWeight: round(stockWeight, 4),
    pricedWeight: round(pricedWeight, 4),
    nonStockWeight: round(nonStockWeight, 4),
    unresolvedWeight: round(unresolvedWeight, 4),
    sampleSize: pricedRows,
    unresolvedRows,
    totalHoldingRows: holdingRows.length,
    holdingsReportDate: reportDate,
    holdingsFreshnessDays: freshness.days,
    holdingsFreshnessStatus: freshness.status,

    causalRawChange: round(causalRaw, 4),
    causalWeightedChange: round(causalWeighted, 4),
    residualFallback: round(residualFallback, 4),
    calibrationOffset: round(learningOffset, 4),
    shockScore,
    latestFundActualChange: latestFundActual === null ? null : round(latestFundActual, 4),
    recentFundAverageChange: round(recentAvg, 4),
    issues,
    learningStrength: learningStats ? n(learningStats.completed_prediction_count ?? learningStats.sample_size, 0) : 0,
    note: `v10.2 Causal NAV Core: weighted holdings contribution is primary signal; coverage=${round(coverage, 2)}; freshness=${freshness.status}`,

    topPositiveContributors: topPositive,
    topNegativeContributors: topNegative,
    unresolvedHoldings: unresolvedHoldings.slice(0, 60),
    nonStockHoldings: nonStockHoldings.slice(0, 60)
  };

  const dbRow = {
    fund_code: fundCode,
    prediction_date: todayISO(),
    model: MODEL_KEY,
    model_version: MODEL_VERSION,
    raw_predicted_change: round(causalRaw, 6),
    calibrated_change: round(finalPrediction, 6),
    prediction_direction: predDirection,
    range_low: rangeLow,
    range_high: rangeHigh,
    expected_error_band: expectedErrorBand,
    confidence,
    coverage,
    residual_weight: residualWeight,
    sample_size: pricedRows,
    calibration_offset: round(learningOffset, 6),
    actual_change: null,
    error_change: null,
    note: prediction.note,
    updated_at: new Date().toISOString()
  };

  return { prediction, dbRow };
}

async function savePredictionRows(rows) {
  if (!rows.length) return { ok: true, saved: 0, rows: [] };
  const path = `prediction_history?on_conflict=fund_code,prediction_date,model`;
  const saved = await supabase(path, {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify(rows)
  });
  return { ok: true, saved: Array.isArray(saved) ? saved.length : rows.length, rows: saved || [] };
}

async function runEngine({ write = false, reportOnly = false } = {}) {
  const [fundPrices, holdings, learning] = await Promise.all([
    readFundPrices(),
    readHoldings(),
    readLearningStats()
  ]);

  const latestHoldingRowsByFund = {};
  const allYahooSymbols = [];
  for (const fund of FUNDS) {
    const rows = holdings.byFund[fund] || [];
    latestHoldingRowsByFund[fund] = rows;
    const normalized = rows.map(normalizeHolding);
    for (const h of normalized) {
      if (h.assetType === "stock" && h.yahooSymbol) allYahooSymbols.push(h.yahooSymbol);
    }
  }

  const marketBySymbol = await fetchMarketPrices(allYahooSymbols);

  const predictions = {};
  const predictionRows = [];
  const dbRows = [];
  const fundReports = {};

  for (const fund of FUNDS) {
    const built = buildFundPrediction({
      fundCode: fund,
      holdingRows: latestHoldingRowsByFund[fund] || [],
      latestPrice: fundPrices.byFund[fund] || null,
      pricesHistory: fundPrices.historyByFund[fund] || [],
      learningStats: learning.byFund[fund] || null,
      marketBySymbol
    });
    predictions[fund] = built.prediction;
    predictionRows.push(built.prediction);
    dbRows.push(built.dbRow);
    fundReports[fund] = {
      fundCode: fund,
      holdingsReportDate: built.prediction.holdingsReportDate,
      holdingsFreshnessDays: built.prediction.holdingsFreshnessDays,
      holdingsFreshnessStatus: built.prediction.holdingsFreshnessStatus,
      totalHoldingRows: built.prediction.totalHoldingRows,
      sampleSize: built.prediction.sampleSize,
      coverage: built.prediction.coverage,
      residualWeight: built.prediction.residualWeight,
      stockWeight: built.prediction.stockWeight,
      nonStockWeight: built.prediction.nonStockWeight,
      unresolvedWeight: built.prediction.unresolvedWeight,
      causalRawChange: built.prediction.causalRawChange,
      finalPredictionChange: built.prediction.finalPredictionChange,
      confidence: built.prediction.confidence,
      confidenceText: built.prediction.confidenceText,
      issues: built.prediction.issues,
      topPositiveContributors: built.prediction.topPositiveContributors,
      topNegativeContributors: built.prediction.topNegativeContributors,
      unresolvedHoldings: built.prediction.unresolvedHoldings
    };
  }

  let saveResult = { ok: true, saved: 0, rows: [] };
  if (write && !reportOnly) {
    saveResult = await savePredictionRows(dbRows);
  }

  const pricedRows = predictionRows.reduce((s, p) => s + (p.sampleSize || 0), 0);
  const totalHoldingRows = predictionRows.reduce((s, p) => s + (p.totalHoldingRows || 0), 0);
  const avgCoverage = predictionRows.length ? predictionRows.reduce((s, p) => s + (p.coverage || 0), 0) / predictionRows.length : 0;
  const strongestSignals = predictionRows
    .map(p => ({ fundCode: p.fundCode, finalPredictionChange: p.finalPredictionChange, causalRawChange: p.causalRawChange, coverage: p.coverage, confidence: p.confidence }))
    .sort((a, b) => abs(b.finalPredictionChange) - abs(a.finalPredictionChange));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    version: API_VERSION,
    mode: reportOnly ? "embedded_causal_nav_report" : "causal_nav_prediction",
    endpoint: reportOnly ? "/api/predict?manual=finscope&report=1" : "/api/predict",
    model: MODEL_KEY,
    modelKey: MODEL_KEY,
    modelVersion: MODEL_VERSION,
    fundOrder: FUNDS,
    thfIncluded: true,
    targetAbsoluteError: TARGET_ABSOLUTE_ERROR,
    writeEnabled: write && !reportOnly,
    saved: saveResult.saved,
    summary: {
      totalFunds: FUNDS.length,
      totalHoldingRows,
      pricedRows,
      averageCoverage: round(avgCoverage, 4),
      strongestSignals,
      rule: "Prediction is mainly weighted holdings market change. If coverage is low, residual fallback and learning offset are limited."
    },
    predictions,
    rows: predictionRows,
    causalNavReport: fundReports,
    marketCoverage: {
      requestedSymbols: unique(allYahooSymbols).length,
      pricedSymbols: Object.values(marketBySymbol).filter(x => x && x.directPricing).length,
      unresolvedSymbols: Object.values(marketBySymbol).filter(x => !x || !x.directPricing).length
    },
    learningStats: {
      ok: learning.ok,
      rows: learning.rows.length,
      error: learning.error || null
    },
    saveResult: reportOnly ? undefined : saveResult,
    disclaimer: "These model outputs are estimates only and are not investment advice."
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return json(res, 405, { ok: false, version: API_VERSION, error: "Method not allowed" });
    }

    const q = getQuery(req);
    const reportOnly = q.get("report") === "1" || q.get("report") === "true";
    const dryRun = q.get("dryRun") === "1" || q.get("dry") === "1";
    const manual = isManualAuthorized(req);
    const write = manual && !reportOnly && !dryRun;

    const result = await runEngine({ write, reportOnly });
    result.authorization = {
      manualAuthorized: manual,
      writeAttempted: write,
      reportOnly,
      dryRun
    };

    return json(res, 200, result);
  } catch (err) {
    return json(res, 500, {
      ok: false,
      version: API_VERSION,
      model: MODEL_KEY,
      modelVersion: MODEL_VERSION,
      error: String(err && err.message ? err.message : err),
      stack: process.env.NODE_ENV === "development" ? String(err && err.stack ? err.stack : "") : undefined
    });
  }
};
