// api/predict.js
// FinScope Predict API v10.4.1 - Multi Asset NAV Engine + Official Portfolio Date Anchors
// Full replacement file.

const API_VERSION = "FinScope Predict API v10.4.1 - Multi Asset NAV Engine + Official Portfolio Date Anchors";
const MODEL = "v7_1_accuracy_layer";
const MODEL_KEY = "v7_1_accuracy_layer";
const MODEL_VERSION = "FinScope Prediction Engine v10.4.1 - Multi Asset NAV Engine + Official Portfolio Date Anchors";

const FUND_ORDER = ["PBR", "PHE", "TLY", "THF"];
const TARGET_ABSOLUTE_ERROR = 0.1;
const YAHOO_TIMEOUT_MS = 4500;
const YAHOO_CONCURRENCY = 6;

// KAP tarafında yayımlanan en güncel portföy dağılım tarihi.
// TLY ve THF için kullanıcı tarafından bildirilen son KAP portföy dağılım tarihi: 07.08.2026.
// Bu değer portföy satırlarını değiştirmez; mevcut fund_holdings satırlarını güncel rapor tarihiyle değerlendirir.
const OFFICIAL_HOLDINGS_REPORT_DATES = {
  TLY: "2026-08-07",
  THF: "2026-08-07"
};

const HISTORY_COLUMNS = [
  "fund_code",
  "prediction_date",
  "model",
  "predicted_change",
  "actual_change",
  "error_change",
  "confidence",
  "created_at",
  "updated_at",
  "raw_predicted_change",
  "calibrated_change",
  "calibration_offset",
  "actual_price_date",
  "sample_size",
  "model_version"
];

const NON_STOCK_DAILY_PROXY = {
  cash: 0.08,
  deposit: 0.09,
  repo: 0.09,
  reverse_repo: 0.09,
  fixed_income: 0.07,
  bond: 0.06,
  lease_certificate: 0.06,
  fund: 0,
  stock: 0,
  equity: 0,
  gold: 0,
  currency: 0,
  other: 0
};

function setCommonHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, statusCode, data) {
  setCommonHeaders(res);
  res.status(statusCode).send(JSON.stringify(data));
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const text = String(value).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = toNumber(value, null);
  if (n === null) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function clamp(value, min, max) {
  const n = toNumber(value, 0);
  return Math.max(min, Math.min(max, n));
}

function avg(values) {
  const nums = values.map((x) => toNumber(x, null)).filter((x) => x !== null);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function signOf(value) {
  const n = toNumber(value, 0);
  if (n > 0.0001) return "up";
  if (n < -0.0001) return "down";
  return "flat";
}

function sameDirection(a, b) {
  const sa = signOf(a);
  const sb = signOf(b);
  return sa !== "flat" && sa === sb;
}

function absDateDiffDays(a, b) {
  if (!a || !b) return null;
  const da = new Date(`${String(a).slice(0, 10)}T00:00:00Z`);
  const db = new Date(`${String(b).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.round((da.getTime() - db.getTime()) / 86400000);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextBusinessDay(dateStr) {
  if (!dateStr) return new Date().toISOString().slice(0, 10);
  let d = addDays(dateStr, 1);
  while (true) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) return d;
    d = addDays(d, 1);
  }
}

function maxDate(values) {
  const clean = values.filter(Boolean).map((x) => String(x).slice(0, 10)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
  if (!clean.length) return null;
  return clean.sort().at(-1);
}

function officialHoldingsReportDate(code, detectedDate) {
  const fundCode = normalizeFundCode(code);
  const officialDate = OFFICIAL_HOLDINGS_REPORT_DATES[fundCode] || null;
  const cleanDetected = detectedDate && /^\d{4}-\d{2}-\d{2}$/.test(String(detectedDate).slice(0, 10))
    ? String(detectedDate).slice(0, 10)
    : null;

  if (!officialDate) return cleanDetected;
  if (!cleanDetected) return officialDate;

  // KAP resmi yayın tarihi daha yeniyse, tazelik hesabında resmi tarihi kullan.
  return officialDate > cleanDetected ? officialDate : cleanDetected;
}

function asciiFold(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

function normalizeFundCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeAssetType(row) {
  const raw = asciiFold(row.asset_type || row.assetType || row.type || row.varlik_tipi || row.varlik || row.category || row.name || "");

  if (raw.includes("hisse") || raw.includes("stock") || raw.includes("equity")) return "stock";
  if (raw.includes("ters repo") || raw.includes("reverse repo")) return "reverse_repo";
  if (raw.includes("repo")) return "repo";
  if (raw.includes("mevduat") || raw.includes("deposit")) return "deposit";
  if (raw.includes("nakit") || raw.includes("cash")) return "cash";
  if (raw.includes("tahvil") || raw.includes("bono") || raw.includes("borclan") || raw.includes("fixed") || raw.includes("debt")) return "fixed_income";
  if (raw.includes("kira") || raw.includes("sukuk") || raw.includes("lease")) return "lease_certificate";
  if (raw.includes("altin") || raw.includes("gold")) return "gold";
  if (raw.includes("doviz") || raw.includes("currency") || raw.includes("usd") || raw.includes("eur")) return "currency";
  if (raw.includes("fon") || raw.includes("fund")) return "fund";

  const symbol = String(row.symbol || row.asset_code || row.code || "").trim();
  if (/^[A-Z0-9]{3,8}(\.IS)?$/i.test(symbol)) return "stock";
  return "other";
}

function normalizeSymbol(row) {
  return String(row.symbol || row.asset_symbol || row.asset_code || row.code || row.ticker || row.name || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeYahooSymbol(row, assetType) {
  const explicit = String(row.yahoo_symbol || row.yahooSymbol || row.yahoo || "").trim().toUpperCase();
  if (explicit) return explicit;

  const symbol = normalizeSymbol(row);
  if (!symbol || assetType !== "stock") return null;
  if (symbol.includes(".")) return symbol;
  if (/^[A-Z0-9]{3,8}$/.test(symbol)) return `${symbol}.IS`;
  return null;
}

function getRowFund(row) {
  return normalizeFundCode(row.fund_code || row.fundCode || row.fund || row.fon_kodu || row.code);
}

function getHoldingReportDate(row) {
  return (
    row.report_date ||
    row.holdings_report_date ||
    row.holding_report_date ||
    row.portfolio_date ||
    row.date ||
    (row.created_at ? String(row.created_at).slice(0, 10) : null)
  );
}

function getHoldingWeight(row) {
  return toNumber(
    row.weight ??
      row.weight_percent ??
      row.effective_weight ??
      row.ratio ??
      row.percentage ??
      row.pay_orani ??
      row.agirlik ??
      row.portfolio_weight,
    0
  );
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Supabase environment variables are missing. Required: SUPABASE_URL and service/anon key.");
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = supabaseConfig();
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
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === "string" ? data : JSON.stringify(data);
    const err = new Error(`Supabase ${method} ${path} HTTP ${response.status}: ${message}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function safeRead(path, fallback, warnings, label) {
  try {
    const data = await supabaseRequest(path);
    return Array.isArray(data) ? data : fallback;
  } catch (error) {
    warnings.push({ source: label, message: error.message });
    return fallback;
  }
}

function latestFundPrices(priceRows) {
  const grouped = new Map();
  for (const row of priceRows || []) {
    const code = getRowFund(row);
    if (!FUND_ORDER.includes(code)) continue;
    const date = row.price_date || row.date || row.nav_date || row.created_at;
    if (!date) continue;
    if (!grouped.has(code)) grouped.set(code, []);
    grouped.get(code).push(row);
  }

  const latest = {};
  const history = {};
  for (const code of FUND_ORDER) {
    const rows = (grouped.get(code) || []).sort((a, b) => {
      const ad = String(a.price_date || a.date || a.created_at || "").slice(0, 10);
      const bd = String(b.price_date || b.date || b.created_at || "").slice(0, 10);
      if (ad !== bd) return bd.localeCompare(ad);
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
    history[code] = rows;
    latest[code] = rows[0] || null;
  }

  return { latest, history };
}

function groupLatestHoldingsByFund(holdingRows) {
  const all = new Map();
  for (const row of holdingRows || []) {
    const code = getRowFund(row);
    if (!FUND_ORDER.includes(code)) continue;
    if (!all.has(code)) all.set(code, []);
    all.get(code).push(row);
  }

  const result = {};
  const reportDates = {};
  for (const code of FUND_ORDER) {
    const rows = all.get(code) || [];
    const latestDate = maxDate(rows.map(getHoldingReportDate));
    const resolvedReportDate = officialHoldingsReportDate(code, latestDate);
    reportDates[code] = resolvedReportDate;
    const selected = latestDate ? rows.filter((r) => String(getHoldingReportDate(r) || "").slice(0, 10) === latestDate) : rows;

    const normalized = selected
      .map((row) => {
        const assetType = normalizeAssetType(row);
        const symbol = normalizeSymbol(row);
        const yahooSymbol = normalizeYahooSymbol(row, assetType);
        const weight = getHoldingWeight(row);
        return {
          raw: row,
          fundCode: code,
          symbol,
          yahooSymbol,
          name: row.name || row.asset_name || row.title || symbol || "Bilinmeyen varlık",
          assetType,
          originalWeight: weight,
          effectiveWeight: weight,
          reportDate: resolvedReportDate || getHoldingReportDate(row)
        };
      })
      .filter((x) => x.originalWeight > 0);

    const weightSum = normalized.reduce((sum, x) => sum + x.originalWeight, 0);
    const needsNormalize = weightSum > 0 && (weightSum < 95 || weightSum > 105);
    for (const item of normalized) {
      item.effectiveWeight = needsNormalize ? (item.originalWeight / weightSum) * 100 : item.originalWeight;
    }

    result[code] = normalized;
  }

  return { holdingsByFund: result, reportDates };
}

async function fetchYahooChange(yahooSymbol) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), YAHOO_TIMEOUT_MS);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=7d&interval=1d`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 FinScope/10.4.1"
      }
    });

    if (!response.ok) {
      return { ok: false, issue: `HTTP_${response.status}` };
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const closes = (quote?.close || []).filter((x) => Number.isFinite(x) && x > 0);
    const timestamps = result?.timestamp || [];

    if (closes.length < 2) {
      return { ok: false, issue: "not_enough_price_points" };
    }

    const price = closes[closes.length - 1];
    let previous = closes[closes.length - 2];
    for (let i = closes.length - 2; i >= 0; i -= 1) {
      if (closes[i] && closes[i] !== price) {
        previous = closes[i];
        break;
      }
    }

    if (!previous || previous <= 0) {
      return { ok: false, issue: "invalid_previous_price" };
    }

    const marketChange = ((price - previous) / previous) * 100;
    const lastTimestamp = timestamps[timestamps.length - 1];
    const reportDate = lastTimestamp ? new Date(lastTimestamp * 1000).toISOString().slice(0, 10) : null;

    return {
      ok: true,
      yahooSymbol,
      price,
      previous,
      marketChange,
      reportDate,
      pricingSource: "Yahoo Finance chart"
    };
  } catch (error) {
    return { ok: false, issue: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function priceHoldings(holdingsByFund) {
  const symbols = new Set();
  for (const rows of Object.values(holdingsByFund)) {
    for (const h of rows) {
      if (h.assetType === "stock" && h.yahooSymbol) symbols.add(h.yahooSymbol);
    }
  }

  const symbolList = Array.from(symbols);
  const priced = {};
  await mapLimit(symbolList, YAHOO_CONCURRENCY, async (symbol) => {
    priced[symbol] = await fetchYahooChange(symbol);
  });

  const result = {};
  for (const code of FUND_ORDER) {
    const rows = holdingsByFund[code] || [];
    const directStockRows = [];
    const unresolvedStockRows = [];

    for (const h of rows) {
      const info = h.yahooSymbol ? priced[h.yahooSymbol] : null;
      if (h.assetType === "stock" && info?.ok) {
        directStockRows.push({ h, info });
      } else if (h.assetType === "stock") {
        unresolvedStockRows.push({ h, info });
      }
    }

    const directStockWeight = directStockRows.reduce((s, x) => s + x.h.effectiveWeight, 0);
    const directStockContribution = directStockRows.reduce(
      (s, x) => s + (x.h.effectiveWeight / 100) * toNumber(x.info.marketChange, 0),
      0
    );
    const stockPeerProxyChange = directStockWeight > 0 ? (directStockContribution / directStockWeight) * 100 : 0;

    const enriched = rows.map((h) => {
      const info = h.yahooSymbol ? priced[h.yahooSymbol] : null;
      let marketChange = 0;
      let directPricing = false;
      let pricingSource = "proxy";
      let issue = null;
      let price = null;
      let previous = null;

      if (h.assetType === "stock" && info?.ok) {
        marketChange = toNumber(info.marketChange, 0);
        directPricing = true;
        pricingSource = info.pricingSource;
        price = info.price;
        previous = info.previous;
      } else if (h.assetType === "stock") {
        marketChange = stockPeerProxyChange;
        pricingSource = directStockWeight > 0 ? "stock peer proxy" : "unpriced stock fallback";
        issue = info?.issue || "not_priced";
      } else {
        marketChange = NON_STOCK_DAILY_PROXY[h.assetType] ?? NON_STOCK_DAILY_PROXY.other;
        pricingSource = `${h.assetType} daily proxy`;
      }

      const contribution = (h.effectiveWeight / 100) * marketChange;
      return {
        ...h,
        marketChange,
        contribution,
        directPricing,
        pricingSource,
        price,
        previous,
        issue
      };
    });

    result[code] = enriched;
  }

  return { pricedHoldingsByFund: result, yahooSymbolsRequested: symbolList.length, yahooPriceMap: priced };
}

function performanceLearning(performanceRows, code) {
  const rows = (performanceRows || [])
    .filter((row) => getRowFund(row) === code)
    .filter((row) => ["closed", "shock_closed", "normal_closed"].includes(String(row.status || "").toLowerCase()))
    .filter((row) => toNumber(row.actual_change, null) !== null && toNumber(row.final_prediction_change, null) !== null)
    .slice(0, 30);

  const completed = rows.length;
  if (!completed) {
    return {
      sampleSize: 0,
      offset: 0,
      beta: 1,
      shockMultiplier: 1,
      averageAbsoluteError: null,
      directionHitRate: null,
      learningStatus: "Yeni öğrenme",
      confidencePenalty: 8
    };
  }

  const errors = rows.map((r) => toNumber(r.actual_change, 0) - toNumber(r.final_prediction_change, 0));
  const offset = clamp(avg(errors) || 0, -1.25, 1.25);

  const absErrors = errors.map(Math.abs);
  const averageAbsoluteError = avg(absErrors);

  const xs = rows.map((r) => toNumber(r.final_prediction_change, 0));
  const ys = rows.map((r) => toNumber(r.actual_change, 0));
  const xAvg = avg(xs) || 0;
  const yAvg = avg(ys) || 0;
  const varX = xs.reduce((sum, x) => sum + (x - xAvg) ** 2, 0);
  const covXY = xs.reduce((sum, x, i) => sum + (x - xAvg) * (ys[i] - yAvg), 0);
  const beta = varX > 0.0001 ? clamp(covXY / varX, 0.35, 3.2) : 1;

  const shockRows = rows.filter((r) => Math.abs(toNumber(r.actual_change, 0)) >= 6);
  const ratios = shockRows
    .map((r) => {
      const pred = toNumber(r.final_prediction_change, 0);
      const actual = toNumber(r.actual_change, 0);
      if (Math.abs(pred) < 0.15 || !sameDirection(pred, actual)) return null;
      return Math.abs(actual / pred);
    })
    .filter((x) => x !== null && Number.isFinite(x));

  const learnedShockMultiplier = ratios.length ? clamp(avg(ratios), 1, 2.8) : 1.15;
  const directionHits = rows.filter((r) => sameDirection(r.actual_change, r.final_prediction_change)).length;
  const directionHitRate = completed ? (directionHits / completed) * 100 : null;

  let learningStatus = "Aktif öğrenme";
  if (completed >= 15 && averageAbsoluteError !== null && averageAbsoluteError <= 0.75) learningStatus = "Öğreniyor";
  if (completed >= 20 && averageAbsoluteError !== null && averageAbsoluteError <= 0.35) learningStatus = "Güven artıyor";
  if (completed < 8) learningStatus = "Örnek sayısı düşük";

  return {
    sampleSize: completed,
    offset,
    beta,
    shockMultiplier: learnedShockMultiplier,
    averageAbsoluteError,
    directionHitRate,
    learningStatus,
    confidencePenalty: clamp((averageAbsoluteError || 0) * 3.5, 0, 18)
  };
}

function fundHistoryStats(priceHistoryRows) {
  const rows = (priceHistoryRows || []).slice(0, 8);
  const changes = rows.map((r) => toNumber(r.daily_change ?? r.change ?? r.dailyChange, null)).filter((x) => x !== null);
  return {
    latestChange: changes.length ? changes[0] : null,
    recentAverageChange: avg(changes.slice(0, 3)) || 0,
    recentAbsAverageChange: avg(changes.slice(0, 3).map(Math.abs)) || 0,
    volatility: avg(changes.map((x) => Math.abs(x - (avg(changes) || 0)))) || 0,
    rows: rows.length
  };
}

function gradeFromError(error) {
  const abs = Math.abs(toNumber(error, 0));
  if (abs <= 0.25) return "Çok iyi";
  if (abs <= 0.75) return "İyi";
  if (abs <= 1.5) return "Makul";
  if (abs <= 3) return "Zayıf";
  return "Şok / yüksek sapma";
}

function confidenceText(score) {
  if (score >= 80) return "Yüksek";
  if (score >= 60) return "Orta";
  if (score >= 40) return "Düşük";
  return "Çok düşük";
}

function summarizeContributors(rows, direction) {
  const sorted = [...rows]
    .filter((r) => Math.abs(toNumber(r.contribution, 0)) > 0.0001)
    .sort((a, b) => toNumber(b.contribution, 0) - toNumber(a.contribution, 0));
  if (direction === "positive") return sorted.slice(0, 8).map(publicHoldingInfo);
  return sorted.reverse().slice(0, 8).map(publicHoldingInfo);
}

function publicHoldingInfo(h) {
  return {
    symbol: h.symbol,
    yahooSymbol: h.yahooSymbol,
    name: h.name,
    assetType: h.assetType,
    weight: round(h.effectiveWeight, 4),
    marketChange: round(h.marketChange, 4),
    contribution: round(h.contribution, 4),
    pricingSource: h.pricingSource,
    directPricing: Boolean(h.directPricing),
    issue: h.issue || null
  };
}

function buildPrediction({ code, holdings, latestFundRow, priceHistory, reportDate, predictionDate, performanceRows }) {
  const learning = performanceLearning(performanceRows, code);
  const historyStats = fundHistoryStats(priceHistory);

  const totalWeight = holdings.reduce((sum, h) => sum + toNumber(h.effectiveWeight, 0), 0);
  const stockWeight = holdings.filter((h) => h.assetType === "stock").reduce((sum, h) => sum + h.effectiveWeight, 0);
  const pricedWeight = holdings.filter((h) => h.directPricing).reduce((sum, h) => sum + h.effectiveWeight, 0);
  const nonStockWeight = Math.max(0, totalWeight - stockWeight);
  const unresolvedWeight = holdings.filter((h) => h.issue).reduce((sum, h) => sum + h.effectiveWeight, 0);

  const causalRawChange = holdings.reduce((sum, h) => sum + toNumber(h.contribution, 0), 0);
  const stockSignal = holdings
    .filter((h) => h.assetType === "stock")
    .reduce((sum, h) => sum + toNumber(h.contribution, 0), 0);
  const nonStockSignal = causalRawChange - stockSignal;

  const recentMomentum = clamp(historyStats.recentAverageChange * 0.12, -2.5, 2.5);
  const residualFallback = clamp((historyStats.latestChange || 0) * (unresolvedWeight / 100) * 0.25, -2.5, 2.5);

  const shockByFund = Math.abs(historyStats.latestChange || 0) >= 6 || Math.abs(historyStats.recentAverageChange || 0) >= 6;
  const shockByPortfolio = Math.abs(causalRawChange) >= 4 || Math.abs(stockSignal) >= 4;
  const directionAligned = sameDirection(causalRawChange, historyStats.latestChange || causalRawChange);
  const shockActive = (shockByFund || shockByPortfolio) && directionAligned;

  let shockMultiplier = 1;
  if (shockActive) {
    shockMultiplier = clamp(learning.shockMultiplier || 1.15, 1.05, 2.65);
    if (Math.abs(causalRawChange) >= 10) shockMultiplier = Math.min(shockMultiplier, 1.35);
    if (Math.abs(causalRawChange) >= 18) shockMultiplier = Math.min(shockMultiplier, 1.15);
  }

  const betaAdjusted = causalRawChange * learning.beta;
  const rawPredictedChange = betaAdjusted * shockMultiplier + residualFallback + recentMomentum;
  const calibratedChange = rawPredictedChange + learning.offset;

  const coverage = totalWeight > 0 ? clamp((pricedWeight / totalWeight) * 100, 0, 100) : 0;
  const resolvedReportDate = officialHoldingsReportDate(code, reportDate);
  const holdingsFreshnessDays = absDateDiffDays(predictionDate, resolvedReportDate);
  const freshnessPenalty = holdingsFreshnessDays === null ? 8 : clamp(Math.max(0, holdingsFreshnessDays - 20) * 0.35, 0, 18);
  const unresolvedPenalty = clamp(unresolvedWeight * 0.18, 0, 18);
  const coveragePenalty = clamp((100 - coverage) * 0.15, 0, 20);
  const shockPenalty = shockActive ? 7 : 0;
  const confidence = clamp(92 - learning.confidencePenalty - freshnessPenalty - unresolvedPenalty - coveragePenalty - shockPenalty, 20, 95);

  const finalPredictionChange = clamp(calibratedChange, -35, 35);
  const rangeWidth = clamp((learning.averageAbsoluteError || 0.9) + (shockActive ? 1.5 : 0.4) + unresolvedWeight * 0.015, 0.35, 8);

  const issues = [];
  if (holdingsFreshnessDays !== null && holdingsFreshnessDays > 30) issues.push("old_holdings_report");
  if (coverage < 45) issues.push("low_direct_price_coverage");
  if (unresolvedWeight > 20) issues.push("high_unpriced_or_proxy_weight");
  if (shockActive) issues.push("shock_aware_mode");
  if (!holdings.length) issues.push("no_holdings_found");

  const topPositiveContributors = summarizeContributors(holdings, "positive");
  const topNegativeContributors = summarizeContributors(holdings, "negative");
  const unresolvedHoldings = holdings.filter((h) => h.issue).slice(0, 20).map(publicHoldingInfo);

  const latestDate = latestFundRow ? String(latestFundRow.price_date || latestFundRow.date || latestFundRow.created_at || "").slice(0, 10) : null;
  const latestPrice = latestFundRow ? toNumber(latestFundRow.price ?? latestFundRow.value ?? latestFundRow.nav, null) : null;
  const latestFundActualChange = latestFundRow ? toNumber(latestFundRow.daily_change ?? latestFundRow.change ?? latestFundRow.dailyChange, null) : null;

  return {
    fundCode: code,
    code,
    fund: code,
    predictionDate,
    latestDate,
    latestFundPrice: latestPrice,
    latestFundActualChange: round(latestFundActualChange, 4),
    rawPredictedChange: round(rawPredictedChange, 4),
    predictedChange: round(finalPredictionChange, 4),
    calibratedChange: round(finalPredictionChange, 4),
    finalPredictionChange: round(finalPredictionChange, 4),
    currentPredictionChange: round(finalPredictionChange, 4),
    predictionDirection: signOf(finalPredictionChange),
    rangeLow: round(finalPredictionChange - rangeWidth, 4),
    rangeHigh: round(finalPredictionChange + rangeWidth, 4),
    expectedErrorBand: round(rangeWidth, 4),
    confidence: round(confidence, 2),
    confidenceText: confidenceText(confidence),
    coverage: round(coverage, 2),
    totalWeight: round(totalWeight, 4),
    stockWeight: round(stockWeight, 4),
    nonStockWeight: round(nonStockWeight, 4),
    pricedWeight: round(pricedWeight, 4),
    unresolvedWeight: round(unresolvedWeight, 4),
    holdingsReportDate: resolvedReportDate,
    detectedHoldingsReportDate: reportDate,
    officialHoldingsReportDate: OFFICIAL_HOLDINGS_REPORT_DATES[code] || null,
    holdingsFreshnessDays,
    holdingsFreshnessStatus: holdingsFreshnessDays === null ? "unknown" : holdingsFreshnessDays <= 15 ? "fresh" : holdingsFreshnessDays <= 45 ? "watch" : "stale",
    causalRawChange: round(causalRawChange, 4),
    stockSignal: round(stockSignal, 4),
    nonStockSignal: round(nonStockSignal, 4),
    residualFallback: round(residualFallback, 4),
    recentMomentum: round(recentMomentum, 4),
    beta: round(learning.beta, 4),
    calibrationOffset: round(learning.offset, 4),
    shockActive,
    shockMultiplier: round(shockMultiplier, 4),
    learningSampleSize: learning.sampleSize,
    sampleSize: learning.sampleSize,
    learningStatus: learning.learningStatus,
    recentAverageFundChange: round(historyStats.recentAverageChange, 4),
    latestFundChange: round(historyStats.latestChange, 4),
    averageAbsoluteError: round(learning.averageAbsoluteError, 4),
    directionHitRate: round(learning.directionHitRate, 2),
    issues,
    topPositiveContributors,
    topNegativeContributors,
    unresolvedHoldings,
    model: MODEL,
    modelKey: MODEL_KEY,
    modelVersion: MODEL_VERSION,
    source: "multi_asset_nav_engine",
    note: "v10.4 fon tahmini; hisse, nakit, repo, borçlanma aracı ve fiyatlanamayan kalemleri ayrı katmanlarda hesaplar. Tahmin yatırım tavsiyesi değildir."
  };
}

function schemaSafeHistoryRow(prediction, nowIso) {
  return {
    fund_code: prediction.fundCode,
    prediction_date: prediction.predictionDate,
    model: MODEL,
    predicted_change: round(prediction.finalPredictionChange, 4),
    actual_change: null,
    error_change: null,
    confidence: round(prediction.confidence, 2),
    created_at: nowIso,
    updated_at: nowIso,
    raw_predicted_change: round(prediction.rawPredictedChange, 4),
    calibrated_change: round(prediction.finalPredictionChange, 4),
    calibration_offset: round(prediction.calibrationOffset, 4),
    actual_price_date: null,
    sample_size: prediction.sampleSize || 0,
    model_version: MODEL_VERSION
  };
}

function parseMissingColumn(error) {
  const text = error?.message || "";
  const m1 = text.match(/Could not find the '([^']+)' column/i);
  if (m1) return m1[1];
  const m2 = text.match(/column "([^"]+)"/i);
  if (m2) return m2[1];
  return null;
}

async function upsertPredictionHistory(rows) {
  if (!rows.length) return { ok: true, saved: 0, attempted: 0, rows: [] };

  let columns = [...HISTORY_COLUMNS];
  const removedColumns = [];
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const payload = rows.map((row) => {
      const out = {};
      for (const col of columns) out[col] = row[col] === undefined ? null : row[col];
      return out;
    });

    try {
      const saved = await supabaseRequest("prediction_history?on_conflict=fund_code,prediction_date,model", {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=representation"
        },
        body: payload
      });

      return {
        ok: true,
        saved: Array.isArray(saved) ? saved.length : rows.length,
        attempted: rows.length,
        rows: saved || [],
        removedColumns
      };
    } catch (error) {
      lastError = error;
      const missing = parseMissingColumn(error);
      if (missing && columns.includes(missing)) {
        columns = columns.filter((c) => c !== missing);
        removedColumns.push(missing);
        continue;
      }
      break;
    }
  }

  return {
    ok: false,
    saved: 0,
    attempted: rows.length,
    removedColumns,
    error: lastError ? lastError.message : "Unknown Supabase upsert error"
  };
}

function compactPrediction(pred) {
  return {
    fundCode: pred.fundCode,
    code: pred.code,
    fund: pred.fund,
    predictionDate: pred.predictionDate,
    latestDate: pred.latestDate,
    latestFundPrice: pred.latestFundPrice,
    latestFundActualChange: pred.latestFundActualChange,
    predictedChange: pred.predictedChange,
    rawPredictedChange: pred.rawPredictedChange,
    calibratedChange: pred.calibratedChange,
    finalPredictionChange: pred.finalPredictionChange,
    currentPredictionChange: pred.currentPredictionChange,
    predictionDirection: pred.predictionDirection,
    rangeLow: pred.rangeLow,
    rangeHigh: pred.rangeHigh,
    expectedErrorBand: pred.expectedErrorBand,
    confidence: pred.confidence,
    confidenceText: pred.confidenceText,
    coverage: pred.coverage,
    stockWeight: pred.stockWeight,
    nonStockWeight: pred.nonStockWeight,
    unresolvedWeight: pred.unresolvedWeight,
    holdingsReportDate: pred.holdingsReportDate,
    detectedHoldingsReportDate: pred.detectedHoldingsReportDate,
    officialHoldingsReportDate: pred.officialHoldingsReportDate,
    holdingsFreshnessDays: pred.holdingsFreshnessDays,
    holdingsFreshnessStatus: pred.holdingsFreshnessStatus,
    causalRawChange: pred.causalRawChange,
    stockSignal: pred.stockSignal,
    nonStockSignal: pred.nonStockSignal,
    shockActive: pred.shockActive,
    shockMultiplier: pred.shockMultiplier,
    learningSampleSize: pred.learningSampleSize,
    sampleSize: pred.sampleSize,
    learningStatus: pred.learningStatus,
    averageAbsoluteError: pred.averageAbsoluteError,
    directionHitRate: pred.directionHitRate,
    issues: pred.issues,
    topPositiveContributors: pred.topPositiveContributors,
    topNegativeContributors: pred.topNegativeContributors,
    model: pred.model,
    modelKey: pred.modelKey,
    modelVersion: pred.modelVersion,
    source: pred.source,
    note: pred.note
  };
}

function buildSummary(predictions, saveResult, warnings) {
  const avgConfidence = avg(predictions.map((p) => p.confidence));
  const avgCoverage = avg(predictions.map((p) => p.coverage));
  const avgAbsPrediction = avg(predictions.map((p) => Math.abs(toNumber(p.finalPredictionChange, 0))));
  const strongSignals = predictions
    .filter((p) => Math.abs(toNumber(p.finalPredictionChange, 0)) >= 1.5)
    .map((p) => p.fundCode);
  const shockSignals = predictions.filter((p) => p.shockActive).map((p) => p.fundCode);

  return {
    totalFunds: predictions.length,
    saved: saveResult?.saved || 0,
    attempted: saveResult?.attempted || 0,
    averageConfidence: round(avgConfidence, 2),
    averageCoverage: round(avgCoverage, 2),
    averageAbsolutePrediction: round(avgAbsPrediction, 4),
    strongSignals,
    shockSignals,
    warningsCount: warnings.length,
    rule: "Multi Asset NAV: effectiveWeight / 100 * assetChange; stocks direct Yahoo price, non-stock assets typed proxy, then learned beta/offset/shock layer. TLY/THF official KAP portfolio report date anchors are applied for freshness.",
    targetAbsoluteError: TARGET_ABSOLUTE_ERROR
  };
}

module.exports = async function handler(req, res) {
  setCommonHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const warnings = [];
  const startedAt = Date.now();
  const nowIso = new Date().toISOString();
  const query = req.query || {};
  const manualAuthorized = query.manual === "finscope";
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const cronAuthorized = Boolean(process.env.CRON_SECRET && bearer && bearer === process.env.CRON_SECRET);
  const dryRun = query.dryRun === "1" || query.dryRun === "true";
  const shouldSave = !dryRun && (manualAuthorized || cronAuthorized || query.save === "1");
  const includeReport = query.report === "1" || query.debug === "1" || query.full === "1";

  try {
    const fundFilter = `in.(${FUND_ORDER.join(",")})`;

    const priceRows = await safeRead(
      `fund_prices?select=*&fund_code=${fundFilter}&order=price_date.desc,created_at.desc&limit=500`,
      [],
      warnings,
      "fund_prices"
    );

    const holdingRows = await safeRead(
      `fund_holdings?select=*&fund_code=${fundFilter}&limit=3000`,
      [],
      warnings,
      "fund_holdings"
    );

    const performanceRows = await safeRead(
      `prediction_performance?select=*&fund_code=${fundFilter}&model=eq.${encodeURIComponent(MODEL)}&order=prediction_date.desc&limit=300`,
      [],
      warnings,
      "prediction_performance"
    );

    const { latest, history } = latestFundPrices(priceRows);
    const latestFundDate = maxDate(Object.values(latest).map((row) => row && (row.price_date || row.date || row.created_at)));
    const predictionDate = query.date || query.predictionDate || nextBusinessDay(latestFundDate || new Date().toISOString().slice(0, 10));

    const { holdingsByFund, reportDates } = groupLatestHoldingsByFund(holdingRows);
    const { pricedHoldingsByFund, yahooSymbolsRequested } = await priceHoldings(holdingsByFund);

    const predictions = FUND_ORDER.map((code) =>
      buildPrediction({
        code,
        holdings: pricedHoldingsByFund[code] || [],
        latestFundRow: latest[code],
        priceHistory: history[code] || [],
        reportDate: reportDates[code] || null,
        predictionDate,
        performanceRows
      })
    );

    const historyPayload = predictions.map((prediction) => schemaSafeHistoryRow(prediction, nowIso));
    const saveResult = shouldSave ? await upsertPredictionHistory(historyPayload) : { ok: true, saved: 0, attempted: 0, dryRun: true };

    const responsePredictions = includeReport ? predictions : predictions.map(compactPrediction);

    sendJson(res, saveResult.ok ? 200 : 500, {
      ok: saveResult.ok,
      generatedAt: nowIso,
      version: API_VERSION,
      mode: includeReport ? "embedded_causal_nav_report" : "summary",
      endpoint: "/api/predict",
      model: MODEL,
      modelKey: MODEL_KEY,
      modelVersion: MODEL_VERSION,
      fundOrder: FUND_ORDER,
      predictionDate,
      latestFundDate,
      multiAssetNav: true,
      saveEnabled: shouldSave,
      dryRun: !shouldSave,
      yahooSymbolsRequested,
      officialHoldingsReportDates: OFFICIAL_HOLDINGS_REPORT_DATES,
      summary: buildSummary(predictions, saveResult, warnings),
      predictions: responsePredictions,
      rows: responsePredictions,
      saveResult,
      warnings,
      elapsedMs: Date.now() - startedAt,
      disclaimer: "Bu tahminler model bazlıdır, kesinlik içermez ve yatırım tavsiyesi değildir."
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      generatedAt: new Date().toISOString(),
      version: API_VERSION,
      model: MODEL,
      modelKey: MODEL_KEY,
      modelVersion: MODEL_VERSION,
      error: error.message,
      warnings,
      hint: "Supabase tablo kolonları veya harici fiyat kaynağı kontrol edilmeli. v10.4 yalnızca prediction_history için şema güvenli kolonları yazar."
    });
  }
};
