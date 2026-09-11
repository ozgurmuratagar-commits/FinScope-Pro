const FUNDS = ["PBR", "PHE", "TLY", "THF"];

const MODEL_NAME = "FinScope Prediction Engine v10.0 - Causal NAV Prediction Engine";
const MODEL_KEY = "v7_1_accuracy_layer";

const TARGET_ABSOLUTE_ERROR = 0.10;
const MIN_VALID_FUND_PRICE = 0;
const MAX_ABSOLUTE_ACTUAL_CHANGE = 25;
const MAX_ABSOLUTE_LEARNING_ERROR = 30;
const MAX_ABSOLUTE_PREDICTION_CHANGE = 25;
const MIN_DIRECTION_SIGNAL = 0.01;

const MAX_DIRECT_SYMBOLS_PER_BATCH = 45;
const YAHOO_BATCH_SIZE = 45;

const CORE_MARKET_SYMBOLS = [
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

const SYMBOL_MAP = {
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
  const clean = values
    .map(value => num(value, null))
    .filter(value => value !== null);

  if (!clean.length) return fallback;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
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

function isWeekend(dateText) {
  const d = parseDateUTC(dateText);
  if (!d) return false;
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function nextBusinessDay(dateText) {
  const d = parseDateUTC(dateText) || parseDateUTC(todayTR());

  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);

  return d.toISOString().slice(0, 10);
}

function diffDays(fromDateText, toDateText) {
  const from = parseDateUTC(fromDateText);
  const to = parseDateUTC(toDateText);
  if (!from || !to) return null;

  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / dayMs));
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
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function directionHit(predicted, actual) {
  const p = num(predicted, null);
  const a = num(actual, null);

  if (p === null || a === null) return null;
  if (Math.abs(p) < MIN_DIRECTION_SIGNAL || Math.abs(a) < MIN_DIRECTION_SIGNAL) return null;

  return direction(p) === direction(a);
}

function confidenceText(score) {
  const s = num(score, 0);
  if (s >= 90) return "Çok yüksek";
  if (s >= 80) return "Yüksek";
  if (s >= 70) return "Orta";
  if (s >= 60) return "İzlenmeli";
  return "Düşük";
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replaceAll("İ", "I")
    .replaceAll("Ğ", "G")
    .replaceAll("Ü", "U")
    .replaceAll("Ş", "S")
    .replaceAll("Ö", "O")
    .replaceAll("Ç", "C");
}

function normalizeSymbol(symbol) {
  if (!symbol) return "";

  const s = normalizeText(symbol)
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9.=/-]/g, "");

  if (!s) return "";

  if (SYMBOL_MAP[s]) return SYMBOL_MAP[s];

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
      `Supabase ${options.method || "GET"} ${path} HTTP ${response.status}: ${text.slice(0, 1200)}`
    );
  }

  if (!text) return [];

  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function optionalSupabaseRequest(path, fallback = []) {
  try {
    const rows = await supabaseRequest(path);
    return Array.isArray(rows) ? rows : fallback;
  } catch {
    return fallback;
  }
}

function isValidFundPrice(row) {
  const price = num(row && row.price, null);
  return price !== null && price > MIN_VALID_FUND_PRICE;
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

async function getLatestFundPrices() {
  const rows = await supabaseRequest(
    "fund_prices?select=*&fund_code=in.(PBR,PHE,TLY,THF)&order=price_date.desc,created_at.desc&limit=160"
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
      stockWeight: 0,
      nonStockWeight: 0,
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

    const totalWeight = normalized.reduce((sum, row) => sum + num(row.weight, 0), 0);
    const stockWeight = normalized
      .filter(row => normalizeText(row.asset_type).includes("STOCK"))
      .reduce((sum, row) => sum + num(row.weight, 0), 0);

    grouped[code] = normalized;

    meta[code] = {
      selectedReportDate,
      rawRows: fundRows.length,
      selectedRows: normalized.length,
      totalWeight: round(totalWeight, 4),
      stockWeight: round(stockWeight, 4),
      nonStockWeight: round(Math.max(0, totalWeight - stockWeight), 4),
      selectionRule: selectedReportDate
        ? "only_latest_report_date_per_fund"
        : "no_report_date_found_all_rows_used"
    };
  }

  return { grouped, meta };
}

function chunkArray(items, size) {
  const chunks = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

function parseYahooQuote(item, requestedSymbol) {
  if (!item) return null;

  const symbol = item.symbol || requestedSymbol;
  const price = num(item.regularMarketPrice, null);
  const previous =
    num(item.regularMarketPreviousClose, null) ??
    num(item.previousClose, null);

  const directPercent =
    num(item.regularMarketChangePercent, null) ??
    num(item.regularMarketChangePercentRaw, null);

  let change = directPercent;

  if (change === null && price !== null && previous !== null && previous !== 0) {
    change = ((price - previous) / previous) * 100;
  }

  if (change === null) return null;

  return {
    requestedSymbol,
    symbol,
    price,
    previous,
    change,
    marketState: item.marketState || null,
    source: "Yahoo Finance quote",
    ok: true
  };
}

async function fetchYahooQuoteBatch(symbols) {
  const unique = Array.from(new Set(symbols.filter(Boolean).map(normalizeSymbol).filter(Boolean)));
  const output = {};

  for (const chunk of chunkArray(unique, YAHOO_BATCH_SIZE)) {
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(chunk.join(","));

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 FinScope/10.0"
        }
      });

      if (!response.ok) continue;

      const json = await response.json();
      const result =
        json &&
        json.quoteResponse &&
        Array.isArray(json.quoteResponse.result)
          ? json.quoteResponse.result
          : [];

      for (const item of result) {
        const parsed = parseYahooQuote(item, item.symbol);
        if (!parsed) continue;

        output[item.symbol] = parsed;
      }
    } catch {
      continue;
    }
  }

  return output;
}

