const FUNDS = ["PBR", "PHE", "TLY", "THF"];
const VERSION = "FinScope Predict API v10.5 - NAV Shock Brake Layer";
const MODEL = "v7_1_accuracy_layer";
const MODEL_KEY = "v7_1_accuracy_layer";
const MODEL_VERSION = "FinScope Prediction Engine v10.5 - NAV Shock Brake Layer";
const ENGINE_SOURCE = "causal_nav_shock_brake_v10_5";
const TARGET_ABSOLUTE_ERROR = 0.1;
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

function sendJson(res, status, body) {
  setCors(res);
  res.status(status).json(body);
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;

  let text = String(value).trim().replace(/%/g, "").replace(/\s+/g, "");
  if (!text) return fallback;

  const hasComma = text.includes(",");
  const hasDot = text.includes(".");

  if (hasComma && hasDot) {
    text = text.replace(/\./g, "").replace(/,/g, ".");
  } else if (hasComma) {
    text = text.replace(/,/g, ".");
  }

  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = toNumber(value);
  if (n === null) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function clamp(value, min, max) {
  const n = toNumber(value, 0);
  return Math.min(max, Math.max(min, n));
}

function abs(value) {
  return Math.abs(toNumber(value, 0));
}

function average(values) {
  const nums = values.map((x) => toNumber(x)).filter((x) => x !== null);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(values) {
  const nums = values
    .map((x) => toNumber(x))
    .filter((x) => x !== null)
    .sort((a, b) => a - b);

  if (!nums.length) return null;

  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function direction(value) {
  const n = toNumber(value, 0);
  if (n > 0.03) return "up";
  if (n < -0.03) return "down";
  return "flat";
}

function sameDirection(a, b) {
  const da = direction(a);
  const db = direction(b);
  return da !== "flat" && db !== "flat" && da === db;
}

function confidenceText(value) {
  const n = toNumber(value, 0);
  if (n >= 80) return "Yuksek";
  if (n >= 60) return "Orta";
  if (n >= 40) return "Dusuk";
  return "Cok dusuk";
}

function isoDateTR(offsetDays = 0) {
  const d = new Date(Date.now() + ISTANBUL_OFFSET_MS + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextBusinessDate(dateText) {
  let d = addDays(dateText, 1);

  for (let i = 0; i < 6; i += 1) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) return d;
    d = addDays(d, 1);
  }

  return d;
}

function dayDiff(fromDate, toDate) {
  if (!fromDate || !toDate) return null;

  const a = new Date(`${fromDate}T00:00:00Z`).getTime();
  const b = new Date(`${toDate}T00:00:00Z`).getTime();

  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL veya SUPABASE key eksik");
  }

  return { url: url.replace(/\/$/, ""), key };
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = getSupabaseConfig();
  const method = options.method || "GET";

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: options.body
  });

  const text = await response.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Supabase ${method} ${path} HTTP ${response.status}: ${text}`);
  }

  return data;
}

function normalizeFundCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeAssetType(value) {
  return String(value || "stock").trim().toLowerCase();
}

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/İ/g, "I")
    .replace(/Ş/g, "S")
    .replace(/Ğ/g, "G")
    .replace(/Ü/g, "U")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C");
}

function normalizeHolding(row) {
  const fundCode = normalizeFundCode(
    row.fund_code || row.fundCode || row.fund || row.fon || row.code
  );

  const assetType = normalizeAssetType(
    row.asset_type || row.assetType || row.type || row.asset_class || row.varlik_tipi
  );

  const rawSymbol =
    row.symbol ||
    row.ticker ||
    row.asset_code ||
    row.yahoo_symbol ||
    row.yahooSymbol ||
    row.code ||
    row.name;

  const symbol = normalizeSymbol(rawSymbol);
  const yahooSymbol = normalizeSymbol(row.yahoo_symbol || row.yahooSymbol || "");
  const name = String(row.name || row.asset_name || row.title || row.varlik_adi || symbol || "").trim();

  const weight = toNumber(
    row.weight ??
      row.weight_pct ??
      row.ratio ??
      row.percentage ??
      row.allocation ??
      row.pay ??
      row.oran,
    0
  );

  const reportDate =
    String(
      row.report_date ||
        row.reportDate ||
        row.portfolio_date ||
        row.portfolioDate ||
        row.date ||
        ""
    ).slice(0, 10) || null;

  return {
    fundCode,
    assetType,
    symbol,
    yahooSymbol,
    name,
    weight,
    reportDate,
    raw: row
  };
}

function isStockHolding(holding) {
  const type = holding.assetType;
  const symbol = holding.symbol;

  if (!symbol || holding.weight <= 0) return false;

  if (type.includes("hisse") || type.includes("stock") || type.includes("equity")) return true;
  if (type.includes("cash") || type.includes("nakit") || type.includes("repo")) return false;
  if (type.includes("bond") || type.includes("tahvil") || type.includes("bono")) return false;
  if (type.includes("fixed") || type.includes("kira") || type.includes("sertifika")) return false;
  if (type.includes("fund") || type.includes("fon")) return false;
  if (type.includes("deposit") || type.includes("mevduat")) return false;

  if (/^(TR|TRY|USD|EUR|GBP|PP|PRY|PKZ|PCS|BPP|VIOP|FON)/.test(symbol)) return false;

  return /^[A-Z0-9]{3,6}(\.IS)?$/.test(symbol);
}

function toYahooSymbol(holding) {
  const explicit = holding.yahooSymbol;

  if (explicit && explicit !== "NULL" && explicit !== "N/A") {
    return explicit.includes(".") ? explicit : `${explicit}.IS`;
  }

  const symbol = holding.symbol;

  if (!symbol || symbol === "NULL" || symbol === "N/A") return null;
  if (symbol.includes(".")) return symbol;

  return `${symbol}.IS`;
}

async function yahooQuote(yahooSymbol) {
  const result = {
    ok: false,
    symbol: yahooSymbol,
    price: null,
    previous: null,
    change: null,
    issue: null
  };

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSymbol
    )}?range=7d&interval=1d`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 FinScope/10.5"
      }
    });

    if (!response.ok) {
      result.issue = `HTTP_${response.status}`;
      return result;
    }

    const data = await response.json();
    const chart = data?.chart?.result?.[0];
    const closes = chart?.indicators?.quote?.[0]?.close || [];
    const clean = closes.filter((x) => Number.isFinite(Number(x))).map(Number);

    if (clean.length < 2) {
      result.issue = "not_enough_price_points";
      return result;
    }

    const price = clean[clean.length - 1];
    const previous = clean[clean.length - 2];

    if (!previous) {
      result.issue = "previous_zero";
      return result;
    }

    result.ok = true;
    result.price = price;
    result.previous = previous;
    result.change = ((price - previous) / previous) * 100;

    return result;
  } catch (error) {
    result.issue = error.message || "yahoo_fetch_failed";
    return result;
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function loadFundPrices() {
  const path = `fund_prices?select=*&fund_code=in.(${FUNDS.join(
    ","
  )})&order=price_date.desc,created_at.desc&limit=400`;

  return supabaseRequest(path);
}

async function loadHoldings() {
  const path = `fund_holdings?select=*&fund_code=in.(${FUNDS.join(",")})&limit=2500`;
  return supabaseRequest(path);
}

async function loadPerformanceRows() {
  const base = `prediction_performance?select=*&fund_code=in.(${FUNDS.join(
    ","
  )})&order=prediction_date.desc&limit=800`;

  try {
    return await supabaseRequest(`${base}&model=eq.${MODEL}`);
  } catch (_) {
    return supabaseRequest(base);
  }
}

function buildFundPriceState(rows) {
  const byFund = {};

  for (const fund of FUNDS) byFund[fund] = [];

  for (const row of rows || []) {
    const fund = normalizeFundCode(row.fund_code || row.fundCode || row.code);
    if (!FUNDS.includes(fund)) continue;
    byFund[fund].push(row);
  }

  const state = {};
  let latestFundDate = null;

  for (const fund of FUNDS) {
    const sorted = byFund[fund].sort((a, b) => {
      const da = String(b.price_date || "").localeCompare(String(a.price_date || ""));
      if (da !== 0) return da;
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });

    const latest = sorted[0] || null;
    const recentChanges = sorted
      .slice(0, 10)
      .map((x) => toNumber(x.daily_change))
      .filter((x) => x !== null);

    state[fund] = {
      latest,
      rows: sorted,
      latestDate: latest ? String(latest.price_date || "").slice(0, 10) : null,
      latestPrice: latest ? toNumber(latest.price) : null,
      latestDailyChange: latest ? toNumber(latest.daily_change, 0) : null,
      recentAverageFundChange: average(recentChanges.slice(0, 5)) ?? 0,
      recentAverageFundChange10: average(recentChanges) ?? 0
    };

    if (state[fund].latestDate && (!latestFundDate || state[fund].latestDate > latestFundDate)) {
      latestFundDate = state[fund].latestDate;
    }
  }

  return { state, latestFundDate };
}

function getFinalValue(row) {
  return toNumber(
    row.final_prediction_change ??
      row.finalPredictionChange ??
      row.calibrated_change ??
      row.predicted_change ??
      row.predictedChange
  );
}

function computeStats(rows, fund) {
  const fundRows = (rows || [])
    .filter((row) => normalizeFundCode(row.fund_code || row.fundCode) === fund)
    .filter((row) => String(row.model || MODEL) === MODEL || !row.model)
    .filter((row) =>
      ["closed", "shock_closed", "completed"].includes(
        String(row.status || row.rawStatus || "").toLowerCase()
      )
    )
    .filter((row) => toNumber(row.actual_change) !== null && getFinalValue(row) !== null)
    .slice(0, 40);

  const errors = fundRows.map((row) => {
    const actual = toNumber(row.actual_change, 0);
    const predicted = getFinalValue(row) ?? 0;
    return actual - predicted;
  });

  const absErrors = errors.map(Math.abs);
  const ratios = [];
  const shockRatios = [];
  let directionHit = 0;
  let directionTotal = 0;

  for (const row of fundRows) {
    const actual = toNumber(row.actual_change, 0);
    const predicted = getFinalValue(row) ?? 0;

    if (direction(actual) !== "flat" && direction(predicted) !== "flat") {
      directionTotal += 1;
      if (direction(actual) === direction(predicted)) directionHit += 1;
    }

    if (Math.abs(predicted) >= 0.05 && sameDirection(actual, predicted)) {
      const ratio = actual / predicted;

      if (Number.isFinite(ratio) && Math.abs(ratio) < 8) {
        ratios.push(clamp(ratio, 0.25, 2.0));

        if (Math.abs(actual) >= 6 || String(row.status || "").toLowerCase() === "shock_closed") {
          shockRatios.push(clamp(ratio, 0.25, 2.0));
        }
      }
    }
  }

  const avgError = average(errors) ?? 0;
  const avgAbsError = average(absErrors) ?? null;
  const beta = median(ratios) ?? 1;
  const shockBeta = median(shockRatios) ?? beta;

  const learningStatus =
    fundRows.length >= 15 ? "Aktif" : fundRows.length >= 8 ? "Ogreniyor" : "Ornek az";

  return {
    fundCode: fund,
    sampleSize: fundRows.length,
    averageError: round(avgError, 4),
    averageAbsoluteError: round(avgAbsError, 4),
    beta: round(beta, 4),
    shockBeta: round(shockBeta, 4),
    directionHitRate: directionTotal ? round((directionHit / directionTotal) * 100, 2) : null,
    learningStatus
  };
}

async function buildMarketMap(holdings) {
  const symbols = [];
  const seen = new Set();

  for (const holding of holdings) {
    if (!isStockHolding(holding)) continue;

    const yahooSymbol = toYahooSymbol(holding);
    if (!yahooSymbol || seen.has(yahooSymbol)) continue;

    seen.add(yahooSymbol);
    symbols.push(yahooSymbol);
  }

  const requested = symbols.slice(0, 90);
  const marketMap = new Map();

  await mapLimit(requested, 6, async (symbol) => {
    marketMap.set(symbol, await yahooQuote(symbol));
  });

  return {
    marketMap,
    requestedSymbols: requested.length,
    totalSymbols: symbols.length
  };
}

function buildPortfolioSignal(fund, holdings, marketMap, priceState, stats, predictionDate) {
  const rawHoldings = holdings.filter((holding) => holding.fundCode === fund && holding.weight > 0);
  const totalOriginalWeight = rawHoldings.reduce((sum, h) => sum + Math.max(0, h.weight), 0);

  const normalized = rawHoldings.map((holding) => ({
    ...holding,
    effectiveWeight: totalOriginalWeight > 0 ? (holding.weight / totalOriginalWeight) * 100 : 0
  }));

  let stockWeight = 0;
  let nonStockWeight = 0;
  let pricedWeight = 0;
  let unresolvedWeight = 0;
  let contributionSum = 0;
  let pricedCount = 0;

  const pricedRows = [];
  const unresolvedRows = [];
  const nonStockRows = [];

  for (const holding of normalized) {
    const stock = isStockHolding(holding);

    if (!stock) {
      nonStockWeight += holding.effectiveWeight;

      nonStockRows.push({
        symbol: holding.symbol,
        name: holding.name,
        assetType: holding.assetType,
        weight: round(holding.effectiveWeight, 4),
        contribution: 0,
        issue: "non_stock"
      });

      continue;
    }

    stockWeight += holding.effectiveWeight;

    const yahooSymbol = toYahooSymbol(holding);
    const quote = yahooSymbol ? marketMap.get(yahooSymbol) : null;

    if (quote && quote.ok && toNumber(quote.change) !== null) {
      const contribution = (holding.effectiveWeight / 100) * quote.change;

      pricedWeight += holding.effectiveWeight;
      contributionSum += contribution;
      pricedCount += 1;

      pricedRows.push({
        symbol: holding.symbol,
        yahooSymbol,
        name: holding.name,
        assetType: holding.assetType,
        weight: round(holding.effectiveWeight, 4),
        marketChange: round(quote.change, 4),
        price: round(quote.price, 4),
        previous: round(quote.previous, 4),
        contribution: round(contribution, 4),
        pricingSource: "Yahoo Finance chart",
        directPricing: true
      });
    } else {
      unresolvedWeight += holding.effectiveWeight;

      unresolvedRows.push({
        symbol: holding.symbol,
        yahooSymbol,
        name: holding.name,
        assetType: holding.assetType,
        weight: round(holding.effectiveWeight, 4),
        contribution: 0,
        issue: quote?.issue || "not_priced"
      });
    }
  }

  const latest = priceState[fund] || {};
  const latestFundChange = toNumber(latest.latestDailyChange, 0);
  const recentAverage = toNumber(latest.recentAverageFundChange, 0);

  const reportDates = normalized
    .map((h) => h.reportDate)
    .filter(Boolean)
    .sort();

  const holdingsReportDate = reportDates.length ? reportDates[reportDates.length - 1] : null;
  const freshnessDays = holdingsReportDate ? dayDiff(holdingsReportDate, predictionDate) : null;

  const freshnessStatus =
    freshnessDays === null
      ? "unknown"
      : freshnessDays <= 35
      ? "fresh"
      : freshnessDays <= 60
      ? "watch"
      : "stale";

  const coverage = round(pricedWeight, 4) ?? 0;
  const residualWeight = round(Math.max(0, 100 - coverage), 4) ?? 0;
  const rawWeightedChange = round(contributionSum, 4) ?? 0;

  const shockActive =
    abs(rawWeightedChange) >= 5 || abs(latestFundChange) >= 6 || abs(recentAverage) >= 5;

  const topPositiveContributors = pricedRows
    .filter((row) => row.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 6);

  const topNegativeContributors = pricedRows
    .filter((row) => row.contribution < 0)
    .sort((a, b) => a.contribution - b.contribution)
    .slice(0, 8);

  return {
    fundCode: fund,
    predictionDate,
    holdingsCount: normalized.length,
    totalOriginalWeight: round(totalOriginalWeight, 4),
    stockWeight: round(stockWeight, 4),
    nonStockWeight: round(nonStockWeight, 4),
    pricedWeight: round(pricedWeight, 4),
    unresolvedWeight,
    residualWeight,
    coverage,
    rawWeightedChange,
    latestFundChange: round(latestFundChange, 4),
    recentAverageFundChange: round(recentAverage, 4),
    holdingsReportDate,
    holdingsFreshnessDays: freshnessDays,
    holdingsFreshnessStatus: freshnessStatus,
    pricedRows,
    unresolvedRows,
    nonStockRows: nonStockRows.slice(0, 25),
    topPositiveContributors,
    topNegativeContributors,
    pricedCount,
    shockActive,
    stats
  };
}

function dynamicAbsCap(fund, signal, stats) {
  const observed = Math.max(
    abs(signal.latestFundChange),
    abs(signal.recentAverageFundChange),
    abs(signal.rawWeightedChange)
  );

  let cap = fund === "PBR" || fund === "PHE" ? 8.5 : fund === "TLY" ? 4.0 : 3.2;

  if (observed >= 20) cap = fund === "PBR" || fund === "PHE" ? 16 : 6;
  else if (observed >= 12) cap = fund === "PBR" || fund === "PHE" ? 13 : 5;
  else if (observed >= 6) cap = fund === "PBR" || fund === "PHE" ? 10 : 4.5;

  if (signal.coverage < 30) cap *= 0.65;
  else if (signal.coverage < 60) cap *= 0.82;

  if (stats.averageAbsoluteError !== null && stats.averageAbsoluteError > 8) cap *= 0.9;

  return round(Math.max(1.2, cap), 4);
}

function hardBrake(value, cap) {
  const n = toNumber(value, 0);
  const limit = Math.max(0.5, toNumber(cap, 4));

  if (Math.abs(n) <= limit) return n;

  const sign = Math.sign(n) || 1;
  const excess = Math.abs(n) - limit;
  const softened = limit + Math.log1p(excess) * 0.65;

  return sign * Math.min(softened, limit * 1.15);
}

function calculatePrediction(fund, signal, stats) {
  const coverage = toNumber(signal.coverage, 0);
  const raw = toNumber(signal.rawWeightedChange, 0);
  const latest = toNumber(signal.latestFundChange, 0);
  const recent = toNumber(signal.recentAverageFundChange, 0);
  const shockActive = signal.shockActive;

  const residualFallback =
    (signal.residualWeight / 100) * clamp(recent, -6, 6) * (shockActive ? 0.28 : 0.14);

  const momentum = clamp(recent * (shockActive ? 0.1 : 0.04), -1.25, 1.25);
  const calibrationOffset = clamp((stats.averageError || 0) * 0.18, -1.25, 1.25);

  let beta = shockActive ? stats.shockBeta || stats.beta || 1 : stats.beta || 1;
  beta = clamp(beta, 0.45, shockActive ? 1.18 : 1.25);

  if ((stats.averageAbsoluteError || 0) > 5) beta = Math.min(beta, 0.92);
  if ((stats.averageAbsoluteError || 0) > 9) beta = Math.min(beta, 0.78);

  let freshnessFactor = 1;
  if (signal.holdingsFreshnessStatus === "watch") freshnessFactor = 0.9;
  if (signal.holdingsFreshnessStatus === "stale") freshnessFactor = 0.72;

  let shockMultiplier = 1;

  if (shockActive && sameDirection(raw, latest)) {
    shockMultiplier = 1 + clamp((Math.max(abs(raw), abs(latest)) - 5) / 60, 0, 0.18);
  }

  const rawPredictedChange = (raw + residualFallback + momentum) * beta * shockMultiplier;
  const calibratedChange = (rawPredictedChange + calibrationOffset) * freshnessFactor;

  const cap = dynamicAbsCap(fund, signal, stats);
  const finalPredictionChange = hardBrake(calibratedChange, cap);

  const expectedErrorBand = clamp(
    (stats.averageAbsoluteError || 1.5) * 0.55 + (100 - coverage) * 0.015,
    0.5,
    8
  );

  let confidence = 28 + coverage * 0.45 + Math.min(stats.sampleSize || 0, 18) * 1.2;

  confidence -= abs(finalPredictionChange) * 0.8;

  if (signal.holdingsFreshnessStatus === "watch") confidence -= 8;
  if (signal.holdingsFreshnessStatus === "stale") confidence -= 16;
  if (coverage < 40) confidence -= 12;
  if (stats.averageAbsoluteError !== null && stats.averageAbsoluteError > 5) confidence -= 8;

  confidence = clamp(confidence, 12, 94);

  const issues = [];

  if (coverage < 50) issues.push("low_priced_weight_coverage");
  if (signal.holdingsFreshnessStatus !== "fresh") {
    issues.push(`holdings_${signal.holdingsFreshnessStatus}`);
  }
  if (signal.unresolvedWeight > 20) issues.push("unpriced_or_unresolved_holdings");

  if (
    Math.abs(calibratedChange) !== Math.abs(finalPredictionChange) &&
    Math.abs(calibratedChange) > Math.abs(finalPredictionChange)
  ) {
    issues.push("shock_brake_applied");
  }

  const learningMode = shockActive
    ? "shock_brake_active"
    : stats.sampleSize >= 15
    ? "active_15_day"
    : "learning";

  const note = shockActive
    ? "v10.5 NAV Shock Brake: portfoy sinyali korunur, asiri tek gunluk tahminler frenlenir."
    : "v10.5 NAV Core: portfoy agirligi x piyasa degisimi temel sinyaldir.";

  return {
    fundCode: fund,
    code: fund,
    fund,
    predictionDate: signal.predictionDate,
    model: MODEL,
    modelKey: MODEL_KEY,
    modelVersion: MODEL_VERSION,
    source: ENGINE_SOURCE,

    rawPredictedChange: round(rawPredictedChange, 4),
    predictedChange: round(finalPredictionChange, 4),
    calibratedChange: round(finalPredictionChange, 4),
    finalPredictionChange: round(finalPredictionChange, 4),
    currentPredictionChange: round(finalPredictionChange, 4),

    predictionDirection: direction(finalPredictionChange),
    rangeLow: round(finalPredictionChange - expectedErrorBand, 4),
    rangeHigh: round(finalPredictionChange + expectedErrorBand, 4),
    expectedErrorBand: round(expectedErrorBand, 4),

    confidence: round(confidence, 2),
    confidenceText: confidenceText(confidence),
    coverage: round(coverage, 4),
    residualWeight: round(signal.residualWeight, 4),

    causalRawChange: round(raw, 4),
    latestFundActualChange: round(latest, 4),
    recentAverageFundChange: round(recent, 4),

    stockWeight: round(signal.stockWeight, 4),
    nonStockWeight: round(signal.nonStockWeight, 4),
    pricedWeight: round(signal.pricedWeight, 4),
    unresolvedWeight: round(signal.unresolvedWeight, 4),
    totalHoldingRows: signal.holdingsCount,

    holdingsReportDate: signal.holdingsReportDate,
    holdingsFreshnessDays: signal.holdingsFreshnessDays,
    holdingsFreshnessStatus: signal.holdingsFreshnessStatus,

    shockActive,
    shockMultiplier: round(shockMultiplier, 4),
    shockBrakeCap: cap,

    betaMultiplier: round(beta, 4),
    calibrationOffset: round(calibrationOffset, 4),
    residualFallback: round(residualFallback, 4),
    momentum: round(momentum, 4),

    learningMode,
    learningStatus: stats.learningStatus,
    sampleSize: stats.sampleSize || 0,

    issues,
    note,

    topPositiveContributors: signal.topPositiveContributors,
    topNegativeContributors: signal.topNegativeContributors,
    unresolvedHoldings: signal.unresolvedRows.slice(0, 20),
    nonStockHoldings: signal.nonStockRows.slice(0, 20)
  };
}

function buildSavePayload(predictions) {
  const now = new Date().toISOString();

  return predictions.map((prediction) => ({
    fund_code: prediction.fundCode,
    prediction_date: prediction.predictionDate,
    model: MODEL,

    predicted_change: prediction.finalPredictionChange,
    actual_change: null,
    error_change: null,

    confidence: prediction.confidence,
    coverage: prediction.coverage,
    residual_weight: prediction.residualWeight,
    source: ENGINE_SOURCE,

    created_at: now,
    updated_at: now,

    raw_predicted_change: prediction.rawPredictedChange,
    calibrated_change: prediction.finalPredictionChange,
    calibration_offset: prediction.calibrationOffset,

    actual_price_date: null,
    sample_size: prediction.sampleSize,
    model_version: MODEL_VERSION
  }));
}

async function savePredictions(predictions) {
  const payload = buildSavePayload(predictions);

  if (!payload.length) {
    return {
      ok: true,
      saved: 0,
      attempted: 0,
      rows: []
    };
  }

  const data = await supabaseRequest(
    "prediction_history?on_conflict=fund_code,prediction_date,model",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(payload)
    }
  );

  return {
    ok: true,
    saved: Array.isArray(data) ? data.length : payload.length,
    attempted: payload.length,
    rows: data || []
  };
}

