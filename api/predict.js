const FUNDS = ["PBR", "PHE", "TLY"];

const MODEL_NAME = "FinScope Prediction Engine v8.1 - Data Quality + Fund Bias Correction";
const MODEL_KEY = "v7_1_accuracy_layer";
const TARGET_ABSOLUTE_ERROR = 0.10;
const MIN_VALID_FUND_PRICE = 0;
const MAX_ABSOLUTE_ACTUAL_CHANGE = 20;
const MAX_ABSOLUTE_LEARNING_ERROR = 20;
const MAX_ABSOLUTE_PREDICTION_CHANGE = 20;
const MIN_DIRECTION_SIGNAL = 0.01;

const STOCK_SYMBOL_MAP = {
  XU100: "XU100.IS",
  XU050: "XU050.IS",
  XU030: "XU030.IS",
  USDTRY: "USDTRY=X",
  EURTRY: "EURTRY=X",
  GBPTRY: "GBPTRY=X",
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  DXY: "DX-Y.NYB",
  XAU: "GC=F",
  XAG: "SI=F",
  BRENT: "BZ=F",
  BTCUSD: "BTC-USD"
};

function num(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = num(value, null);
  if (n === null) return null;
  return Number(n.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function todayTR() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  return formatter.format(new Date());
}

function parseDateUTC(dateText) {
  if (!dateText || !/^\d{4}-\d{2}-\d{2}/.test(String(dateText))) return null;
  const d = new Date(String(dateText).slice(0, 10) + "T12:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function diffDays(fromDateText, toDateText) {
  const from = parseDateUTC(fromDateText);
  const to = parseDateUTC(toDateText);
  if (!from || !to) return null;

  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / dayMs));
}

function nextBusinessDay(dateText) {
  const d = parseDateUTC(dateText) || parseDateUTC(todayTR());

  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);

  return d.toISOString().slice(0, 10);
}

