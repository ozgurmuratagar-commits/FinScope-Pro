/* api/predict.js
   FinScope Predict API v10.6 - Causal NAV Audit Gate
   Tam dosya degisimi icindir.
*/

const VERSION = "FinScope Predict API v10.6 - Causal NAV Audit Gate";
const MODEL_KEY = "v7_1_accuracy_layer";
const MODEL_VERSION = "FinScope Prediction Engine v10.6 - Causal NAV Audit Gate";
const SOURCE = "causal_nav_audit_gate_v10_6";

const FUND_ORDER = ["PBR", "PHE", "TLY", "THF"];

const OFFICIAL_HOLDINGS_REPORT_DATES = {
  PBR: "2026-07-31",
  PHE: "2026-08-07",
  TLY: "2026-08-07",
  THF: "2026-08-07",
};

function setJsonHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;

  let text = String(value).trim();
  if (!text) return fallback;

  text = text.replace(/%/g, "").replace(/\s/g, "");

  const hasComma = text.includes(",");
  const hasDot = text.includes(".");

  if (hasComma && hasDot) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  } else if (hasComma) {
    text = text.replace(",", ".");
  }

  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 4) {
  const number = parseNumber(value, null);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function clamp(value, min, max) {
  const number = parseNumber(value, 0);
  return Math.min(max, Math.max(min, number));
}

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
}