function buildSummary(predictions, marketInfo) {
  const confidences = predictions.map((p) => p.confidence).filter((x) => x !== null);
  const coverages = predictions.map((p) => p.coverage).filter((x) => x !== null);

  const strongSignals = predictions
    .filter((p) => Math.abs(p.finalPredictionChange || 0) >= 1)
    .map((p) => p.fundCode);

  const shockSignals = predictions.filter((p) => p.shockActive).map((p) => p.fundCode);
  const lowCoverageFunds = predictions.filter((p) => p.coverage < 50).map((p) => p.fundCode);

  return {
    totalFunds: predictions.length,
    funds: predictions.map((p) => p.fundCode),

    averageConfidence: round(average(confidences), 2),
    averageCoverage: round(average(coverages), 2),

    strongestSignals: strongSignals,
    shockSignals,
    lowCoverageFunds,

    requestedSymbols: marketInfo.requestedSymbols,
    pricedSymbols: Array.from(marketInfo.marketMap.values()).filter((q) => q.ok).length,
    unresolvedSymbols: Array.from(marketInfo.marketMap.values()).filter((q) => !q.ok).length,

    rule:
      "NAV = portfoy agirligi x gunluk piyasa degisimi; v10.5 tek gunluk asiri tahminleri shock brake ile sinirlar.",

    targetAbsoluteError: TARGET_ABSOLUTE_ERROR
  };
}