function isWeekend(dateText) {
  const d = parseDateUTC(dateText);
  if (!d) return false;

  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function choosePredictionDate(latestFundDate) {
  const trToday = todayTR();

  if (latestFundDate && latestFundDate >= trToday) {
    return nextBusinessDay(latestFundDate);
  }

  if (latestFundDate && latestFundDate < trToday) {
    if (isWeekend(trToday)) {
      return nextBusinessDay(latestFundDate);
    }

    return trToday;
  }

  return trToday;
}

function direction(value) {
  const n = num(value, 0);
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function confidenceText(score) {
  const s = num(score, 0);
  if (s >= 90) return "Çok yüksek";
  if (s >= 80) return "Yüksek";
  if (s >= 70) return "Orta";
  return "Düşük";
}

function isValidFundPrice(row) {
  const price = num(row && row.price, null);
  return price !== null && price > MIN_VALID_FUND_PRICE;
}

function isValidActualChange(value) {
  const actual = num(value, null);
  return actual !== null && Math.abs(actual) <= MAX_ABSOLUTE_ACTUAL_CHANGE;
}

function fundPriceQuality(row, expectedDate = null) {
  const issues = [];

  if (!row) {
    return {
      ok: false,
      issues: ["fund_price_missing"],
      price: null,
      dailyChange: null,
      priceDate: null
    };
  }

  const price = num(row.price, null);
  const dailyChange = num(row.daily_change, null);
  const priceDate = row.price_date || row.date || null;

  if (expectedDate && String(priceDate || "").slice(0, 10) !== String(expectedDate).slice(0, 10)) {
    issues.push("price_date_mismatch");
  }

  if (price === null || price <= MIN_VALID_FUND_PRICE) {
    issues.push("price_invalid_or_zero");
  }

  if (dailyChange === null) {
    issues.push("daily_change_missing");
  } else if (Math.abs(dailyChange) > MAX_ABSOLUTE_ACTUAL_CHANGE) {
    issues.push("daily_change_out_of_range");
  }

  return {
    ok: issues.length === 0,
    issues,
    price,
    dailyChange,
    priceDate: priceDate ? String(priceDate).slice(0, 10) : null
  };
}

function isReliablePerformanceRow(row) {
  if (!row) return false;

  const actualChange = num(row.actual_change, null);
  const absoluteError = num(row.absolute_error, null);
  const errorChange = getPerformanceError(row);
  const predicted = getPerformancePrediction(row);
  const actualPrice = num(row.actual_price, null);
  const predictionDate = row.prediction_date ? String(row.prediction_date).slice(0, 10) : null;
  const actualPriceDate = row.actual_price_date ? String(row.actual_price_date).slice(0, 10) : null;

  if (row.status && row.status !== "closed") return false;
  if (actualChange === null || Math.abs(actualChange) > MAX_ABSOLUTE_ACTUAL_CHANGE) return false;
  if (predicted === null || Math.abs(predicted) > MAX_ABSOLUTE_PREDICTION_CHANGE) return false;
  if (errorChange === null || Math.abs(errorChange) > MAX_ABSOLUTE_LEARNING_ERROR) return false;
  if (absoluteError !== null && Math.abs(absoluteError) > MAX_ABSOLUTE_LEARNING_ERROR) return false;
  if (actualPrice !== null && actualPrice <= MIN_VALID_FUND_PRICE) return false;
  if (predictionDate && actualPriceDate && predictionDate !== actualPriceDate) return false;

  return true;
}

function isReliablePredictionHistoryRow(row) {
  if (!row) return false;

  const actualChange = num(row.actual_change, null);
  const predicted = getPerformancePrediction(row);
  const errorChange = getPerformanceError(row);

  if (actualChange === null || Math.abs(actualChange) > MAX_ABSOLUTE_ACTUAL_CHANGE) return false;
  if (predicted === null || Math.abs(predicted) > MAX_ABSOLUTE_PREDICTION_CHANGE) return false;
  if (errorChange === null || Math.abs(errorChange) > MAX_ABSOLUTE_LEARNING_ERROR) return false;

  return true;
}

function qualityNoteFromIssues(issues) {
  if (!issues || !issues.length) return "Veri kalite kontrolünden geçti.";
  return "Veri kalite kontrolü engelledi: " + issues.join(", ");
}

function normalizeSymbol(symbol) {
  if (!symbol) return "";

  const s = String(symbol).trim().toUpperCase();

  if (STOCK_SYMBOL_MAP[s]) return STOCK_SYMBOL_MAP[s];

  if (
    s.includes("=") ||
    s.includes("-") ||
    s.endsWith(".IS") ||
    s.endsWith(".NYB")
  ) {
    return s;
  }

  return s + ".IS";
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL veya Supabase key eksik.");
  }

  return { url, key };
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = getSupabaseConfig();

  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${options.method || "GET"} ${path} HTTP ${response.status}: ${text.slice(0, 900)}`
    );
  }

  if (!text) return [];
  return JSON.parse(text);
}

async function optionalSupabaseRequest(path, fallback = []) {
  try {
    const rows = await supabaseRequest(path);
    return Array.isArray(rows) ? rows : fallback;
  } catch {
    return fallback;
  }
}

async function getLatestFundPrices() {
  const rows = await supabaseRequest(
    "fund_prices?select=*&fund_code=in.(PBR,PHE,TLY)&order=price_date.desc,created_at.desc&limit=120"
  );

  const latest = {};
  const quality = {};

  for (const code of FUNDS) {
    quality[code] = {
      selected: null,
      selectedQuality: null,
      firstRawDate: null,
      firstRawQuality: null,
      skippedInvalidRows: 0,
      selectionRule: "latest_reliable_fund_price"
    };
  }

  for (const row of rows || []) {
    const code = row.fund_code;
    if (!FUNDS.includes(code)) continue;

    const q = fundPriceQuality(row);

    if (!quality[code].firstRawDate) {
      quality[code].firstRawDate = row.price_date || row.date || null;
      quality[code].firstRawQuality = q;
    }

    if (!q.ok) {
      quality[code].skippedInvalidRows += 1;
      continue;
    }

    if (!latest[code]) {
      latest[code] = row;
      quality[code].selected = {
        priceDate: row.price_date || row.date || null,
        price: row.price ?? null,
        dailyChange: row.daily_change ?? null,
        updatedAt: row.updated_at || row.created_at || null
      };
      quality[code].selectedQuality = q;
    }
  }

  Object.defineProperty(latest, "__quality", {
    value: quality,
    enumerable: false,
    configurable: true
  });

  return latest;
}

function holdingKey(row) {
  return [
    String(row.fund_code || "").trim().toUpperCase(),
    String(row.asset_type || "").trim().toUpperCase(),
    String(row.symbol || "").trim().toUpperCase(),
    String(row.name || "").trim().toUpperCase(),
    String(row.report_date || "").slice(0, 10)
  ].join("|");
}

function normalizeHoldingRows(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const key = holdingKey(row);
    const existing = map.get(key);

    if (!existing) {
      map.set(key, {
        ...row,
        weight: num(row.weight, 0)
      });
      continue;
    }

    existing.weight = num(existing.weight, 0) + num(row.weight, 0);
  }

  return Array.from(map.values()).sort((a, b) => num(b.weight, 0) - num(a.weight, 0));
}

async function getHoldings() {
  const rows = await supabaseRequest(
    "fund_holdings?select=*&fund_code=in.(PBR,PHE,TLY)&order=fund_code.asc,report_date.desc,weight.desc"
  );

  const grouped = {};
  const meta = {};

  for (const code of FUNDS) {
    grouped[code] = [];
    meta[code] = {
      selectedReportDate: null,
      rawRows: 0,
      selectedRows: 0,
      totalWeight: 0,
      selectionRule: "latest_report_date_per_fund"
    };
  }

  for (const code of FUNDS) {
    const fundRows = (rows || []).filter(row => row.fund_code === code);
    const reportDates = fundRows
      .map(row => row.report_date)
      .filter(Boolean)
      .map(value => String(value).slice(0, 10))
      .sort((a, b) => String(b).localeCompare(String(a)));

    const selectedReportDate = reportDates[0] || null;

    const selectedRows = selectedReportDate
      ? fundRows.filter(row => String(row.report_date || "").slice(0, 10) === selectedReportDate)
      : fundRows;

    const normalized = normalizeHoldingRows(selectedRows);

    grouped[code] = normalized;

    meta[code] = {
      selectedReportDate,
      rawRows: fundRows.length,
      selectedRows: normalized.length,
      totalWeight: round(
        normalized.reduce((sum, row) => sum + num(row.weight, 0), 0),
        4
      ),
      selectionRule: selectedReportDate
        ? "only_latest_report_date_per_fund"
        : "no_report_date_found_all_rows_used"
    };
  }

  return { grouped, meta };
}

async function fetchYahooChange(symbol) {
  const yahooSymbol = normalizeSymbol(symbol);
  if (!yahooSymbol) return null;

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSymbol) +
    "?range=5d&interval=1d";

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 FinScope/1.0"
      }
    });

    if (!response.ok) return null;

    const json = await response.json();
    const result = json.chart && json.chart.result && json.chart.result[0];

    if (!result) return null;

    const meta = result.meta || {};
    const current = num(meta.regularMarketPrice);
    const previous = num(meta.chartPreviousClose);

    if (current !== null && previous !== null && previous !== 0) {
      return {
        symbol: yahooSymbol,
        price: current,
        previous,
        change: ((current - previous) / previous) * 100,
        source: "Yahoo Finance"
      };
    }

    const closes =
      result.indicators &&
      result.indicators.quote &&
      result.indicators.quote[0] &&
      result.indicators.quote[0].close
        ? result.indicators.quote[0].close.filter(v => v !== null && v !== undefined)
        : [];

    if (closes.length >= 2) {
      const last = num(closes[closes.length - 1]);
      const prev = num(closes[closes.length - 2]);

      if (last !== null && prev !== null && prev !== 0) {
        return {
          symbol: yahooSymbol,
          price: last,
          previous: prev,
          change: ((last - prev) / prev) * 100,
          source: "Yahoo Finance"
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function getMarketChangesForHoldings(groupedHoldings) {
  const symbols = new Set();

  for (const code of FUNDS) {
    for (const h of groupedHoldings[code] || []) {
      const assetType = String(h.asset_type || "").toUpperCase();

      if (assetType === "STOCK") {
        symbols.add(h.symbol);
      }
    }
  }

  [
    "XU100",
    "XU050",
    "XU030",
    "USDTRY",
    "EURTRY",
    "GBPTRY",
    "EURUSD",
    "GBPUSD",
    "DXY",
    "XAU",
    "XAG",
    "BRENT",
    "BTCUSD"
  ].forEach(symbol => symbols.add(symbol));

  const list = Array.from(symbols).filter(Boolean);
  const results = {};

  await Promise.all(
    list.map(async symbol => {
      const normalized = normalizeSymbol(symbol);
      const data = await fetchYahooChange(symbol);

      results[symbol] = data;
      if (normalized) results[normalized] = data;
    })
  );

  return results;
}

function marketChangeValue(marketChanges, key, fallback = 0) {
  const direct = marketChanges[key];
  const normalized = marketChanges[normalizeSymbol(key)];
  const data = direct || normalized;

  return data && num(data.change) !== null ? num(data.change, fallback) : fallback;
}

function proxyChangeForNonStock(assetType, symbol, marketChanges) {
  const type = String(assetType || "").toUpperCase();
  const sym = String(symbol || "").toUpperCase();

  if (type.includes("MONEY") || sym.includes("REPO") || sym.includes("PARA")) {
    return 0.11;
  }

  if (type.includes("CASH") || sym === "TRY" || sym.includes("NAKIT")) {
    return 0;
  }

  if (type.includes("BOND") || type.includes("DEBT") || sym.includes("TAHVIL") || sym.includes("BONO")) {
    return 0.04;
  }

  if (type.includes("GOLD") || sym.includes("ALTIN") || sym.includes("XAU")) {
    return marketChangeValue(marketChanges, "XAU", 0);
  }

  if (type.includes("SILVER") || sym.includes("GUMUS") || sym.includes("GÜMÜŞ") || sym.includes("XAG")) {
    return marketChangeValue(marketChanges, "XAG", 0);
  }

  if (type.includes("FX") || type.includes("CURRENCY") || sym.includes("USD")) {
    return marketChangeValue(marketChanges, "USDTRY", 0);
  }

  if (sym.includes("EUR")) {
    return marketChangeValue(marketChanges, "EURTRY", marketChangeValue(marketChanges, "USDTRY", 0));
  }

  if (sym.includes("GBP")) {
    return marketChangeValue(marketChanges, "GBPTRY", marketChangeValue(marketChanges, "USDTRY", 0));
  }

  return 0;
}

function getHoldingMarketChange(holding, marketChanges) {
  const assetType = String(holding.asset_type || "").toUpperCase();
  const symbol = String(holding.symbol || "").trim();

  if (assetType === "STOCK") {
    const direct = marketChanges[symbol];
    const normalized = marketChanges[normalizeSymbol(symbol)];
    const data = direct || normalized;

    if (data && num(data.change) !== null) {
      return {
        marketChange: num(data.change, 0),
        directPricing: true,
        pricingSource: `${data.source} • ${data.symbol}`
      };
    }

    const bist = marketChanges.XU100 || marketChanges["XU100.IS"];

    if (bist && num(bist.change) !== null) {
      return {
        marketChange: num(bist.change, 0),
        directPricing: false,
        pricingSource: "BIST 100 proxy"
      };
    }

    return {
      marketChange: 0,
      directPricing: false,
      pricingSource: "stock fallback"
    };
  }

  return {
    marketChange: proxyChangeForNonStock(assetType, symbol, marketChanges),
    directPricing: false,
    pricingSource: "non-stock proxy"
  };
}

async function getPerformanceRows() {
  const rows = await optionalSupabaseRequest(
    "prediction_performance?select=*&fund_code=in.(PBR,PHE,TLY)&model=eq." +
      encodeURIComponent(MODEL_KEY) +
      "&status=eq.closed&order=closed_at.desc,created_at.desc&limit=300",
    []
  );

  const reliable = (rows || []).filter(isReliablePerformanceRow);

  Object.defineProperty(reliable, "__rawCount", {
    value: Array.isArray(rows) ? rows.length : 0,
    enumerable: false,
    configurable: true
  });

  return reliable;
}

async function getModelLearningStats() {
  const rows = await optionalSupabaseRequest(
    "model_learning_stats?select=*&fund_code=in.(PBR,PHE,TLY)&model=eq." +
      encodeURIComponent(MODEL_KEY) +
      "&order=calculated_at.desc,updated_at.desc&limit=120",
    []
  );

  const latest = {};

  for (const row of rows || []) {
    if (!latest[row.fund_code]) {
      latest[row.fund_code] = row;
    }
  }

  return latest;
}

async function getFallbackCalibrationRows() {
  const rows = await optionalSupabaseRequest(
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY)&model=eq." +
      encodeURIComponent(MODEL_KEY) +
      "&actual_change=not.is.null&error_change=not.is.null&order=updated_at.desc,created_at.desc&limit=240",
    []
  );

  const reliableRows = (rows || []).filter(isReliablePredictionHistoryRow);
  const byFund = {};

  for (const code of FUNDS) {
    byFund[code] = reliableRows.filter(r => r.fund_code === code);
  }

  return byFund;
}

function calculateDirectionHitFromValues(predicted, actual) {
  if (predicted === null || actual === null) return null;
  if (Math.abs(predicted) < MIN_DIRECTION_SIGNAL || Math.abs(actual) < MIN_DIRECTION_SIGNAL) return null;
  return direction(predicted) === direction(actual);
}

function getPerformancePrediction(row) {
  return (
    num(row.final_prediction_change, null) ??
    num(row.calibrated_change, null) ??
    num(row.predicted_change, null) ??
    num(row.raw_predicted_change, null)
  );
}

function getPerformanceError(row) {
  const stored = num(row.error_change, null);
  if (stored !== null) return stored;

  const actual = num(row.actual_change, null);
  const predicted = getPerformancePrediction(row);

  if (actual === null || predicted === null) return null;
  return actual - predicted;
}

function getAccuracyLayerForFund(code, performanceRows, learningStats, fallbackRowsByFund) {
  const closedRows = (performanceRows || [])
    .filter(row => row.fund_code === code)
    .filter(isReliablePerformanceRow)
    .filter(row => getPerformanceError(row) !== null)
    .sort((a, b) => {
      const aTime = new Date(a.closed_at || a.updated_at || a.created_at || "1970-01-01").getTime();
      const bTime = new Date(b.closed_at || b.updated_at || b.created_at || "1970-01-01").getTime();
      return bTime - aTime;
    });

  const fallbackRows = (fallbackRowsByFund[code] || [])
    .filter(isReliablePredictionHistoryRow)
    .filter(row => getPerformanceError(row) !== null)
    .sort((a, b) => {
      const aTime = new Date(a.updated_at || a.created_at || "1970-01-01").getTime();
      const bTime = new Date(b.updated_at || b.created_at || "1970-01-01").getTime();
      return bTime - aTime;
    });

  const sourceRows = closedRows.length ? closedRows : fallbackRows;
  const source = closedRows.length ? "prediction_performance_quality_checked" : "prediction_history_quality_checked_fallback";
  const learning = learningStats[code] || {};

  if (!sourceRows.length) {
    return {
      status: "no_history",
      source,
      sampleSize: 0,
      averageError: 0,
      recentError: 0,
      averageAbsoluteError: 0,
      recentAbsoluteError: 0,
      targetGap: 0,
      directionHitRate: null,
      offset: 0,
      dampingFactor: 1,
      confidencePenalty: 10,
      confidenceAdjustment: num(learning.confidence_adjustment, 0),
      suggestedOffsetFromStats: num(learning.suggested_offset, null),
      biasCorrectionStrength: 0,
      errorConsistency: 0,
      note: "Güvenilir kapanmış performans verisi yok; v8.1 öğrenme düzeltmesi temkinli nötr bırakıldı."
    };
  }

  const recent = sourceRows.slice(0, 24);
  const recentShort = sourceRows.slice(0, Math.min(5, sourceRows.length));

  const errors = recent.map(getPerformanceError).filter(v => v !== null);
  const shortErrors = recentShort.map(getPerformanceError).filter(v => v !== null);

  const averageError =
    errors.reduce((sum, value) => sum + value, 0) / Math.max(1, errors.length);

  const recentError =
    shortErrors.reduce((sum, value) => sum + value, 0) / Math.max(1, shortErrors.length);

  const averageAbsoluteError =
    errors.reduce((sum, value) => sum + Math.abs(value), 0) / Math.max(1, errors.length);

  const recentAbsoluteError =
    shortErrors.reduce((sum, value) => sum + Math.abs(value), 0) / Math.max(1, shortErrors.length);

  const positiveErrors = errors.filter(value => value > MIN_DIRECTION_SIGNAL).length;
  const negativeErrors = errors.filter(value => value < -MIN_DIRECTION_SIGNAL).length;
  const directionalErrors = positiveErrors + negativeErrors;

  const dominantErrorCount = Math.max(positiveErrors, negativeErrors);
  const errorConsistency =
    directionalErrors > 0 ? dominantErrorCount / directionalErrors : 0;

  const directionHits = recent
    .map(row => {
      if (row.direction_hit !== null && row.direction_hit !== undefined) {
        return row.direction_hit === true || row.direction_hit === "true";
      }

      return calculateDirectionHitFromValues(
        getPerformancePrediction(row),
        num(row.actual_change, null)
      );
    })
    .filter(value => value !== null);

  const directionHitRate =
    directionHits.length > 0
      ? (directionHits.filter(Boolean).length / directionHits.length) * 100
      : null;

  const sampleSize = errors.length;

  const learningStrength =
    sampleSize === 0
      ? 0
      : sampleSize < 3
        ? 0.22
        : sampleSize < 5
          ? 0.38
          : sampleSize < 8
            ? 0.62
            : sampleSize < 12
              ? 0.82
              : 1;

  const blendedError = averageError * 0.42 + recentError * 0.58;
  const targetGap = Math.max(0, averageAbsoluteError - TARGET_ABSOLUTE_ERROR);
  const errorPressure = clamp(targetGap / 0.75, 0, 1);

  const consistencyBoost =
    errorConsistency >= 0.75
      ? 1.08
      : errorConsistency >= 0.60
        ? 1
        : 0.78;

  const correctionPower = (0.45 + errorPressure * 0.45) * consistencyBoost;

  let offset = blendedError * learningStrength * correctionPower;

  if (Math.abs(averageError) < 0.035 && Math.abs(recentError) < 0.035) {
    offset = 0;
  }

  const maxOffset =
    sampleSize < 3
      ? 0.08
      : sampleSize < 5
        ? 0.16
        : sampleSize < 8
          ? 0.32
          : sampleSize < 12
            ? 0.48
            : 0.65;

  offset = clamp(offset, -maxOffset, maxOffset);

  /*
    model_learning_stats sadece destek sinyali olarak kullanılır.
    Asıl düzeltme her fonun güvenilir kapanmış final performans kayıtlarından hesaplanır.
  */
  const statsOffset = num(learning.suggested_offset, null);

  if (
    statsOffset !== null &&
    Math.sign(statsOffset) === Math.sign(offset) &&
    Math.abs(statsOffset) > 0.005
  ) {
    offset = clamp(offset * 0.78 + statsOffset * 0.22, -maxOffset, maxOffset);
  }

  let dampingFactor = 1;

  if (averageAbsoluteError > 1.25) dampingFactor = 0.76;
  else if (averageAbsoluteError > 0.85) dampingFactor = 0.82;
  else if (averageAbsoluteError > 0.50) dampingFactor = 0.89;
  else if (averageAbsoluteError > 0.25) dampingFactor = 0.94;
  else if (averageAbsoluteError <= TARGET_ABSOLUTE_ERROR) dampingFactor = 1;

  if (directionHitRate !== null && directionHitRate < 50) {
    dampingFactor = Math.min(dampingFactor, 0.86);
  } else if (directionHitRate !== null && directionHitRate >= 80) {
    dampingFactor = Math.max(dampingFactor, 0.93);
  }

  let confidencePenalty = 0;

  if (averageAbsoluteError > 1.25) confidencePenalty += 22;
  else if (averageAbsoluteError > 0.85) confidencePenalty += 16;
  else if (averageAbsoluteError > 0.50) confidencePenalty += 10;
  else if (averageAbsoluteError > 0.25) confidencePenalty += 5;

  if (sampleSize < 5) confidencePenalty += 7;
  if (directionHitRate !== null && directionHitRate < 50) confidencePenalty += 9;
  if (errorConsistency < 0.55 && sampleSize >= 5) confidencePenalty += 4;

  const status =
    averageAbsoluteError <= TARGET_ABSOLUTE_ERROR && sampleSize >= 5
      ? "target_zone"
      : sampleSize < 5
        ? "early_learning"
        : "fund_bias_corrected";

  return {
    status,
    source,
    sampleSize,
    averageError: round(averageError, 4),
    recentError: round(recentError, 4),
    averageAbsoluteError: round(averageAbsoluteError, 4),
    recentAbsoluteError: round(recentAbsoluteError, 4),
    targetAbsoluteError: TARGET_ABSOLUTE_ERROR,
    targetGap: round(targetGap, 4),
    directionHitRate: directionHitRate === null ? null : round(directionHitRate, 2),
    offset: round(offset, 4),
    dampingFactor: round(dampingFactor, 4),
    confidencePenalty: round(confidencePenalty, 2),
    confidenceAdjustment: num(learning.confidence_adjustment, 0),
    suggestedOffsetFromStats: statsOffset,
    biasCorrectionStrength: round(learningStrength * correctionPower, 4),
    errorConsistency: round(errorConsistency, 4),
    positiveErrorCount: positiveErrors,
    negativeErrorCount: negativeErrors,
    note:
      "v8.1: öğrenme sadece veri kalite filtresinden geçen kapanmış final performanslarından hesaplanır; fon bazlı sistematik hata ayrı düzeltilir."
  };
}

function calculatePortfolioFreshness(holdings, latestFundPrice) {
  const today = todayTR();
  const reportDates = (holdings || [])
    .map(row => row.report_date)
    .filter(Boolean)
    .map(value => String(value).slice(0, 10))
    .sort((a, b) => String(b).localeCompare(String(a)));

  const reportDate = reportDates[0] || null;
  const ageDays = reportDate ? diffDays(reportDate, today) : null;

  if (ageDays === null) {
    return {
      reportDate,
      ageDays,
      freshnessStatus: "unknown",
      freshnessScore: 0.50,
      portfolioSignalWeight: 0.50,
      staleMomentumWeight: 0.10,
      note: "Portföy rapor tarihi yok; portföy sinyali temkinli azaltıldı."
    };
  }

  let freshnessStatus = "fresh";
  let freshnessScore = 1;

  if (ageDays <= 35) {
    freshnessStatus = "fresh";
    freshnessScore = 1;
  } else if (ageDays <= 50) {
    freshnessStatus = "watch";
    freshnessScore = 0.82;
  } else if (ageDays <= 70) {
    freshnessStatus = "stale";
    freshnessScore = 0.62;
  } else if (ageDays <= 90) {
    freshnessStatus = "very_stale";
    freshnessScore = 0.45;
  } else {
    freshnessStatus = "critical_stale";
    freshnessScore = 0.32;
  }

  const portfolioSignalWeight = clamp(freshnessScore, 0.25, 1);
  const staleMomentumWeight = clamp((1 - portfolioSignalWeight) * 0.22, 0, 0.16);

  return {
    reportDate,
    ageDays,
    freshnessStatus,
    freshnessScore: round(freshnessScore, 4),
    portfolioSignalWeight: round(portfolioSignalWeight, 4),
    staleMomentumWeight: round(staleMomentumWeight, 4),
    latestActualDate: latestFundPrice ? latestFundPrice.price_date || latestFundPrice.date || null : null,
    note:
      freshnessStatus === "fresh"
        ? "Portföy verisi güncel kabul edildi."
        : "Portföy verisi eski; portföy sinyali azaltıldı ve son fon davranışı düşük ağırlıkla eklendi."
  };
}

function determineSmoothingFactor({
  signal,
  coverage,
  directPricedWeight,
  portfolioFreshness,
  accuracyLayer
}) {
  const volatility = Math.abs(num(signal, 0));
  const coverageScore = clamp(num(coverage, 0) / 100, 0, 1);
  const directRatio =
    coverage > 0
      ? clamp(num(directPricedWeight, 0) / Math.max(coverage, 1), 0, 1)
      : 0;

  let factor = 0.60;

  if (portfolioFreshness.freshnessScore < 0.5) factor -= 0.08;
  else if (portfolioFreshness.freshnessScore < 0.75) factor -= 0.04;

  if (coverageScore < 0.80) factor -= 0.05;
  if (directRatio < 0.50) factor -= 0.04;

  if (accuracyLayer.averageAbsoluteError > 0.85) factor -= 0.06;
  else if (accuracyLayer.averageAbsoluteError > 0.50) factor -= 0.03;

  if (volatility > 2.5) factor -= 0.10;
  else if (volatility > 1.5) factor -= 0.06;
  else if (volatility < 0.40) factor += 0.05;

  return round(clamp(factor, 0.36, 0.72), 4);
}

function buildPredictionForFund(code, holdings, holdingMeta, marketChanges, latestFundPrice, accuracyLayer) {
  const details = [];

  let totalWeightRaw = 0;

  for (const h of holdings || []) {
    const weight = num(h.weight, 0);
    if (weight > 0) totalWeightRaw += weight;
  }

  const normalizationFactor = totalWeightRaw > 103 ? 100 / totalWeightRaw : 1;

  let weightedChange = 0;
  let directWeight = 0;
  let totalWeight = 0;
  let positiveContribution = 0;
  let negativeContribution = 0;
  let stockWeight = 0;
  let nonStockWeight = 0;

  for (const h of holdings || []) {
    const originalWeight = num(h.weight, 0);
    if (originalWeight <= 0) continue;

    const effectiveWeight = originalWeight * normalizationFactor;
    const pricing = getHoldingMarketChange(h, marketChanges);
    const contribution = (effectiveWeight / 100) * pricing.marketChange;
    const assetType = String(h.asset_type || "").toUpperCase();

    totalWeight += effectiveWeight;
    weightedChange += contribution;

    if (assetType === "STOCK") stockWeight += effectiveWeight;
    else nonStockWeight += effectiveWeight;

    if (pricing.directPricing) directWeight += effectiveWeight;
    if (contribution >= 0) positiveContribution += contribution;
    if (contribution < 0) negativeContribution += contribution;

    details.push({
      assetType: h.asset_type,
      symbol: h.symbol,
      name: h.name,
      originalWeight: round(originalWeight, 4),
      effectiveWeight: round(effectiveWeight, 4),
      marketChange: round(pricing.marketChange, 4),
      contribution: round(contribution, 4),
      pricingSource: pricing.pricingSource,
      directPricing: pricing.directPricing,
      reportDate: h.report_date,
      source: h.source
    });
  }

  const residualWeight = clamp(100 - totalWeight, 0, 100);
  const latestActual = latestFundPrice ? num(latestFundPrice.daily_change, 0) : 0;

  const portfolioFreshness = calculatePortfolioFreshness(holdings, latestFundPrice);

  const residualContribution = (residualWeight / 100) * latestActual * 0.22;
  const portfolioSignal = weightedChange + residualContribution;

  const freshnessAdjustedSignal =
    portfolioSignal * portfolioFreshness.portfolioSignalWeight +
    latestActual * portfolioFreshness.staleMomentumWeight;

  const smoothingFactor = determineSmoothingFactor({
    signal: freshnessAdjustedSignal,
    coverage: totalWeight,
    directPricedWeight: directWeight,
    portfolioFreshness,
    accuracyLayer
  });

  const smoothedChange = freshnessAdjustedSignal * smoothingFactor;
  const smoothingImpact = smoothedChange - freshnessAdjustedSignal;

  const afterLearningOffset = smoothedChange + accuracyLayer.offset;
  const afterDamping = afterLearningOffset * accuracyLayer.dampingFactor;

  const calibratedChange = clamp(afterDamping, -2.15, 2.15);
  const coverage = clamp(totalWeight, 0, 100);

  const directRatio =
    coverage > 0
      ? clamp(directWeight / Math.max(coverage, 1), 0, 1)
      : 0;

  const freshnessPenalty = (1 - portfolioFreshness.freshnessScore) * 18;
  const directBonus = directRatio >= 0.70 ? 4 : directRatio >= 0.45 ? 2 : 0;
  const sampleBonus = accuracyLayer.sampleSize >= 12 ? 5 : accuracyLayer.sampleSize >= 5 ? 2 : 0;
  const directionBonus =
    accuracyLayer.directionHitRate !== null && accuracyLayer.directionHitRate >= 70 ? 3 : 0;

  const baseConfidence =
    coverage >= 98
      ? 86
      : coverage >= 85
        ? 78
        : 68;

  const confidence =
    clamp(
      baseConfidence +
        directBonus +
        sampleBonus +
        directionBonus -
        freshnessPenalty -
        accuracyLayer.confidencePenalty,
      45,
      96
    );

  const expectedErrorBand = clamp(
    Math.max(
      TARGET_ABSOLUTE_ERROR,
      num(accuracyLayer.averageAbsoluteError, 0) * 0.55 + TARGET_ABSOLUTE_ERROR
    ),
    TARGET_ABSOLUTE_ERROR,
    0.75
  );

  return {
    status: "v8_1_data_quality_fund_bias_correction",
    predictedChange: round(calibratedChange, 4),
    rawPredictedChange: round(smoothedChange, 4),
    unsmoothedChange: round(freshnessAdjustedSignal, 4),
    portfolioSignal: round(portfolioSignal, 4),
    weightedPortfolioChange: round(weightedChange, 4),
    residualContribution: round(residualContribution, 4),
    latestActualMomentumContribution: round(latestActual * portfolioFreshness.staleMomentumWeight, 4),
    preAccuracyChange: round(smoothedChange, 4),
    rangeLow: round(calibratedChange - expectedErrorBand, 4),
    rangeHigh: round(calibratedChange + expectedErrorBand, 4),
    targetAbsoluteError: TARGET_ABSOLUTE_ERROR,
    expectedErrorBand: round(expectedErrorBand, 4),
    confidence: round(confidence, 2),
    confidenceText: confidenceText(confidence),
    coverage: round(coverage, 2),
    missingWeight: round(residualWeight, 2),
    residualWeight: round(residualWeight, 2),
    totalWeightRaw: round(totalWeightRaw, 4),
    normalizationFactor: round(normalizationFactor, 6),
    directPricedWeight: round(directWeight, 2),
    proxyWeight: round(Math.max(0, coverage - directWeight), 2),
    stockWeight: round(stockWeight, 2),
    nonStockWeight: round(nonStockWeight, 2),
    positiveContribution: round(positiveContribution, 4),
    negativeContribution: round(negativeContribution, 4),
    smoothingFactor,
    smoothingImpact: round(smoothingImpact, 4),
    calibrationOffset: round(accuracyLayer.offset, 4),
    accuracyDamping: round(accuracyLayer.dampingFactor, 4),
    calibration: accuracyLayer,
    accuracyLayer,
    portfolioFreshness,
    holdingMeta,
    observations: details.length,
    methodology:
      "v8.1: son portföy rapor tarihi kullanılır; geçersiz TEFAS verileri öğrenmeden çıkarılır; her fon için ayrı sistematik hata düzeltmesi uygulanır.",
    details
  };
}

function buildPayload(code, predictionDate, prediction) {
  return {
    fund_code: code,
    prediction_date: predictionDate,
    model: MODEL_KEY,
    model_version: MODEL_NAME,
    raw_predicted_change: prediction.rawPredictedChange,
    calibrated_change: prediction.predictedChange,
    calibration_offset: prediction.calibrationOffset,
    confidence: prediction.confidence,
    coverage: prediction.coverage,
    residual_weight: prediction.residualWeight,
    sample_size: prediction.calibration ? prediction.calibration.sampleSize : 0,
    updated_at: new Date().toISOString()
  };
}

async function getExistingPendingPrediction(code, predictionDate) {
  return await supabaseRequest(
    `prediction_history?select=id&fund_code=eq.${encodeURIComponent(code)}&prediction_date=eq.${encodeURIComponent(predictionDate)}&model=eq.${encodeURIComponent(MODEL_KEY)}&actual_change=is.null&limit=1`
  );
}

async function insertPrediction(payload) {
  return await supabaseRequest("prediction_history", {
    method: "POST",
    body: [
      {
        ...payload,
        actual_change: null,
        error_change: null
      }
    ]
  });
}

async function patchPrediction(id, payload) {
  return await supabaseRequest(
    `prediction_history?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: payload
    }
  );
}