function normalizeDate(value) {
  if (!value) return null;
  const text = String(value).trim();

  const dmy = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;

  const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function turkeyDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const map = {};
  for (const part of parts) map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function daysBetween(a, b) {
  const dateA = normalizeDate(a);
  const dateB = normalizeDate(b);
  if (!dateA || !dateB) return null;
  const ms = Date.parse(`${dateB}T00:00:00Z`) - Date.parse(`${dateA}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

function direction(value) {
  const number = parseNumber(value, 0);
  if (number > 0.05) return "up";
  if (number < -0.05) return "down";
  return "flat";
}

function confidenceText(value) {
  const n = parseNumber(value, 0);
  if (n >= 75) return "Yuksek";
  if (n >= 55) return "Orta";
  if (n >= 35) return "Dusuk";
  return "Cok dusuk";
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL veya Supabase key environment variable eksik.");
  }

  return { url: url.replace(/\/$/, ""), key };
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = getSupabaseConfig();

  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
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
    throw new Error(`Supabase ${options.method || "GET"} ${path} HTTP ${response.status}: ${message}`);
  }

  return data;
}

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 FinScope/10.6",
        Accept: "application/json,text/plain,*/*",
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/^BIST:/, "")
    .replace(/^IST:/, "")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9.]/g, "");
}

function inferAssetType(row) {
  const raw = upper(
    firstDefined(
      row.asset_type,
      row.assetType,
      row.type,
      row.asset_class,
      row.assetClass,
      row.varlik_tipi,
      row.kind,
      ""
    )
  );

  const name = upper(firstDefined(row.name, row.asset_name, row.assetName, row.title, ""));
  const symbol = normalizeSymbol(firstDefined(row.symbol, row.code, row.ticker, row.asset_code, ""));
  const joined = `${raw} ${name} ${symbol}`;

  if (joined.includes("HISSE") || joined.includes("STOCK") || joined.includes("EQUITY")) return "stock";
  if (joined.includes("TAHVIL") || joined.includes("BONO") || joined.includes("BOND")) return "fixed_income";
  if (joined.includes("REPO") || joined.includes("TERSREPO")) return "repo";
  if (joined.includes("MEVDUAT") || joined.includes("DEPOSIT")) return "deposit";
  if (joined.includes("NAKIT") || joined.includes("CASH")) return "cash";
  if (joined.includes("FON") || joined.includes("FUND")) return "fund";
  if (joined.includes("VIOP") || joined.includes("FUTURE")) return "derivative";
  if (symbol.startsWith("TR") && symbol.length >= 10) return "fixed_income";

  if (/^[A-Z]{2,6}$/.test(symbol)) return "stock";
  return raw ? raw.toLowerCase() : "unknown";
}

function normalizeYahooSymbol(row, assetType) {
  const direct = normalizeSymbol(firstDefined(row.yahoo_symbol, row.yahooSymbol, row.yahoo, row.yf_symbol, null));
  if (direct) return direct;
  if (assetType !== "stock") return null;

  const symbol = normalizeSymbol(firstDefined(row.symbol, row.code, row.ticker, row.asset_code, null));
  if (!symbol) return null;
  if (symbol.includes(".")) return symbol;
  if (/^[A-Z]{2,6}$/.test(symbol)) return `${symbol}.IS`;
  return null;
}

function normalizeHolding(row) {
  const fundCode = upper(firstDefined(row.fund_code, row.fundCode, row.fund, row.fon_kodu, row.fon, null));
  if (!FUND_ORDER.includes(fundCode)) return null;

  const assetType = inferAssetType(row);
  const rawSymbol = normalizeSymbol(firstDefined(row.symbol, row.code, row.ticker, row.asset_code, ""));
  const yahooSymbol = normalizeYahooSymbol(row, assetType);
  const name = String(firstDefined(row.name, row.asset_name, row.assetName, row.title, rawSymbol, "")).trim();

  const rawWeight = parseNumber(
    firstDefined(
      row.weight,
      row.ratio,
      row.percentage,
      row.percent,
      row.portfolio_weight,
      row.portfolioWeight,
      row.rate,
      row.share,
      row.allocation,
      row.alloc,
      null
    ),
    null
  );

  if (rawWeight === null || rawWeight <= 0) return null;

  const reportDate = normalizeDate(
    firstDefined(
      row.report_date,
      row.reportDate,
      row.portfolio_date,
      row.portfolioDate,
      row.holding_date,
      row.holdingDate,
      row.date,
      row.period_date,
      row.periodDate,
      row.created_at,
      null
    )
  );

  return {
    fundCode,
    symbol: rawSymbol || yahooSymbol,
    yahooSymbol,
    name,
    assetType,
    rawWeight,
    reportDate,
  };
}

function selectHoldingsForFund(allHoldings, fundCode) {
  const rows = allHoldings.filter((row) => row.fundCode === fundCode);
  const officialDate = OFFICIAL_HOLDINGS_REPORT_DATES[fundCode] || null;

  let selected = [];
  let selectionRule = "latest_available_report_date";

  if (officialDate && rows.some((row) => row.reportDate === officialDate)) {
    selected = rows.filter((row) => row.reportDate === officialDate);
    selectionRule = "official_kap_report_date_anchor";
  } else {
    const dates = rows.map((row) => row.reportDate).filter(Boolean).sort();
    const latestDate = dates.length ? dates[dates.length - 1] : null;
    selected = latestDate ? rows.filter((row) => row.reportDate === latestDate) : rows;
  }

  return {
    fundCode,
    officialDate,
    selectedReportDate: selected[0]?.reportDate || null,
    selectionRule,
    rows: selected,
    allRows: rows,
  };
}

async function fetchFundPrices() {
  const path = `fund_prices?select=*&fund_code=in.(${FUND_ORDER.join(",")})&order=price_date.desc,created_at.desc&limit=300`;
  const rows = await supabaseRequest(path);
  const byFund = {};

  for (const fund of FUND_ORDER) {
    const fundRows = (rows || [])
      .filter((row) => upper(row.fund_code) === fund)
      .sort((a, b) => String(b.price_date || "").localeCompare(String(a.price_date || "")));

    const latest = fundRows[0] || null;
    const previous =
      fundRows.find((row) => normalizeDate(row.price_date) !== normalizeDate(latest?.price_date)) ||
      fundRows[1] ||
      null;

    const latestPrice = parseNumber(latest?.price, null);
    const previousPrice = parseNumber(previous?.price, null);
    let dailyChange = parseNumber(latest?.daily_change, null);

    if (dailyChange === null && latestPrice !== null && previousPrice !== null && previousPrice !== 0) {
      dailyChange = ((latestPrice - previousPrice) / previousPrice) * 100;
    }

    byFund[fund] = {
      fundCode: fund,
      price: latestPrice,
      priceDate: normalizeDate(latest?.price_date),
      previousPrice,
      previousPriceDate: normalizeDate(previous?.price_date),
      dailyChange: round(dailyChange, 4),
      rows: fundRows.slice(0, 8),
    };
  }

  return byFund;
}

async function fetchHoldings() {
  const rows = await supabaseRequest("fund_holdings?select=*&limit=10000");
  return (rows || []).map(normalizeHolding).filter(Boolean);
}

async function fetchPerformanceRows() {
  try {
    const path = `prediction_performance?select=fund_code,final_prediction_change,actual_change,error_change,status,prediction_date&model=eq.${MODEL_KEY}&fund_code=in.(${FUND_ORDER.join(",")})&order=prediction_date.desc&limit=300`;
    return await supabaseRequest(path);
  } catch (_) {
    return [];
  }
}

function buildLearningStats(performanceRows) {
  const result = {};

  for (const fund of FUND_ORDER) {
    const pairs = (performanceRows || [])
      .filter((row) => upper(row.fund_code) === fund)
      .map((row) => ({
        predicted: parseNumber(row.final_prediction_change, null),
        actual: parseNumber(row.actual_change, null),
        error: parseNumber(row.error_change, null),
        status: row.status || null,
      }))
      .filter((row) => row.predicted !== null && row.actual !== null)
      .slice(0, 40);

    const reliable = pairs.filter((row) => Math.abs(row.predicted) <= 35 && Math.abs(row.actual) <= 35);
    const sample = reliable.length;

    if (!sample) {
      result[fund] = {
        sampleSize: 0,
        beta: 1,
        averageError: 0,
        averageAbsoluteError: null,
        directionHitRate: null,
        shockRows: 0,
      };
      continue;
    }

    const meanX = reliable.reduce((sum, row) => sum + row.predicted, 0) / sample;
    const meanY = reliable.reduce((sum, row) => sum + row.actual, 0) / sample;
    const covariance = reliable.reduce((sum, row) => sum + (row.predicted - meanX) * (row.actual - meanY), 0) / sample;
    const variance = reliable.reduce((sum, row) => sum + (row.predicted - meanX) ** 2, 0) / sample;
    const beta = variance > 0.01 ? covariance / variance : 1;
    const errors = reliable.map((row) => row.actual - row.predicted);
    const avgError = errors.reduce((sum, value) => sum + value, 0) / sample;
    const avgAbsError = errors.reduce((sum, value) => sum + Math.abs(value), 0) / sample;
    const directionHits = reliable.filter((row) => direction(row.predicted) === direction(row.actual)).length;
    const shockRows = reliable.filter((row) => Math.abs(row.actual) >= 6 || row.status === "shock_closed").length;

    result[fund] = {
      sampleSize: sample,
      beta: round(clamp(beta, 0.35, 1.85), 4),
      averageError: round(avgError, 4),
      averageAbsoluteError: round(avgAbsError, 4),
      directionHitRate: round((directionHits / sample) * 100, 2),
      shockRows,
    };
  }

  return result;
}

async function fetchYahooQuotes(symbols) {
  const unique = Array.from(new Set(symbols.filter(Boolean))).slice(0, 180);
  const quotes = {};
  const chunks = chunkArray(unique, 45);

  for (const chunk of chunks) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(","))}`;

    try {
      const json = await fetchWithTimeout(url, 9000);
      const rows = json?.quoteResponse?.result || [];

      for (const item of rows) {
        const symbol = normalizeSymbol(item.symbol);
        const price = parseNumber(item.regularMarketPrice, null);
        const previous = parseNumber(
          firstDefined(item.regularMarketPreviousClose, item.regularMarketOpen, item.previousClose, null),
          null
        );

        let change = parseNumber(item.regularMarketChangePercent, null);

        if (change === null && price !== null && previous !== null && previous !== 0) {
          change = ((price - previous) / previous) * 100;
        }

        if (symbol && change !== null) {
          quotes[symbol] = {
            symbol,
            price: round(price, 4),
            previous: round(previous, 4),
            change: round(change, 4),
            source: "Yahoo Finance quote",
          };
        }
      }
    } catch (_) {
      // Batch hata verirse ilgili semboller cozumsuz kalir; API dusmez.
    }
  }

  return quotes;
}

function buildAuditForFund({ fundCode, selectedHoldings, priceInfo, quoteMap, learningStats, targetDate }) {
  const rows = selectedHoldings.rows || [];
  const totalRawWeight = rows.reduce((sum, row) => sum + row.rawWeight, 0);
  const denominator = totalRawWeight > 0 ? totalRawWeight : 100;
  const officialDate = selectedHoldings.officialDate || null;
  const reportDate = selectedHoldings.selectedReportDate || null;
  const freshnessDays = daysBetween(reportDate, targetDate);

  const normalizedRows = rows.map((row) => {
    const effectiveWeight = (row.rawWeight / denominator) * 100;
    const quote = row.yahooSymbol ? quoteMap[normalizeSymbol(row.yahooSymbol)] || null : null;
    const priced = row.assetType === "stock" && quote && parseNumber(quote.change, null) !== null;
    const contribution = priced ? (effectiveWeight * quote.change) / 100 : 0;

    return {
      ...row,
      effectiveWeight: round(effectiveWeight, 4),
      priced,
      price: quote?.price ?? null,
      previous: quote?.previous ?? null,
      marketChange: quote?.change ?? null,
      pricingSource: quote?.source ?? null,
      contribution: round(contribution, 4),
    };
  });

  const stockRows = normalizedRows.filter((row) => row.assetType === "stock");
  const pricedRows = normalizedRows.filter((row) => row.priced);
  const unresolvedStockRows = stockRows.filter((row) => !row.priced);
  const nonStockRows = normalizedRows.filter((row) => row.assetType !== "stock");

  const stockWeight = stockRows.reduce((sum, row) => sum + row.effectiveWeight, 0);
  const pricedWeight = pricedRows.reduce((sum, row) => sum + row.effectiveWeight, 0);
  const unresolvedStockWeight = unresolvedStockRows.reduce((sum, row) => sum + row.effectiveWeight, 0);
  const nonStockWeight = nonStockRows.reduce((sum, row) => sum + row.effectiveWeight, 0);
  const rawContribution = pricedRows.reduce((sum, row) => sum + row.contribution, 0);

  const learning = learningStats[fundCode] || {};
  const sampleSize = parseNumber(learning.sampleSize, 0);
  const beta = sampleSize >= 8 ? clamp(learning.beta ?? 1, 0.45, 1.65) : 1;
  const calibrationOffset = sampleSize >= 8 ? clamp((learning.averageError || 0) * 0.25, -1.25, 1.25) : 0;

  const lowCoveragePenalty = pricedWeight < 55 ? clamp((55 - pricedWeight) / 55, 0, 1) : 0;
  const coverageMultiplier = 1 - lowCoveragePenalty * 0.35;

  const rawPredictedChange = round(rawContribution, 4);
  let calibratedChange = rawContribution * beta * coverageMultiplier + calibrationOffset;

  const dynamicCap = pricedWeight >= 75 ? 18 : pricedWeight >= 55 ? 12 : pricedWeight >= 35 ? 7 : 4;
  calibratedChange = clamp(calibratedChange, -dynamicCap, dynamicCap);

  const latestFundActualChange = parseNumber(priceInfo?.dailyChange, null);
  const recentCausalGap =
    latestFundActualChange !== null ? round(latestFundActualChange - rawPredictedChange, 4) : null;

  const issues = [];

  if (!rows.length) issues.push("no_holdings_rows");
  if (pricedWeight < 35) issues.push("very_low_direct_price_coverage");
  else if (pricedWeight < 55) issues.push("low_direct_price_coverage");
  if (unresolvedStockWeight > 15) issues.push("unpriced_stock_weight_high");
  if (nonStockWeight > 40) issues.push("non_stock_weight_high");
  if (freshnessDays !== null && freshnessDays > 45) issues.push("holdings_report_older_than_45_days");

  if (recentCausalGap !== null && Math.abs(recentCausalGap) > 5 && pricedWeight >= 35) {
    issues.push("recent_fund_move_not_explained_by_priced_holdings");
  }

  let confidence = 15;
  confidence += pricedWeight * 0.55;
  confidence += Math.min(sampleSize, 20) * 1.2;
  confidence -= unresolvedStockWeight * 0.25;
  confidence -= nonStockWeight > 45 ? 8 : 0;
  confidence -= freshnessDays !== null && freshnessDays > 45 ? 10 : 0;
  confidence -= recentCausalGap !== null ? Math.min(Math.abs(recentCausalGap) * 1.2, 18) : 0;
  confidence -= Math.abs(calibratedChange) > 10 ? 5 : 0;
  confidence = round(clamp(confidence, 5, 95), 2);

  const range = Math.max(0.35, (learning.averageAbsoluteError || 1.25) * (confidence < 55 ? 1.35 : 1));

  const topPositiveContributors = pricedRows
    .filter((row) => row.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 10)
    .map((row) => ({
      symbol: row.symbol,
      yahooSymbol: row.yahooSymbol,
      name: row.name,
      weight: row.effectiveWeight,
      marketChange: row.marketChange,
      contribution: row.contribution,
    }));

  const topNegativeContributors = pricedRows
    .filter((row) => row.contribution < 0)
    .sort((a, b) => a.contribution - b.contribution)
    .slice(0, 10)
    .map((row) => ({
      symbol: row.symbol,
      yahooSymbol: row.yahooSymbol,
      name: row.name,
      weight: row.effectiveWeight,
      marketChange: row.marketChange,
      contribution: row.contribution,
    }));

  const unresolvedRows = unresolvedStockRows
    .sort((a, b) => b.effectiveWeight - a.effectiveWeight)
    .slice(0, 20)
    .map((row) => ({
      symbol: row.symbol,
      yahooSymbol: row.yahooSymbol,
      name: row.name,
      weight: row.effectiveWeight,
      issue: row.yahooSymbol ? "not_priced" : "no_yahoo_symbol",
    }));

  const nonStockTopRows = nonStockRows
    .sort((a, b) => b.effectiveWeight - a.effectiveWeight)
    .slice(0, 12)
    .map((row) => ({
      symbol: row.symbol,
      name: row.name,
      assetType: row.assetType,
      weight: row.effectiveWeight,
    }));

  const prediction = round(calibratedChange, 4);

  return {
    fundCode,
    code: fundCode,
    fund: fundCode,
    predictionDate: targetDate,
    model: MODEL_VERSION,
    modelKey: MODEL_KEY,
    modelVersion: MODEL_VERSION,
    source: SOURCE,

    officialHoldingsReportDate: officialDate,
    holdingsReportDate: reportDate,
    holdingsSelectionRule: selectedHoldings.selectionRule,
    holdingsFreshnessDays: freshnessDays,

    totalHoldingRows: rows.length,
    totalRawWeight: round(totalRawWeight, 4),
    stockWeight: round(stockWeight, 4),
    nonStockWeight: round(nonStockWeight, 4),
    pricedWeight: round(pricedWeight, 4),
    coverage: round(pricedWeight, 2),
    unresolvedWeight: round(unresolvedStockWeight + Math.max(0, 100 - stockWeight - nonStockWeight), 4),

    rawPredictedChange,
    predictedChange: prediction,
    finalPredictionChange: prediction,
    calibratedChange: prediction,
    calibrationOffset: round(calibrationOffset, 4),
    beta: round(beta, 4),
    coverageMultiplier: round(coverageMultiplier, 4),

    predictionDirection: direction(prediction),
    rangeLow: round(prediction - range, 4),
    rangeHigh: round(prediction + range, 4),

    confidence,
    confidenceText: confidenceText(confidence),

    latestFundPrice: priceInfo?.price ?? null,
    latestFundPriceDate: priceInfo?.priceDate ?? null,
    latestFundActualChange,
    recentCausalGap,

    issues,
    auditStatus: confidence >= 70 && issues.length <= 1 ? "causal_ready" : "watch",
    learningStats: learning,

    causalNavAudit: {
      principle:
        "Fon tahmini = fiyatlanan portfoy varlik agirligi x varlik piyasa degisimi. Aciklanamayan kisim guven puanini dusurur.",
      stockContribution: rawPredictedChange,
      pricedStockWeight: round(pricedWeight, 4),
      unresolvedStockWeight: round(unresolvedStockWeight, 4),
      nonStockWeight: round(nonStockWeight, 4),
      recentFundMove: latestFundActualChange,
      recentCausalGap,
      topPositiveContributors,
      topNegativeContributors,
      unresolvedRows,
      nonStockTopRows,
    },
  };
}

function buildHistoryPayload(predictions, nowIso) {
  return predictions.map((prediction) => ({
    fund_code: prediction.fundCode,
    prediction_date: prediction.predictionDate,
    model: MODEL_KEY,
    predicted_change: prediction.predictedChange,
    actual_change: null,
    error_change: null,
    confidence: prediction.confidence,
    coverage: prediction.coverage,
    residual_weight: prediction.unresolvedWeight,
    source: SOURCE,
    created_at: nowIso,
    updated_at: nowIso,
    raw_predicted_change: prediction.rawPredictedChange,
    calibrated_change: prediction.calibratedChange,
    calibration_offset: prediction.calibrationOffset,
    actual_price_date: null,
    sample_size: prediction.learningStats?.sampleSize || 0,
    model_version: MODEL_VERSION,
  }));
}

async function savePredictionHistory(predictions) {
  const nowIso = new Date().toISOString();
  const payload = buildHistoryPayload(predictions, nowIso);

  if (!payload.length) return { ok: true, saved: 0, rows: [] };

  const path = "prediction_history?on_conflict=fund_code,prediction_date,model";

  const rows = await supabaseRequest(path, {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(payload),
  });

  return {
    ok: true,
    saved: Array.isArray(rows) ? rows.length : payload.length,
    rows,
  };
}

function summarize(predictions) {
  const averageConfidence = predictions.length
    ? predictions.reduce((sum, row) => sum + parseNumber(row.confidence, 0), 0) / predictions.length
    : 0;

  const averageCoverage = predictions.length
    ? predictions.reduce((sum, row) => sum + parseNumber(row.coverage, 0), 0) / predictions.length
    : 0;

  const watchCount = predictions.filter((row) => row.auditStatus !== "causal_ready").length;

  const strongSignals = predictions
    .filter((row) => Math.abs(row.predictedChange) >= 1 && row.confidence >= 55)
    .map((row) => row.fundCode);

  return {
    funds: FUND_ORDER,
    totalFunds: predictions.length,
    averageConfidence: round(averageConfidence, 2),
    averageCoverage: round(averageCoverage, 2),
    watchCount,
    strongSignals,
    rule:
      "Tahmin, fiyatlanan portfoy varliklarinin agirlikli piyasa degisiminden uretilir; aciklanamayan son fon hareketi guveni dusurur.",
  };
}

module.exports = async function handler(req, res) {
  setJsonHeaders(res);

  if (req.method === "OPTIONS") return res.status(200).end();

  const startedAt = Date.now();
  const query = req.query || {};
  const targetDate = normalizeDate(query.date) || turkeyDateString();

  const reportMode = query.report === "1" || query.audit === "1";
  const manualAuthorized = query.manual === "finscope";
  const cronAuthorized =
    process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;

  const authorized = Boolean(manualAuthorized || cronAuthorized);
  const dryRun = query.dryRun === "1" || query.dryrun === "1" || !authorized;

  try {
    const [fundPrices, rawHoldings, performanceRows] = await Promise.all([
      fetchFundPrices(),
      fetchHoldings(),
      fetchPerformanceRows(),
    ]);

    const selectedByFund = {};
    const symbols = [];

    for (const fund of FUND_ORDER) {
      const selected = selectHoldingsForFund(rawHoldings, fund);
      selectedByFund[fund] = selected;

      for (const row of selected.rows) {
        if (row.assetType === "stock" && row.yahooSymbol) symbols.push(row.yahooSymbol);
      }
    }

    const quoteMap = await fetchYahooQuotes(symbols);
    const learningStats = buildLearningStats(performanceRows);

    const predictions = FUND_ORDER.map((fundCode) =>
      buildAuditForFund({
        fundCode,
        selectedHoldings: selectedByFund[fundCode],
        priceInfo: fundPrices[fundCode],
        quoteMap,
        learningStats,
        targetDate,
      })
    );

    let saveResult = {
      ok: true,
      saved: 0,
      dryRun: true,
      reason: "not_authorized_or_dry_run",
    };

    if (!dryRun) {
      saveResult = await savePredictionHistory(predictions);
    }

    const predictionsByFund = Object.fromEntries(predictions.map((row) => [row.fundCode, row]));

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      version: VERSION,
      mode: reportMode ? "embedded_causal_nav_audit" : "prediction",
      endpoint: "/api/predict",
      model: MODEL_VERSION,
      modelKey: MODEL_KEY,
      modelVersion: MODEL_VERSION,
      targetDate,
      virtualEnabled: false,
      saveEnabled: !dryRun,
      dryRun,
      authorized,

      officialHoldingsReportDates: OFFICIAL_HOLDINGS_REPORT_DATES,
      summary: summarize(predictions),
      predictions: predictionsByFund,
      rows: predictions,
      saveResult,

      diagnostics: {
        requestedFunds: FUND_ORDER,
        totalHoldingRows: rawHoldings.length,
        pricedSymbolsRequested: Array.from(new Set(symbols)).length,
        pricedSymbolsFound: Object.keys(quoteMap).length,
        performanceRows: performanceRows.length,
        elapsedMs: Date.now() - startedAt,
        schemaSafeColumns: Object.keys(buildHistoryPayload(predictions, new Date().toISOString())[0] || {}),
      },

      disclaimer: "Bu tahminler model bazlidir, kesinlik icermez ve yatirim tavsiyesi degildir.",
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      generatedAt: new Date().toISOString(),
      version: VERSION,
      model: MODEL_VERSION,
      modelKey: MODEL_KEY,
      error: error.message || String(error),
      note:
        "v10.6 schema-safe yazilmistir; prediction_history tablosuna sadece mevcut kolonlar gonderilir.",
    });
  }
};