async function fetchYahooChart(symbol) {
  const yahooSymbol = normalizeSymbol(symbol);
  if (!yahooSymbol) return null;

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSymbol) +
    "?range=5d&interval=1d";

  try {
    const response = await fetch(url, {
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

    if (current !== null && previous !== null && previous !== 0) {
      return {
        requestedSymbol: symbol,
        symbol: yahooSymbol,
        price: current,
        previous,
        change: ((current - previous) / previous) * 100,
        source: "Yahoo Finance chart",
        ok: true
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
      const last = num(closes[closes.length - 1], null);
      const prev = num(closes[closes.length - 2], null);

      if (last !== null && prev !== null && prev !== 0) {
        return {
          requestedSymbol: symbol,
          symbol: yahooSymbol,
          price: last,
          previous: prev,
          change: ((last - prev) / prev) * 100,
          source: "Yahoo Finance chart",
          ok: true
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

function shouldDirectPriceHolding(row) {
  const type = normalizeText(row.asset_type);
  const symbol = normalizeText(row.symbol);

  if (!symbol) return false;

  if (type.includes("STOCK")) return true;
  if (type.includes("EQUITY")) return true;
  if (type.includes("HISSE")) return true;

  return false;
}

async function getMarketChangesForHoldings(groupedHoldings) {
  const directSymbols = new Set();
  const allSymbols = new Set();

  for (const code of FUNDS) {
    const sortedHoldings = (groupedHoldings[code] || [])
      .slice()
      .sort((a, b) => num(b.weight, 0) - num(a.weight, 0));

    let count = 0;

    for (const h of sortedHoldings) {
      if (!shouldDirectPriceHolding(h)) continue;

      const symbol = normalizeText(h.symbol);
      if (!symbol) continue;

      allSymbols.add(symbol);

      if (count < MAX_DIRECT_SYMBOLS_PER_BATCH) {
        directSymbols.add(symbol);
        count += 1;
      }
    }
  }

  CORE_MARKET_SYMBOLS.forEach(symbol => {
    directSymbols.add(symbol);
    allSymbols.add(symbol);
  });

  const normalizedRequestSymbols = Array.from(directSymbols)
    .map(normalizeSymbol)
    .filter(Boolean);

  const batchQuotes = await fetchYahooQuoteBatch(normalizedRequestSymbols);

  const results = {};
  const unresolved = [];

  for (const original of Array.from(directSymbols)) {
    const normalized = normalizeSymbol(original);
    const direct = batchQuotes[normalized];

    if (direct && num(direct.change, null) !== null) {
      results[original] = direct;
      results[normalized] = direct;
    } else {
      unresolved.push(original);
    }
  }

  const chartFallbackSymbols = unresolved.slice(0, 25);

  await Promise.all(
    chartFallbackSymbols.map(async symbol => {
      const normalized = normalizeSymbol(symbol);
      const data = await fetchYahooChart(symbol);

      if (data && num(data.change, null) !== null) {
        results[symbol] = data;
        results[normalized] = data;
      }
    })
  );

  return {
    results,
    diagnostics: {
      directRequested: Array.from(directSymbols).length,
      allHoldingSymbols: Array.from(allSymbols).length,
      quoteResolved: Object.keys(batchQuotes || {}).length,
      chartFallbackTried: chartFallbackSymbols.length,
      unresolvedAfterQuote: unresolved.length,
      pricingPolicy:
        "v10.0: top weighted holdings are directly priced through Yahoo quote/chart; unresolved lower holdings use asset proxy but remain visible in contribution table."
    }
  };
}

function marketChangeValue(marketChanges, key, fallback = 0) {
  const direct = marketChanges[key];
  const normalized = marketChanges[normalizeSymbol(key)];
  const data = direct || normalized;

  return data && num(data.change, null) !== null ? num(data.change, fallback) : fallback;
}

function getAssetType(row) {
  return normalizeText(row && row.asset_type);
}

function getAssetSymbol(row) {
  return normalizeText(row && row.symbol);
}

function proxyChangeForNonStock(assetType, symbol, marketChanges) {
  const type = normalizeText(assetType);
  const sym = normalizeText(symbol);

  if (type.includes("MONEY") || type.includes("REPO") || sym.includes("REPO") || sym.includes("PARA")) {
    return 0.10;
  }

  if (type.includes("CASH") || type.includes("NAKIT") || sym === "TRY") {
    return 0;
  }

  if (
    type.includes("BOND") ||
    type.includes("DEBT") ||
    type.includes("TAHVIL") ||
    type.includes("BONO") ||
    sym.includes("TAHVIL") ||
    sym.includes("BONO")
  ) {
    return 0.04;
  }

  if (type.includes("GOLD") || sym.includes("ALTIN") || sym.includes("XAU")) {
    return marketChangeValue(marketChanges, "XAU", 0);
  }

  if (type.includes("SILVER") || sym.includes("GUMUS") || sym.includes("XAG")) {
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
    return marketChangeValue(marketChanges, "XU100", 0) * 0.55;
  }

  if (type.includes("VIOP")) {
    return marketChangeValue(marketChanges, "XU030", marketChangeValue(marketChanges, "XU100", 0)) * 0.40;
  }

  return 0;
}

function getHoldingMarketChange(holding, marketChanges) {
  const assetType = getAssetType(holding);
  const symbol = getAssetSymbol(holding);

  if (shouldDirectPriceHolding(holding)) {
    const direct = marketChanges[symbol];
    const normalized = marketChanges[normalizeSymbol(symbol)];
    const data = direct || normalized;

    if (data && num(data.change, null) !== null) {
      return {
        marketChange: num(data.change, 0),
        directPricing: true,
        pricingSource: `${data.source} • ${data.symbol}`,
        price: data.price ?? null,
        previous: data.previous ?? null
      };
    }

    const xu100 = marketChangeValue(marketChanges, "XU100", 0);
    const xu30 = marketChangeValue(marketChanges, "XU030", xu100);
    const proxy = xu30 !== 0 ? xu30 : xu100;

    return {
      marketChange: proxy,
      directPricing: false,
      pricingSource: "BIST proxy • unresolved stock",
      price: null,
      previous: null
    };
  }

  return {
    marketChange: proxyChangeForNonStock(assetType, symbol, marketChanges),
    directPricing: false,
    pricingSource: "asset type proxy",
    price: null,
    previous: null
  };
}

function performancePrediction(row) {
  return (
    num(row.final_prediction_change, null) ??
    num(row.calibrated_change, null) ??
    num(row.predicted_change, null) ??
    num(row.raw_predicted_change, null)
  );
}

function performanceError(row) {
  const stored = num(row.error_change, null);
  if (stored !== null) return stored;

  const actual = num(row.actual_change, null);
  const predicted = performancePrediction(row);

  if (actual === null || predicted === null) return null;

  return actual - predicted;
}

function isReliablePerformanceRow(row) {
  if (!row) return false;

  const status = String(row.status || "").toLowerCase();
  if (!["closed", "shock_closed", "completed"].includes(status)) return false;

  const actualChange = num(row.actual_change, null);
  const predicted = performancePrediction(row);
  const errorChange = performanceError(row);

  if (actualChange === null || Math.abs(actualChange) > MAX_ABSOLUTE_ACTUAL_CHANGE) return false;
  if (predicted === null || Math.abs(predicted) > MAX_ABSOLUTE_PREDICTION_CHANGE) return false;
  if (errorChange === null || Math.abs(errorChange) > MAX_ABSOLUTE_LEARNING_ERROR) return false;

  return true;
}

function isReliablePredictionHistoryRow(row) {
  if (!row) return false;

  const actualChange = num(row.actual_change, null);
  const predicted = performancePrediction(row);
  const errorChange = performanceError(row);

  if (actualChange === null || Math.abs(actualChange) > MAX_ABSOLUTE_ACTUAL_CHANGE) return false;
  if (predicted === null || Math.abs(predicted) > MAX_ABSOLUTE_PREDICTION_CHANGE) return false;
  if (errorChange === null || Math.abs(errorChange) > MAX_ABSOLUTE_LEARNING_ERROR) return false;

  return true;
}

async function getPerformanceRows() {
  const rows = await optionalSupabaseRequest(
    "prediction_performance?select=*&fund_code=in.(PBR,PHE,TLY,THF)&model=eq." +
      encodeURIComponent(MODEL_KEY) +
      "&status=in.(closed,shock_closed,completed)&order=closed_at.desc,created_at.desc&limit=500",
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
      "&order=calculated_at.desc,updated_at.desc&limit=160",
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
      "&actual_change=not.is.null&error_change=not.is.null&order=updated_at.desc,created_at.desc&limit=320",
    []
  );

  const reliableRows = (rows || []).filter(isReliablePredictionHistoryRow);
  const byFund = {};

  for (const code of FUNDS) {
    byFund[code] = reliableRows.filter(r => r.fund_code === code);
  }

  return byFund;
}

function getAccuracyLayerForFund(code, performanceRows, learningStats, fallbackRowsByFund) {
  const closedRows = (performanceRows || [])
    .filter(row => row.fund_code === code)
    .filter(isReliablePerformanceRow)
    .filter(row => performanceError(row) !== null)
    .sort((a, b) => {
      const aTime = new Date(a.closed_at || a.updated_at || a.created_at || "1970-01-01").getTime();
      const bTime = new Date(b.closed_at || b.updated_at || b.created_at || "1970-01-01").getTime();
      return bTime - aTime;
    });

  const fallbackRows = (fallbackRowsByFund[code] || [])
    .filter(isReliablePredictionHistoryRow)
    .filter(row => performanceError(row) !== null)
    .sort((a, b) => {
      const aTime = new Date(a.updated_at || a.created_at || "1970-01-01").getTime();
      const bTime = new Date(b.updated_at || b.created_at || "1970-01-01").getTime();
      return bTime - aTime;
    });

  const sourceRows = closedRows.length ? closedRows : fallbackRows;
  const source = closedRows.length
    ? "prediction_performance_closed_and_shock_closed"
    : "prediction_history_quality_checked_fallback";

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
      directionHitRate: null,
      offset: 0,
      confidencePenalty: 8,
      suggestedOffsetFromStats: num(learning.suggested_offset, null),
      confidenceAdjustment: num(learning.confidence_adjustment, 0),
      learningStrength: 0,
      shockRows: 0,
      normalRows: 0,
      note: "Güvenilir kapanmış performans verisi yok; v10.0 causal NAV sinyali ana kaynak olarak kullanılır."
    };
  }

  const recent = sourceRows.slice(0, 30);
  const recentShort = sourceRows.slice(0, Math.min(7, sourceRows.length));

  const errors = recent.map(performanceError).filter(v => v !== null);
  const shortErrors = recentShort.map(performanceError).filter(v => v !== null);

  const averageError = average(errors, 0);
  const recentError = average(shortErrors, averageError);
  const averageAbsoluteError = average(errors.map(Math.abs), 0);
  const recentAbsoluteError = average(shortErrors.map(Math.abs), averageAbsoluteError);

  const hits = recent
    .map(row => {
      if (row.direction_hit !== null && row.direction_hit !== undefined) {
        return row.direction_hit === true || row.direction_hit === "true";
      }

      return directionHit(performancePrediction(row), num(row.actual_change, null));
    })
    .filter(value => value !== null);

  const directionHitRate =
    hits.length > 0 ? (hits.filter(Boolean).length / hits.length) * 100 : null;

  const shockRows = recent.filter(row => String(row.status || "").toLowerCase() === "shock_closed").length;
  const normalRows = recent.length - shockRows;

  const sampleSize = errors.length;

  const learningStrength =
    sampleSize < 3
      ? 0.15
      : sampleSize < 5
        ? 0.28
        : sampleSize < 8
          ? 0.42
          : sampleSize < 15
            ? 0.58
            : 0.72;

  /*
    v10.0 önemli değişiklik:
    Geçmiş hata artık ana tahmin değildir. Sadece küçük bir bias düzeltmesi yapar.
    Büyük hareketlerde portföy kaynaklı causal NAV sinyali bastırılmaz.
  */
  const blendedError = averageError * 0.35 + recentError * 0.65;

  const maxOffset =
    sampleSize < 5
      ? 0.20
      : sampleSize < 10
        ? 0.38
        : sampleSize < 20
          ? 0.65
          : 0.90;

  let offset = clamp(blendedError * learningStrength, -maxOffset, maxOffset);

  const statsOffset = num(learning.suggested_offset, null);

  if (
    statsOffset !== null &&
    Math.abs(statsOffset) <= 1.25 &&
    Math.sign(statsOffset) === Math.sign(offset)
  ) {
    offset = clamp(offset * 0.82 + statsOffset * 0.18, -maxOffset, maxOffset);
  }

  let confidencePenalty = 0;

  if (averageAbsoluteError > 2.5) confidencePenalty += 14;
  else if (averageAbsoluteError > 1.5) confidencePenalty += 9;
  else if (averageAbsoluteError > 0.85) confidencePenalty += 5;
  else if (averageAbsoluteError > 0.50) confidencePenalty += 3;

  if (sampleSize < 5) confidencePenalty += 7;
  if (directionHitRate !== null && directionHitRate < 50) confidencePenalty += 7;

  const status =
    averageAbsoluteError <= TARGET_ABSOLUTE_ERROR && sampleSize >= 5
      ? "target_zone"
      : shockRows >= 3
        ? "shock_learning"
        : sampleSize < 5
          ? "early_learning"
          : "causal_bias_adjustment";

  return {
    status,
    source,
    sampleSize,
    averageError: round(averageError, 4),
    recentError: round(recentError, 4),
    averageAbsoluteError: round(averageAbsoluteError, 4),
    recentAbsoluteError: round(recentAbsoluteError, 4),
    targetAbsoluteError: TARGET_ABSOLUTE_ERROR,
    directionHitRate: directionHitRate === null ? null : round(directionHitRate, 2),
    offset: round(offset, 4),
    confidencePenalty: round(confidencePenalty, 2),
    confidenceAdjustment: num(learning.confidence_adjustment, 0),
    suggestedOffsetFromStats: statsOffset,
    learningStrength: round(learningStrength, 4),
    shockRows,
    normalRows,
    note:
      "v10.0: öğrenme katmanı yalnızca bias düzeltmesidir; ana tahmin fon içeriği ve varlık ağırlıklarından hesaplanan Causal NAV sinyalidir."
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
      freshnessScore: 0.58,
      note: "Portföy rapor tarihi yok; causal NAV sinyali temkinli değerlendirildi."
    };
  }

  let freshnessStatus = "fresh";
  let freshnessScore = 1;

  if (ageDays <= 35) {
    freshnessStatus = "fresh";
    freshnessScore = 1;
  } else if (ageDays <= 50) {
    freshnessStatus = "watch";
    freshnessScore = 0.88;
  } else if (ageDays <= 70) {
    freshnessStatus = "stale";
    freshnessScore = 0.72;
  } else if (ageDays <= 90) {
    freshnessStatus = "very_stale";
    freshnessScore = 0.56;
  } else {
    freshnessStatus = "critical_stale";
    freshnessScore = 0.42;
  }

  return {
    reportDate,
    ageDays,
    freshnessStatus,
    freshnessScore: round(freshnessScore, 4),
    latestActualDate: latestFundPrice ? latestFundPrice.price_date || latestFundPrice.date || null : null,
    note:
      freshnessStatus === "fresh"
        ? "Portföy verisi güncel kabul edildi."
        : "Portföy verisi eski; causal NAV tahmini güven puanında düşürüldü ama sinyal bastırılmadı."
  };
}

function getShockRegime({
  causalSignal,
  weightedPortfolioChange,
  negativeContribution,
  positiveContribution,
  stockWeight,
  directPricedWeight,
  coverage,
  latestActual
}) {
  const absSignal = Math.abs(num(causalSignal, 0));
  const absWeighted = Math.abs(num(weightedPortfolioChange, 0));
  const absActual = Math.abs(num(latestActual, 0));

  const directRatio = coverage > 0 ? directPricedWeight / Math.max(coverage, 1) : 0;
  const stockRatio = coverage > 0 ? stockWeight / Math.max(coverage, 1) : 0;

  const shock =
    absSignal >= 2.5 ||
    absWeighted >= 2.5 ||
    Math.abs(num(negativeContribution, 0)) >= 2.5 ||
    Math.abs(num(positiveContribution, 0)) >= 2.5 ||
    absActual >= 6;

  const strongShock =
    absSignal >= 6 ||
    absWeighted >= 6 ||
    absActual >= 10;

  let status = "normal";
  if (strongShock) status = "strong_shock";
  else if (shock) status = "shock_watch";

  return {
    status,
    shock,
    strongShock,
    directRatio: round(directRatio, 4),
    stockRatio: round(stockRatio, 4),
    reasons: [
      absSignal >= 2.5 ? "causal_signal_abs_gte_2_5" : null,
      absWeighted >= 2.5 ? "weighted_portfolio_abs_gte_2_5" : null,
      Math.abs(num(negativeContribution, 0)) >= 2.5 ? "negative_contribution_abs_gte_2_5" : null,
      absActual >= 6 ? "latest_fund_actual_abs_gte_6" : null,
      directRatio >= 0.45 ? "direct_priced_weight_sufficient" : null,
      stockRatio >= 0.45 ? "stock_weight_material" : null
    ].filter(Boolean)
  };
}

function calculateCausalBlend({
  causalSignal,
  latestActual,
  coverage,
  directPricedWeight,
  portfolioFreshness,
  shockRegime
}) {
  const coverageScore = clamp(coverage / 100, 0, 1);
  const directScore = coverage > 0 ? clamp(directPricedWeight / Math.max(coverage, 1), 0, 1) : 0;
  const freshnessScore = num(portfolioFreshness.freshnessScore, 0.6);

  let causalWeight = 0.82;

  if (coverageScore >= 0.95) causalWeight += 0.05;
  else if (coverageScore < 0.75) causalWeight -= 0.08;

  if (directScore >= 0.70) causalWeight += 0.08;
  else if (directScore < 0.35) causalWeight -= 0.10;

  if (freshnessScore < 0.60) causalWeight -= 0.08;
  else if (freshnessScore >= 0.88) causalWeight += 0.03;

  if (shockRegime.strongShock) causalWeight += 0.10;
  else if (shockRegime.shock) causalWeight += 0.06;

  causalWeight = clamp(causalWeight, 0.58, 0.96);

  const momentumWeight = clamp(1 - causalWeight, 0.04, 0.42);

  /*
    v10.0:
    latestActual sadece ikincil momentumdur.
    Portföy/hisse ağırlıklı causal sinyal ana tahmindir.
  */
  const blendedSignal =
    causalSignal * causalWeight +
    num(latestActual, 0) * momentumWeight * 0.35;

  return {
    causalWeight: round(causalWeight, 4),
    momentumWeight: round(momentumWeight, 4),
    blendedSignal: round(blendedSignal, 4)
  };
}

function calculateConfidence({
  coverage,
  directPricedWeight,
  portfolioFreshness,
  accuracyLayer,
  shockRegime,
  details
}) {
  const coverageScore = clamp(coverage / 100, 0, 1);
  const directRatio = coverage > 0 ? clamp(directPricedWeight / Math.max(coverage, 1), 0, 1) : 0;
  const freshnessScore = num(portfolioFreshness.freshnessScore, 0.6);

  let score = 58;

  score += coverageScore * 16;
  score += directRatio * 14;
  score += freshnessScore * 9;

  if (accuracyLayer.sampleSize >= 20) score += 5;
  else if (accuracyLayer.sampleSize >= 10) score += 3;
  else if (accuracyLayer.sampleSize >= 5) score += 1;

  if (accuracyLayer.directionHitRate !== null && accuracyLayer.directionHitRate >= 70) score += 3;
  if (accuracyLayer.directionHitRate !== null && accuracyLayer.directionHitRate < 50) score -= 6;

  if (shockRegime.strongShock) score -= 4;
  else if (shockRegime.shock) score -= 2;

  score -= num(accuracyLayer.confidencePenalty, 0);

  const directCount = (details || []).filter(row => row.directPricing).length;
  if (directCount >= 20) score += 3;
  else if (directCount >= 10) score += 2;

  return clamp(score, 45, 94);
}

function gradePredictionReliability(confidence, coverage, directPricedWeight, shockRegime) {
  const c = num(confidence, 0);
  const directRatio = coverage > 0 ? directPricedWeight / Math.max(coverage, 1) : 0;

  if (shockRegime.strongShock && directRatio < 0.50) return "Şok / kaynak izlenmeli";
  if (c >= 82 && directRatio >= 0.55) return "Güçlü causal sinyal";
  if (c >= 72) return "Kullanılabilir";
  if (c >= 62) return "İzlenmeli";
  return "Düşük güven";
}

function buildPredictionForFund(code, holdings, holdingMeta, marketChangesBundle, latestFundPrice, accuracyLayer) {
  const marketChanges = marketChangesBundle.results || marketChangesBundle || {};
  const details = [];

  let totalWeightRaw = 0;

  for (const h of holdings || []) {
    const weight = num(h.weight, 0);
    if (weight > 0) totalWeightRaw += weight;
  }

  const normalizationFactor = totalWeightRaw > 103 ? 100 / totalWeightRaw : 1;

  let weightedPortfolioChange = 0;
  let directPricedWeight = 0;
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
    const contribution = (effectiveWeight / 100) * num(pricing.marketChange, 0);
    const assetType = getAssetType(h);

    totalWeight += effectiveWeight;
    weightedPortfolioChange += contribution;

    if (shouldDirectPriceHolding(h)) stockWeight += effectiveWeight;
    else nonStockWeight += effectiveWeight;

    if (pricing.directPricing) directPricedWeight += effectiveWeight;
    if (contribution >= 0) positiveContribution += contribution;
    if (contribution < 0) negativeContribution += contribution;

    details.push({
      assetType: h.asset_type,
      symbol: h.symbol,
      normalizedSymbol: normalizeSymbol(h.symbol),
      name: h.name,
      originalWeight: round(originalWeight, 4),
      effectiveWeight: round(effectiveWeight, 4),
      marketChange: round(pricing.marketChange, 4),
      contribution: round(contribution, 4),
      pricingSource: pricing.pricingSource,
      directPricing: pricing.directPricing,
      price: pricing.price ?? null,
      previous: pricing.previous ?? null,
      reportDate: h.report_date,
      source: h.source,
      causalFormula: "effectiveWeight / 100 * marketChange"
    });
  }

  details.sort((a, b) => Math.abs(num(b.contribution, 0)) - Math.abs(num(a.contribution, 0)));

  const coverage = clamp(totalWeight, 0, 100);
  const missingWeight = clamp(100 - coverage, 0, 100);
  const latestActual = latestFundPrice ? num(latestFundPrice.daily_change, 0) : 0;

  const portfolioFreshness = calculatePortfolioFreshness(holdings, latestFundPrice);

  const residualContribution = (missingWeight / 100) * latestActual * 0.18;
  const causalSignal = weightedPortfolioChange + residualContribution;

  const shockRegime = getShockRegime({
    causalSignal,
    weightedPortfolioChange,
    negativeContribution,
    positiveContribution,
    stockWeight,
    directPricedWeight,
    coverage,
    latestActual
  });

  const causalBlend = calculateCausalBlend({
    causalSignal,
    latestActual,
    coverage,
    directPricedWeight,
    portfolioFreshness,
    shockRegime
  });

  /*
    v10.0 ana fark:
    final tahmin = causal NAV ağırlıklı sinyal + küçük öğrenme bias düzeltmesi.
    Eski v8.x gibi PBR/PHE hareketleri 0.4 / 0.8 bandına zorla sıkıştırılmaz.
  */
  const preLearningSignal = causalBlend.blendedSignal;
  const afterLearningOffset = preLearningSignal + num(accuracyLayer.offset, 0);

  const dynamicCap =
    shockRegime.strongShock
      ? 20
      : shockRegime.shock
        ? 14
        : 7.5;

  const finalPrediction = clamp(afterLearningOffset, -dynamicCap, dynamicCap);

  const confidence = calculateConfidence({
    coverage,
    directPricedWeight,
    portfolioFreshness,
    accuracyLayer,
    shockRegime,
    details
  });

  const expectedErrorBand = clamp(
    Math.max(
      TARGET_ABSOLUTE_ERROR,
      num(accuracyLayer.averageAbsoluteError, 0) * 0.40 + TARGET_ABSOLUTE_ERROR,
      shockRegime.strongShock ? 1.25 : shockRegime.shock ? 0.85 : 0.35
    ),
    TARGET_ABSOLUTE_ERROR,
    shockRegime.strongShock ? 3.5 : shockRegime.shock ? 2.25 : 1.25
  );

  const topPositive = details
    .filter(row => num(row.contribution, 0) > 0)
    .slice()
    .sort((a, b) => num(b.contribution, 0) - num(a.contribution, 0))
    .slice(0, 10);

  const topNegative = details
    .filter(row => num(row.contribution, 0) < 0)
    .slice()
    .sort((a, b) => num(a.contribution, 0) - num(b.contribution, 0))
    .slice(0, 10);

  const directRatio =
    coverage > 0 ? clamp(directPricedWeight / Math.max(coverage, 1), 0, 1) : 0;

  return {
    status: "v10_0_causal_nav_engine",
    predictedChange: round(finalPrediction, 4),
    rawPredictedChange: round(causalSignal, 4),
    unsmoothedChange: round(weightedPortfolioChange, 4),
    portfolioSignal: round(causalSignal, 4),
    weightedPortfolioChange: round(weightedPortfolioChange, 4),
    residualContribution: round(residualContribution, 4),
    latestActualMomentumContribution: round(num(latestActual, 0) * causalBlend.momentumWeight * 0.35, 4),
    preAccuracyChange: round(preLearningSignal, 4),
    causalNavChange: round(causalSignal, 4),
    causalBlendedChange: round(preLearningSignal, 4),
    finalPredictionChange: round(finalPrediction, 4),
    rangeLow: round(finalPrediction - expectedErrorBand, 4),
    rangeHigh: round(finalPrediction + expectedErrorBand, 4),
    targetAbsoluteError: TARGET_ABSOLUTE_ERROR,
    expectedErrorBand: round(expectedErrorBand, 4),
    confidence: round(confidence, 2),
    confidenceText: confidenceText(confidence),
    reliabilityLabel: gradePredictionReliability(confidence, coverage, directPricedWeight, shockRegime),
    coverage: round(coverage, 2),
    missingWeight: round(missingWeight, 2),
    residualWeight: round(missingWeight, 2),
    totalWeightRaw: round(totalWeightRaw, 4),
    normalizationFactor: round(normalizationFactor, 6),
    directPricedWeight: round(directPricedWeight, 2),
    directPricedRatio: round(directRatio * 100, 2),
    proxyWeight: round(Math.max(0, coverage - directPricedWeight), 2),
    stockWeight: round(stockWeight, 2),
    nonStockWeight: round(nonStockWeight, 2),
    positiveContribution: round(positiveContribution, 4),
    negativeContribution: round(negativeContribution, 4),
    smoothingFactor: 1,
    smoothingImpact: 0,
    causalWeight: causalBlend.causalWeight,
    momentumWeight: causalBlend.momentumWeight,
    calibrationOffset: round(num(accuracyLayer.offset, 0), 4),
    accuracyDamping: 1,
    predictionCap: dynamicCap,
    shockRegime,
    calibration: accuracyLayer,
    accuracyLayer,
    portfolioFreshness,
    holdingMeta,
    observations: details.length,
    directPricedObservations: details.filter(row => row.directPricing).length,
    proxyPricedObservations: details.filter(row => !row.directPricing).length,
    methodology:
      "v10.0: ana tahmin her fonun güncel portföy içeriğindeki varlık ağırlıkları ile varlık fiyat değişimlerinin çarpımından oluşan Causal NAV sinyalidir. Geçmiş performans yalnızca küçük bias düzeltmesi yapar; PBR/PHE şok hareketleri yapay olarak bastırılmaz.",
    causalFormula:
      "finalPrediction = clamp(Σ(effectiveWeight × assetMarketChange / 100) + residualContribution + smallLearningBias, dynamicShockAwareCap)",
    topPositiveContributors: topPositive,
    topNegativeContributors: topNegative,
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
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY,THF)&model=eq." +
      encodeURIComponent(MODEL_KEY) +
      "&order=created_at.asc&limit=700",
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

    const actual = num(latest.daily_change, null);
    const predicted =
      num(row.calibrated_change, null) ??
      num(row.predicted_change, null) ??
      num(row.raw_predicted_change, null);

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
    skipped: skipped.slice(0, 40)
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

    const marketChangesBundle = await getMarketChangesForHoldings(groupedHoldings);
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
        marketChangesBundle,
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
      version: "FinScope Predict API v10.0 - Causal NAV Prediction Engine",
      model: MODEL_NAME,
      modelKey: MODEL_KEY,
      targetAbsoluteError: TARGET_ABSOLUTE_ERROR,
      causalNavEngine: {
        enabled: true,
        principle:
          "Fon tahmini portföydeki her varlığın ağırlığı ile o varlığın piyasa değişiminin çarpımından hesaplanır.",
        formula:
          "Σ(effectiveWeight × assetMarketChange / 100) + residualContribution + smallLearningBias",
        learningRole:
          "Geçmiş performans ana tahmin değildir; sadece küçük bias düzeltmesi olarak kullanılır.",
        shockPolicy:
          "PBR/PHE gibi gerçek ve fiyat zinciriyle tutarlı sert hareketler yapay olarak bastırılmaz."
      },
      dataQualityGuard: {
        enabled: true,
        minValidFundPrice: MIN_VALID_FUND_PRICE,
        maxAbsoluteActualChange: MAX_ABSOLUTE_ACTUAL_CHANGE,
        maxAbsoluteLearningError: MAX_ABSOLUTE_LEARNING_ERROR,
        latestFundPriceQuality
      },
      marketPricing: marketChangesBundle.diagnostics || {},
      closeLogic:
        "v10.0 Causal NAV engine; pending actuals reliable TEFAS prices with next available fund price are closed, but prediction itself is built from holdings-weighted market changes.",
      latestFundDate,
      predictionDate,
      actualUpdate,
      latestByFund,
      holdingMeta,
      closedPerformanceRows: Array.isArray(performanceRows) ? performanceRows.length : 0,
      closedPerformanceRowsRaw:
        performanceRows.__rawCount || (Array.isArray(performanceRows) ? performanceRows.length : 0),
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
      version: "FinScope Predict API v10.0 - Causal NAV Prediction Engine",
      model: MODEL_NAME,
      modelKey: MODEL_KEY
    });
  }
};