async function savePredictionHistory(predictionDate, predictions) {
  const saved = [];

  for (const code of FUNDS) {
    const p = predictions[code];
    if (!p) continue;

    let targetDate = predictionDate;
    let payload = buildPayload(code, targetDate, p);

    const existingPending = await getExistingPendingPrediction(code, targetDate);

    if (existingPending && existingPending.length > 0) {
      const patched = await patchPrediction(existingPending[0].id, payload);

      saved.push({
        fundCode: code,
        action: "updated_pending",
        predictionDate: targetDate,
        id: existingPending[0].id,
        rows: patched
      });

      continue;
    }

    try {
      const inserted = await insertPrediction(payload);

      saved.push({
        fundCode: code,
        action: "inserted_pending",
        predictionDate: targetDate,
        rows: inserted
      });
    } catch (err) {
      const message = String(err.message || err);

      if (
        message.includes("duplicate") ||
        message.includes("23505") ||
        message.includes("409")
      ) {
        targetDate = nextBusinessDay(targetDate);
        payload = buildPayload(code, targetDate, p);

        const fallbackExisting = await getExistingPendingPrediction(code, targetDate);

        if (fallbackExisting && fallbackExisting.length > 0) {
          const patched = await patchPrediction(fallbackExisting[0].id, payload);

          saved.push({
            fundCode: code,
            action: "updated_pending_fallback_next_business_day",
            predictionDate: targetDate,
            id: fallbackExisting[0].id,
            rows: patched
          });
        } else {
          const insertedFallback = await insertPrediction(payload);

          saved.push({
            fundCode: code,
            action: "inserted_pending_fallback_next_business_day",
            predictionDate: targetDate,
            rows: insertedFallback
          });
        }

        continue;
      }

      throw err;
    }
  }

  return saved;
}

