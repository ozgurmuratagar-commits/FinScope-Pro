const FUNDS = ["PBR", "PHE", "TLY", "THF"];

const MODEL_NAME = "FinScope Prediction Engine v10.0 - Causal NAV Engine";
const MODEL_KEY = "v7_1_accuracy_layer";

const TARGET_ABSOLUTE_ERROR = 0.10;
const MIN_VALID_FUND_PRICE = 0;
const MAX_ABSOLUTE_ACTUAL_CHANGE = 30;
const MAX_ABSOLUTE_LEARNING_ERROR = 30;
const MAX_ABSOLUTE_PREDICTION_CHANGE = 25;
const MAX_ABSOLUTE_MARKET_CHANGE = 35;
const MIN_DIRECTION_SIGNAL = 0.01;

const MAX_DIRECT_SYMBOLS = 120;
const YAHOO_CONCURRENCY = 24;
const YAHOO_TIMEOUT_MS = 1400;
const MIN_DIRECT_WEIGHT_FOR_PRIORITY = 0.02;

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
  const n = num(value, 0);
  return Math.max(min, Math.min(max, n));
}

function average(values, fallback = 0) {
  const clean = (values || []).map(v => num(v, null)).filter(v => v !== null);
  if (!clean.length) return fallback;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function todayTR() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function parseDateUTC(dateText) {
  if (!dateText || !/^\d{4}-\d{2}-\d{2}/.test(String(dateText))) return null;
  const d = new Date(String(dateText).slice(0, 10) + "T12:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
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
    if (isWeekend(trToday)) return nextBusinessDay(latestFundDate);
    return trToday;
  }

  return trToday;
}

function direction(value) {
  const n = num(value, 0);
  if (n > MIN_DIRECTION_SIGNAL) return "up";
  if (n < -MIN_DIRECTION_SIGNAL) return "down";
  return "flat";
}

function confidenceText(score) {
  const s = num(score, 0);
  if (s >= 90) return "Çok yüksek";
  if (s >= 80) return "Yüksek";
  if (s >= 68) return "Orta";
  return "Düşük";
}

function isValidFundPrice(row) {
  const price = num(row && row.price, null);
  return price !== null && price > MIN_VALID_FUND_PRICE;
}

function fundPriceQuality(row) {
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
  const priceDate = dateOnly(row.price_date || row.date);

  if (price === null || price <= MIN_VALID_FUND_PRICE) {
    issues.push("price_invalid_or_zero");
  }

  if (!priceDate) {
    issues.push("price_date_missing");
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
    priceDate
  };
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
      `Supabase ${options.method || "GET"} ${path} HTTP ${response.status}: ${text.slice(0, 1000)}`
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

function normalizeSymbol(symbol) {
  if (!symbol) return "";

  const s = String(symbol).trim().toUpperCase();
  if (!s) return "";

  if (STOCK_SYMBOL_MAP[s]) return STOCK_SYMBOL_MAP[s];

  if (
    s.includes("=") ||
    s.includes("-") ||
    s.endsWith(".IS") ||
    s.endsWith(".NYB") ||
    s.endsWith(".SA") ||
    s.endsWith(".L") ||
    s.endsWith(".DE")
  ) {
    return s;
  }

  return s + ".IS";
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

async function getFundPricesBundle() {
  const rows = await supabaseRequest(
    "fund_prices?select=*&fund_code=in.(PBR,PHE,TLY,THF)&order=price_date.desc,created_at.desc&limit=800"
  );

  const latest = {};
  const byFund = {};
  const quality = {};

  for (const code of FUNDS) {
    byFund[code] = [];
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

    byFund[code].push(row);

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

  for (const code of FUNDS) {
    byFund[code].sort((a, b) => String(a.price_date || a.date || "").localeCompare(String(b.price_date || b.date || "")));
  }

  return { latest, byFund, quality, rawRows: rows || [] };
}

async function getHoldings() {
  const rows = await supabaseRequest(
    "fund_holdings?select=*&fund_code=in.(PBR,PHE,TLY,THF)&order=fund_code.asc,report_date.desc,weight.desc"
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
      totalWeight: round(normalized.reduce((sum, row) => sum + num(row.weight, 0), 0), 4),
      selectionRule: selectedReportDate
        ? "only_latest_report_date_per_fund"
        : "no_report_date_found_all_rows_used"
    };
  }

  return { grouped, meta };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = YAHOO_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYahooChange(symbol) {
  const yahooSymbol = normalizeSymbol(symbol);
  if (!yahooSymbol) return null;

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSymbol) +
    "?range=5d&interval=1d";

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 FinScope/10.0"
      }
    });

    if (!response.ok) return null;

    const json = await response.json();
    const result = json.chart && json.chart.result && json.chart.result[0];
    if (!result) return null;

    const meta = result.meta || {};
    const current = num(meta.regularMarketPrice, null);
    const previous = num(meta.chartPreviousClose, null);
    const regularMarketTime = meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : null;

    if (current !== null && previous !== null && previous !== 0) {
      const change = ((current - previous) / previous) * 100;
      if (Math.abs(change) <= MAX_ABSOLUTE_MARKET_CHANGE) {
        return {
          symbol: yahooSymbol,
          price: current,
          previous,
          change,
          source: "Yahoo Finance",
          regularMarketTime
        };
      }
    }

    const closes =
      result.indicators &&
      result.indicators.quote &&
      result.indicators.quote[0] &&
      Array.isArray(result.indicators.quote[0].close)
        ? result.indicators.quote[0].close.filter(v => v !== null && v !== undefined)
        : [];

    if (closes.length >= 2) {
      const last = num(closes[closes.length - 1], null);
      const prev = num(closes[closes.length - 2], null);

      if (last !== null && prev !== null && prev !== 0) {
        const change = ((last - prev) / prev) * 100;
        if (Math.abs(change) <= MAX_ABSOLUTE_MARKET_CHANGE) {
          return {
            symbol: yahooSymbol,
            price: last,
            previous: prev,
            change,
            source: "Yahoo Finance close",
            regularMarketTime
          };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function collectSymbolPriority(groupedHoldings) {
  const priority = new Map();

  for (const code of FUNDS) {
    for (const h of groupedHoldings[code] || []) {
      const assetType = String(h.asset_type || "").toUpperCase();
      if (assetType !== "STOCK") continue;

      const symbol = String(h.symbol || "").trim().toUpperCase();
      if (!symbol) continue;

      const current = priority.get(symbol) || {
        symbol,
        normalized: normalizeSymbol(symbol),
        totalWeight: 0,
        funds: new Set()
      };

      current.totalWeight += Math.max(0, num(h.weight, 0));
      current.funds.add(code);
      priority.set(symbol, current);
    }
  }

  return Array.from(priority.values()).sort((a, b) => b.totalWeight - a.totalWeight);
}

async function getMarketChangesForHoldings(groupedHoldings) {
  const benchmarkSymbols = [
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
  ];

  const priority = collectSymbolPriority(groupedHoldings);
  const selectedStockSymbols = priority
    .filter(item => item.totalWeight >= MIN_DIRECT_WEIGHT_FOR_PRIORITY)
    .slice(0, MAX_DIRECT_SYMBOLS)
    .map(item => item.symbol);

  const symbols = Array.from(new Set([...benchmarkSymbols, ...selectedStockSymbols])).filter(Boolean);
  const results = {};

  await mapLimit(symbols, YAHOO_CONCURRENCY, async symbol => {
    const normalized = normalizeSymbol(symbol);
    const data = await fetchYahooChange(symbol);

    results[symbol] = data;
    if (normalized) results[normalized] = data;
  });

  const successfulDirectSymbols = selectedStockSymbols.filter(symbol => {
    const data = results[symbol] || results[normalizeSymbol(symbol)];
    return data && num(data.change, null) !== null;
  });

  const meta = {
    directStockUniverse: priority.length,
    directStockSymbolsRequested: selectedStockSymbols.length,
    directStockSymbolsPriced: successfulDirectSymbols.length,
    directStockSymbolsTruncated: Math.max(0, priority.length - selectedStockSymbols.length),
    maxDirectSymbols: MAX_DIRECT_SYMBOLS,
    yahooConcurrency: YAHOO_CONCURRENCY,
    yahooTimeoutMs: YAHOO_TIMEOUT_MS,
    selectionRule:
      "Bütün holdingler hesaplamaya girer; yüksek ağırlıklı hisseler doğrudan fiyatlanır, fiyatlanamayan veya düşük ağırlıklı hisseler BIST proxy ile tamamlanır."
  };

  return { changes: results, meta };
}

function marketChangeValue(marketChanges, key, fallback = 0) {
  const direct = marketChanges[key];
  const normalized = marketChanges[normalizeSymbol(key)];
  const data = direct || normalized;
  const value = data && num(data.change, null) !== null ? num(data.change, fallback) : fallback;
  return Math.abs(value) <= MAX_ABSOLUTE_MARKET_CHANGE ? value : fallback;
}

function proxyChangeForNonStock(assetType, symbol, marketChanges) {
  const type = String(assetType || "").toUpperCase();
  const sym = String(symbol || "").toUpperCase();

  if (type.includes("MONEY") || sym.includes("REPO") || sym.includes("PARA") || sym.includes("MEVDUAT")) {
    return 0.08;
  }

  if (type.includes("CASH") || sym === "TRY" || sym.includes("NAKIT") || sym.includes("NAKİT")) {
    return 0;
  }

  if (type.includes("BOND") || type.includes("DEBT") || sym.includes("TAHVIL") || sym.includes("TAHVİL") || sym.includes("BONO")) {
    return 0.05;
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

  if (type.includes("FUND") || type.includes("ETF")) {
    return marketChangeValue(marketChanges, "XU100", 0) * 0.65;
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

    if (data && num(data.change, null) !== null && Math.abs(num(data.change, 0)) <= MAX_ABSOLUTE_MARKET_CHANGE) {
      return {
        marketChange: num(data.change, 0),
        directPricing: true,
        proxyPricing: false,
        pricingSource: `${data.source} • ${data.symbol}`,
        price: data.price ?? null,
        previous: data.previous ?? null,
        regularMarketTime: data.regularMarketTime || null,
        transmissionFactor: 1
      };
    }

    const xu100 = marketChangeValue(marketChanges, "XU100", 0);
    const xu030 = marketChangeValue(marketChanges, "XU030", xu100);
    const proxy = xu030 !== 0 ? xu030 * 0.88 + xu100 * 0.12 : xu100;

    return {
      marketChange: proxy,
      directPricing: false,
      proxyPricing: true,
      pricingSource: "BIST proxy • XU030/XU100",
      price: null,
      previous: null,
      regularMarketTime: null,
      transmissionFactor: 0.78
    };
  }

  return {
    marketChange: proxyChangeForNonStock(assetType, symbol, marketChanges),
    directPricing: false,
    proxyPricing: true,
    pricingSource: "non-stock proxy",
    price: null,
    previous: null,
    regularMarketTime: null,
    transmissionFactor: assetType.includes("BOND") || assetType.includes("DEBT") ? 0.75 : 1
  };
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

function isReliablePerformanceRow(row) {
  if (!row) return false;

  const status = String(row.status || "").toLowerCase();
  const actualChange = num(row.actual_change, null);
  const absoluteError = num(row.absolute_error, null);
  const errorChange = getPerformanceError(row);
  const predicted = getPerformancePrediction(row);
  const actualPrice = num(row.actual_price, null);
  const predictionDate = dateOnly(row.prediction_date);
  const actualPriceDate = dateOnly(row.actual_price_date);

  if (!["closed", "completed", "shock_closed"].includes(status)) return false;
  if (actualChange === null || Math.abs(actualChange) > MAX_ABSOLUTE_ACTUAL_CHANGE) return false;
  if (predicted === null || Math.abs(predicted) > MAX_ABSOLUTE_PREDICTION_CHANGE) return false;
  if (errorChange === null || Math.abs(errorChange) > MAX_ABSOLUTE_LEARNING_ERROR) return false;
  if (absoluteError !== null && Math.abs(absoluteError) > MAX_ABSOLUTE_LEARNING_ERROR) return false;
  if (actualPrice !== null && actualPrice <= MIN_VALID_FUND_PRICE) return false;
  if (predictionDate && actualPriceDate && actualPriceDate < predictionDate) return false;

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

async function getPerformanceRows() {
  const rows = await optionalSupabaseRequest(
    "prediction_performance?select=*&fund_code=in.(PBR,PHE,TLY,THF)&model=eq." +
      encodeURIComponent(MODEL_KEY) +
      "&status=in.(closed,completed,shock_closed)&order=closed_at.desc,created_at.desc&limit=400",
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
    "model_learning_stats?select=*&fund_code=in.(PBR,PHE,TLY,THF)&model=eq." +
      encodeURIComponent(MODEL_KEY) +
      "&order=calculated_at.desc,updated_at.desc&limit=120",
    []
  );

  const latest = {};
  for (const row of rows || []) {
    if (!latest[row.fund_code]) latest[row.fund_code] = row;
  }

  return latest;
}

async function getFallbackCalibrationRows() {
  const rows = await optionalSupabaseRequest(
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY,THF)&model=eq." +
      encodeURIComponent(MODEL_KEY) +
      "&actual_change=not.is.null&error_change=not.is.null&order=updated_at.desc,created_at.desc&limit=300",
    []
  );

  const reliableRows = (rows || []).filter(isReliablePredictionHistoryRow);
  const byFund = {};
  for (const code of FUNDS) byFund[code] = reliableRows.filter(r => r.fund_code === code);
  return byFund;
}

function calculateDirectionHitFromValues(predicted, actual) {
  if (predicted === null || actual === null) return null;
  if (Math.abs(predicted) < MIN_DIRECTION_SIGNAL || Math.abs(actual) < MIN_DIRECTION_SIGNAL) return null;
  return direction(predicted) === direction(actual);
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
  const source = closedRows.length ? "prediction_performance_closed_and_shock_closed" : "prediction_history_quality_checked_fallback";
  const learning = learningStats[code] || {};

  if (!sourceRows.length) {
    return {
      status: "no_history",
      source,
      sampleSize: 0,
      shockSampleSize: 0,
      averageError: 0,
      recentError: 0,
      averageAbsoluteError: 0,
      recentAbsoluteError: 0,
      targetAbsoluteError: TARGET_ABSOLUTE_ERROR,
      directionHitRate: null,
      offset: 0,
      dampingFactor: 1,
      confidencePenalty: 8,
      confidenceAdjustment: num(learning.confidence_adjustment, 0),
      suggestedOffsetFromStats: num(learning.suggested_offset, null),
      biasCorrectionStrength: 0,
      note: "Güvenilir kapanmış performans verisi yok; v10 nedensel NAV ana sinyal kabul edilir, öğrenme nötr bırakılır."
    };
  }

  const recent = sourceRows.slice(0, 28);
  const recentShort = sourceRows.slice(0, Math.min(6, sourceRows.length));

  const errors = recent.map(getPerformanceError).filter(v => v !== null);
  const shortErrors = recentShort.map(getPerformanceError).filter(v => v !== null);

  const averageError = average(errors, 0);
  const recentError = average(shortErrors, averageError);
  const averageAbsoluteError = average(errors.map(v => Math.abs(v)), 0);
  const recentAbsoluteError = average(shortErrors.map(v => Math.abs(v)), averageAbsoluteError);

  const directionHits = recent
    .map(row => {
      if (row.direction_hit !== null && row.direction_hit !== undefined) {
        return row.direction_hit === true || row.direction_hit === "true";
      }
      return calculateDirectionHitFromValues(getPerformancePrediction(row), num(row.actual_change, null));
    })
    .filter(value => value !== null);

  const directionHitRate = directionHits.length
    ? (directionHits.filter(Boolean).length / directionHits.length) * 100
    : null;

  const sampleSize = errors.length;
  const shockSampleSize = recent.filter(row => String(row.status || "").toLowerCase() === "shock_closed").length;

  const learningStrength =
    sampleSize < 3 ? 0.12 :
    sampleSize < 5 ? 0.18 :
    sampleSize < 10 ? 0.24 :
    sampleSize < 18 ? 0.30 :
    0.35;

  const blendedError = averageError * 0.38 + recentError * 0.62;
  let offset = blendedError * learningStrength;

  const statsOffset = num(learning.suggested_offset, null);
  if (statsOffset !== null && Math.sign(statsOffset) === Math.sign(offset)) {
    offset = offset * 0.82 + statsOffset * 0.18;
  }

  const maxOffset = sampleSize < 5 ? 0.35 : sampleSize < 10 ? 0.65 : 1.25;
  offset = clamp(offset, -maxOffset, maxOffset);

  let dampingFactor = 1;
  if (averageAbsoluteError > 8) dampingFactor = 0.92;
  else if (averageAbsoluteError > 4) dampingFactor = 0.95;
  else if (averageAbsoluteError > 2) dampingFactor = 0.97;
  else if (averageAbsoluteError > 1) dampingFactor = 0.985;

  if (directionHitRate !== null && directionHitRate >= 75) {
    dampingFactor = Math.max(dampingFactor, 0.99);
  }

  let confidencePenalty = 0;
  if (sampleSize < 5) confidencePenalty += 8;
  if (averageAbsoluteError > 4) confidencePenalty += 12;
  else if (averageAbsoluteError > 2) confidencePenalty += 8;
  else if (averageAbsoluteError > 1) confidencePenalty += 4;
  if (directionHitRate !== null && directionHitRate < 50) confidencePenalty += 8;

  const status =
    sampleSize < 5 ? "early_causal_learning" :
    averageAbsoluteError <= TARGET_ABSOLUTE_ERROR ? "target_zone" :
    shockSampleSize >= 3 ? "shock_aware_learning" :
    "causal_bias_learning";

  return {
    status,
    source,
    sampleSize,
    shockSampleSize,
    averageError: round(averageError, 4),
    recentError: round(recentError, 4),
    averageAbsoluteError: round(averageAbsoluteError, 4),
    recentAbsoluteError: round(recentAbsoluteError, 4),
    targetAbsoluteError: TARGET_ABSOLUTE_ERROR,
    directionHitRate: directionHitRate === null ? null : round(directionHitRate, 2),
    offset: round(offset, 4),
    dampingFactor: round(dampingFactor, 4),
    confidencePenalty: round(confidencePenalty, 2),
    confidenceAdjustment: num(learning.confidence_adjustment, 0),
    suggestedOffsetFromStats: statsOffset,
    biasCorrectionStrength: round(learningStrength, 4),
    note:
      "v10: öğrenme katmanı ana tahmini bastırmaz; sadece nedensel NAV sinyaline sınırlı bias düzeltmesi ve güven cezası uygular."
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
      freshnessScore: 0.70,
      portfolioSignalWeight: 0.78,
      latestActualMomentumWeight: 0.08,
      note: "Portföy rapor tarihi yok; portföy sinyali korunur ancak güven puanı düşürülür."
    };
  }

  let freshnessStatus = "fresh";
  let freshnessScore = 1;

  if (ageDays <= 35) {
    freshnessStatus = "fresh";
    freshnessScore = 1;
  } else if (ageDays <= 50) {
    freshnessStatus = "watch";
    freshnessScore = 0.92;
  } else if (ageDays <= 70) {
    freshnessStatus = "stale";
    freshnessScore = 0.78;
  } else if (ageDays <= 90) {
    freshnessStatus = "very_stale";
    freshnessScore = 0.62;
  } else {
    freshnessStatus = "critical_stale";
    freshnessScore = 0.48;
  }

  const portfolioSignalWeight = clamp(0.72 + freshnessScore * 0.28, 0.72, 1);
  const latestActualMomentumWeight = clamp((1 - freshnessScore) * 0.16, 0, 0.10);

  return {
    reportDate,
    ageDays,
    freshnessStatus,
    freshnessScore: round(freshnessScore, 4),
    portfolioSignalWeight: round(portfolioSignalWeight, 4),
    latestActualMomentumWeight: round(latestActualMomentumWeight, 4),
    latestActualDate: latestFundPrice ? latestFundPrice.price_date || latestFundPrice.date || null : null,
    note:
      freshnessStatus === "fresh" || freshnessStatus === "watch"
        ? "Portföy verisi nedensel tahmin için yeterince güncel kabul edildi."
        : "Portföy verisi eski; portföy sinyali kısmen korunur, güven puanı düşürülür."
  };
}

function determineCausalTransmission({
  causalSignal,
  coverage,
  directPricedWeight,
  proxyWeight,
  portfolioFreshness,
  shockRegime
}) {
  const coverageScore = clamp(num(coverage, 0) / 100, 0, 1);
  const directRatio = coverage > 0 ? clamp(num(directPricedWeight, 0) / Math.max(coverage, 1), 0, 1) : 0;
  const proxyRatio = coverage > 0 ? clamp(num(proxyWeight, 0) / Math.max(coverage, 1), 0, 1) : 1;

  let factor = 0.92