async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const started = Date.now();

  try {
    const query = req.query || {};

    const manualAuthorized =
      query.manual === "finscope" ||
      query.key === "finscope" ||
      String(req.headers.authorization || "") === `Bearer ${process.env.CRON_SECRET || ""}`;

    const dryRun = query.dryRun === "1" || query.dryrun === "1" || query.save === "0";
    const report = query.report === "1" || query.report === "true";

    const [fundPriceRows, holdingRows, performanceRows] = await Promise.all([
      loadFundPrices(),
      loadHoldings(),
      loadPerformanceRows()
    ]);

    const { state: priceState, latestFundDate } = buildFundPriceState(fundPriceRows || []);
    const baseDate = latestFundDate || isoDateTR();
    const predictionDate = query.date || nextBusinessDate(baseDate);

    const normalizedHoldings = (holdingRows || [])
      .map(normalizeHolding)
      .filter((h) => FUNDS.includes(h.fundCode));

    const marketInfo = await buildMarketMap(normalizedHoldings);

    const predictions = [];
    const causalNavReport = {};
    const learningStats = {};

    for (const fund of FUNDS) {
      const stats = computeStats(performanceRows || [], fund);
      learningStats[fund] = stats;

      const signal = buildPortfolioSignal(
        fund,
        normalizedHoldings,
        marketInfo.marketMap,
        priceState,
        stats,
        predictionDate
      );

      causalNavReport[fund] = report
        ? signal
        : {
            fundCode: signal.fundCode,
            holdingsReportDate: signal.holdingsReportDate,
            holdingsFreshnessStatus: signal.holdingsFreshnessStatus,
            coverage: signal.coverage,
            rawWeightedChange: signal.rawWeightedChange,
            shockActive: signal.shockActive,
            topNegativeContributors: signal.topNegativeContributors.slice(0, 3),
            topPositiveContributors: signal.topPositiveContributors.slice(0, 3),
            unresolvedWeight: signal.unresolvedWeight
          };

      predictions.push(calculatePrediction(fund, signal, stats));
    }

    let saveResult = {
      ok: true,
      saved: 0,
      attempted: predictions.length,
      skipped: true,
      reason: dryRun ? "dryRun" : "manual authorization required"
    };

    if (!dryRun && manualAuthorized) {
      saveResult = await savePredictions(predictions);
    }

    const predictionsByFund = {};
    for (const prediction of predictions) {
      predictionsByFund[prediction.fundCode] = prediction;
    }

    return sendJson(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      version: VERSION,
      mode: report ? "embedded_causal_nav_report" : "prediction",
      endpoint: "/api/predict",

      model: MODEL,
      modelKey: MODEL_KEY,
      modelVersion: MODEL_VERSION,

      fundOrder: FUNDS,
      latestFundDate,
      predictionDate,

      source: ENGINE_SOURCE,
      virtualEnabled: false,
      saveEnabled: !dryRun && manualAuthorized,
      dryRun,

      summary: buildSummary(predictions, marketInfo),
      predictions: predictionsByFund,
      causalNavReport,
      learningStats,
      rows: predictions,

      saveResult,
      removedColumns: [],
      warnings: predictions.flatMap((p) => p.issues.map((issue) => `${p.fundCode}:${issue}`)),

      elapsedMs: Date.now() - started,

      disclaimer:
        "Bu tahminler model bazlidir, kesinlik icermez ve yatirim tavsiyesi degildir."
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      generatedAt: new Date().toISOString(),
      version: VERSION,
      model: MODEL,
      modelVersion: MODEL_VERSION,
      error: error.message,
      elapsedMs: Date.now() - started
    });
  }
}

module.exports = handler;