async function updatePendingActuals(latestFundPrices) {
  const rows = await optionalSupabaseRequest(
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY)&model=eq." +
      encodeURIComponent(MODEL_KEY) +
      "&order=created_at.asc&limit=500",
    []
  );

  const updated = [];
  const skipped = [];

  for (const row of rows || []) {
    const code = row.fund_code;
    const latest = latestFundPrices[code];

    if (!latest) {
      skipped.push({
        id: row.id,
        fundCode: code,
        reason: "no_reliable_latest_fund_price"
      });
      continue;
    }

    const latestQuality = fundPriceQuality(latest);

    if (!latestQuality.ok) {
      skipped.push({
        id: row.id,
        fundCode: code,
        reason: "invalid_latest_fund_price",
        issues: latestQuality.issues,
        price: latestQuality.price,
        dailyChange: latestQuality.dailyChange,
        priceDate: latestQuality.priceDate
      });
      continue;
    }

    if (row.actual_change !== null && row.actual_change !== undefined) {
      skipped.push({
        id: row.id,
        fundCode: code,
        reason: "already_closed"
      });
      continue;
    }

    const predictionDate = row.prediction_date;
    const latestDate = latest.price_date || latest.date;

    if (!predictionDate || !latestDate) {
      skipped.push({
        id: row.id,
        fundCode: code,
        reason: "missing_date",
        predictionDate,
        latestDate
      });
      continue;
    }

    const actual = num(latest.daily_change);
    const predicted =
      num(row.calibrated_change) ??
      num(row.predicted_change) ??
      num(row.raw_predicted_change);

    if (actual === null || predicted === null) {
      skipped.push({
        id: row.id,
        fundCode: code,
        reason: "missing_actual_or_prediction",
        actual,
        predicted
      });
      continue;
    }

    if (Math.abs(actual) > MAX_ABSOLUTE_ACTUAL_CHANGE) {
      skipped.push({
        id: row.id,
        fundCode: code,
        reason: "actual_change_out_of_range_blocked",
        actual,
        maxAllowed: MAX_ABSOLUTE_ACTUAL_CHANGE,
        predictionDate,
        latestDate
      });
      continue;
    }

    if (Math.abs(predicted) > MAX_ABSOLUTE_PREDICTION_CHANGE) {
      skipped.push({
        id: row.id,
        fundCode: code,
        reason: "prediction_out_of_range_blocked",
        predicted,
        maxAllowed: MAX_ABSOLUTE_PREDICTION_CHANGE,
        predictionDate,
        latestDate
      });
      continue;
    }

    const latestIsAfterPredictionDate = latestDate > predictionDate;

    const latestUpdatedAt = latest.updated_at || latest.created_at || null;
    const rowCreatedAt = row.created_at || null;

    const sameDateButFundUpdatedAfterPrediction =
      latestDate === predictionDate &&
      latestUpdatedAt &&
      rowCreatedAt &&
      new Date(latestUpdatedAt).getTime() > new Date(rowCreatedAt).getTime();

    const shouldClose =
      latestIsAfterPredictionDate || sameDateButFundUpdatedAfterPrediction;

    if (!shouldClose) {
      skipped.push({
        id: row.id,
        fundCode: code,
        reason: "not_ready_to_close",
        predictionDate,
        latestDate,
        latestUpdatedAt,
        rowCreatedAt
      });
      continue;
    }

    const error = actual - predicted;

    if (Math.abs(error) > MAX_ABSOLUTE_LEARNING_ERROR) {
      skipped.push({
        id: row.id,
        fundCode: code,
        reason: "learning_error_out_of_range_blocked",
        actual,
        predicted,
        error,
        maxAllowed: MAX_ABSOLUTE_LEARNING_ERROR,
        predictionDate,
        latestDate
      });
      continue;
    }

    const patched = await supabaseRequest(
      `prediction_history?id=eq.${encodeURIComponent(row.id)}`,
      {
        method: "PATCH",
        body: {
          actual_change: round(actual, 4),
          error_change: round(error, 4),
          updated_at: new Date().toISOString()
        }
      }
    );

    updated.push({
      id: row.id,
      fundCode: code,
      predictionDate,
      latestDate,
      model: row.model || null,
      predicted: round(predicted, 4),
      actual: round(actual, 4),
      error: round(error, 4),
      dataQuality: latestQuality,
      patched
    });
  }

  return {
    updated: updated.length,
    rows: updated,
    skippedCount: skipped.length,
    skipped: skipped.slice(0, 30)
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const latestFundPrices = await getLatestFundPrices();
    const latestFundPriceQuality = latestFundPrices.__quality || {};

    const actualUpdate = await updatePendingActuals(latestFundPrices);

    const holdingsBundle = await getHoldings();
    const groupedHoldings = holdingsBundle.grouped;
    const holdingMeta = holdingsBundle.meta;

    const marketChanges = await getMarketChangesForHoldings(groupedHoldings);
    const performanceRows = await getPerformanceRows();
    const learningStats = await getModelLearningStats();
    const fallbackRowsByFund = await getFallbackCalibrationRows();

    const latestDates = FUNDS
      .map(code => latestFundPrices[code] && latestFundPrices[code].price_date)
      .filter(Boolean)
      .sort();

    const latestFundDate = latestDates[latestDates.length - 1] || todayTR();
    const predictionDate = choosePredictionDate(latestFundDate);

    const predictions = {};

    for (const code of FUNDS) {
      const accuracyLayer = getAccuracyLayerForFund(
        code,
        performanceRows,
        learningStats,
        fallbackRowsByFund
      );

      predictions[code] = buildPredictionForFund(
        code,
        groupedHoldings[code] || [],
        holdingMeta[code] || {},
        marketChanges,
        latestFundPrices[code] || null,
        accuracyLayer
      );
    }

    const savedRows = await savePredictionHistory(predictionDate, predictions);

    const latestByFund = {};

    for (const code of FUNDS) {
      const fp = latestFundPrices[code] || {};

      latestByFund[code] = {
        priceDate: fp.price_date || null,
        actualChange: fp.daily_change ?? null,
        price: fp.price ?? null,
        updatedAt: fp.updated_at || fp.created_at || null
      };
    }

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      model: MODEL_NAME,
      modelKey: MODEL_KEY,
      targetAbsoluteError: TARGET_ABSOLUTE_ERROR,
      dataQualityGuard: {
        enabled: true,
        minValidFundPrice: MIN_VALID_FUND_PRICE,
        maxAbsoluteActualChange: MAX_ABSOLUTE_ACTUAL_CHANGE,
        maxAbsoluteLearningError: MAX_ABSOLUTE_LEARNING_ERROR,
        latestFundPriceQuality
      },
      closeLogic:
        "v8.1 data quality + fund bias correction; invalid actual prices are ignored and final/performance rows are not overwritten",
      latestFundDate,
      predictionDate,
      actualUpdate,
      latestByFund,
      holdingMeta,
      closedPerformanceRows: Array.isArray(performanceRows) ? performanceRows.length : 0,
      closedPerformanceRowsRaw: performanceRows.__rawCount || (Array.isArray(performanceRows) ? performanceRows.length : 0),
      learningStatsFound: Object.keys(learningStats || {}).length,
      savedToday: savedRows.length,
      saveActions: savedRows,
      funds: FUNDS,
      predictions,
      disclaimer:
        "Bu tahminler model bazlıdır, kesinlik içermez ve yatırım tavsiyesi değildir."
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err.message || err),
      model: MODEL_NAME,
      modelKey: MODEL_KEY
    });
  }
};
