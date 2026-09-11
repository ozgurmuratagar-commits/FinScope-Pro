// api/causal-nav-report.js
// FinScope Causal NAV Coverage Report v1.0
// Purpose: non-destructive diagnostic endpoint. It checks whether fund holdings,
// weights and market moves can explain / support the prediction engine.

const API_VERSION = "FinScope Causal NAV Coverage Report API v1.0";
const FUNDS = ["PBR", "PHE", "TLY", "THF"];
const MAX_SYMBOLS_TO_PRICE = 90;
const YAHOO_TIMEOUT_MS = 6500;

function setJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(JSON.stringify(body));
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const cleaned = String(value).trim().replace("%", "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = toNumber(value);
  if (n === null) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function cleanString(value) {
  return String(value || "").trim();
}

function upper(value) {
  return cleanString(value).toUpperCase();
}

function firstDefined(row, fields) {
  for (const field of fields) {
    if (row && row[field] !== undefined && row[field] !== null && row[field] !== "") {
      return row[field];
    }
  }
  return null;
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE key environment variable.");
  }

  return {
    url: url.replace(/\/$/, ""),
    key,
  };
}

async function supabaseGet(path) {
  const { url, key } = getSupabaseConfig();
  const endpoint = `${url}/rest/v1/${path}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Supabase GET ${path} HTTP ${response.status}: ${text}`);
  }

  return Array.isArray(data) ? data : [];
}

function getFundCode(row) {
  return upper(firstDefined(row, ["fund_code", "fundCode", "fund", "code"]));
}

function getReportDate(row) {
  const value = firstDefined(row, [
    "report_date",
    "reportDate",
    "holding_date",
    "holdingDate",
    "portfolio_date",
    "portfolioDate",
    "as_of_date",
    "date",
    "created_at",
    "updated_at",
  ]);

  if (!value) return null;
  const text = String(value);
  const datePart = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : text;
}

function getSymbol(row) {
  return upper(firstDefined(row, [
    "symbol",
    "ticker",
    "asset_symbol",
    "assetSymbol",
    "stock_code",
    "stockCode",
    "instrument_code",
    "instrumentCode",
    "asset_code",
    "assetCode",
  ]));
}

function getName(row) {
  return cleanString(firstDefined(row, [
    "name",
    "asset_name",
    "assetName",
    "title",
    "instrument_name",
    "instrumentName",
    "description",
  ]));
}

function getAssetType(row) {
  return upper(firstDefined(row, [
    "asset_type",
    "assetType",
    "type",
    "category",
    "asset_class",
    "assetClass",
    "group",
  ]));
}

function getRawWeight(row) {
  return toNumber(firstDefined(row, [
    "effective_weight",
    "effectiveWeight",
    "normalized_weight",
    "normalizedWeight",
    "weight",
    "ratio",
    "percentage",
    "allocation",
    "portfolio_weight",
    "portfolioWeight",
    "original_weight",
    "originalWeight",
    "pay",
    "oran",
  ]));
}

function isLikelyCashOrDeposit(assetType, symbol, name) {
  const text = `${assetType} ${symbol} ${name}`.toUpperCase();
  return (
    text.includes("CASH") ||
    text.includes("NAKIT") ||
    text.includes("MEVDUAT") ||
    text.includes("DEPOSIT") ||
    text.includes("REPO") ||
    text.includes("TAKAS")
  );
}

function isLikelyBond(assetType, symbol, name) {
  const text = `${assetType} ${symbol} ${name}`.toUpperCase();
  return (
    text.includes("BOND") ||
    text.includes("BONO") ||
    text.includes("TAHVIL") ||
    text.includes("EUROBOND") ||
    text.includes("DIBS") ||
    text.includes("VIOP")
  );
}

function isLikelyFund(assetType, symbol, name) {
  const text = `${assetType} ${symbol} ${name}`.toUpperCase();
  return (
    text.includes("FON") ||
    text.includes("FUND") ||
    text.includes("ETF") ||
    text.includes("YATIRIM FONU")
  );
}

function normalizeBistSymbol(symbol) {
  let s = upper(symbol);
  if (!s) return null;

  s = s.replace(/\s+/g, "");
  s = s.replace(/\.E$/i, "");
  s = s.replace(/\.IS$/i, "");
  s = s.replace(/_E$/i, "");

  if (FUNDS.includes(s)) return null;
  if (["TRY", "TL", "USD", "EUR", "GBP", "CASH", "NAKIT"].includes(s)) return null;

  const explicitMap = {
    XU100: "XU100.IS",
    XU030: "XU030.IS",
    XU050: "XU050.IS",
    XU30: "XU030.IS",
    XU50: "XU050.IS",
    USDTRY: "USDTRY=X",
    EURTRY: "EURTRY=X",
    GBPTRY: "GBPTRY=X",
    EURUSD: "EURUSD=X",
    GBPUSD: "GBPUSD=X",
  };

  if (explicitMap[s]) return explicitMap[s];
  if (/^[A-Z]{2,6}[0-9]?$/.test(s)) return `${s}.IS`;
  if (/^[A-Z0-9.-]+\.IS$/.test(s)) return s;
  if (/^[A-Z]{3}TRY$/.test(s)) return `${s}=X`;

  return null;
}

function classifyHolding(row) {
  const assetType = getAssetType(row);
  const symbol = getSymbol(row);
  const name = getName(row);
  const text = `${assetType} ${symbol} ${name}`.toUpperCase();

  if (isLikelyCashOrDeposit(assetType, symbol, name)) return "cash";
  if (isLikelyBond(assetType, symbol, name)) return "bond";
  if (isLikelyFund(assetType, symbol, name)) return "fund";
  if (text.includes("HISSE") || text.includes("STOCK") || normalizeBistSymbol(symbol)) return "stock";
  return "other";
}

function sortByDateDesc(a, b) {
  const ad = getReportDate(a) || "";
  const bd = getReportDate(b) || "";
  if (ad !== bd) return bd.localeCompare(ad);
  const au = String(a.updated_at || a.created_at || "");
  const bu = String(b.updated_at || b.created_at || "");
  return bu.localeCompare(au);
}

function selectLatestHoldings(rawRows) {
  const byFund = new Map();

  for (const fund of FUNDS) {
    const rows = rawRows.filter((row) => getFundCode(row) === fund).sort(sortByDateDesc);
    if (!rows.length) {
      byFund.set(fund, { fund, reportDate: null, rows: [] });
      continue;
    }

    const latestDate = getReportDate(rows[0]);
    const latestRows = latestDate ? rows.filter((row) => getReportDate(row) === latestDate) : rows;
    byFund.set(fund, { fund, reportDate: latestDate, rows: latestRows });
  }

  return byFund;
}

function normalizeWeights(rows) {
  const rawWeights = rows.map(getRawWeight).filter((n) => n !== null && Number.isFinite(n));
  const rawSum = rawWeights.reduce((sum, n) => sum + n, 0);

  return rows.map((row) => {
    const raw = getRawWeight(row);
    let weight = raw;

    if (weight === null) {
      weight = 0;
    } else if (rawSum > 0 && rawSum <= 1.5) {
      weight = weight * 100;
    } else if (rawSum > 120) {
      weight = (weight / rawSum) * 100;
    }

    const symbol = getSymbol(row);
    const name = getName(row);
    const assetType = getAssetType(row);
    const assetClass = classifyHolding(row);
    const yahooSymbol = assetClass === "stock" ? normalizeBistSymbol(symbol) : null;

    return {
      raw,
      weight: round(weight, 6),
      symbol,
      yahooSymbol,
      name,
      assetType,
      assetClass,
      reportDate: getReportDate(row),
      original: row,
    };
  });
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 FinScopeBot/1.0",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

function lastFinite(values) {
  if (!Array.isArray(values)) return null;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const n = toNumber(values[i]);
    if (n !== null) return n;
  }
  return null;
}

function previousFinite(values) {
  if (!Array.isArray(values)) return null;
  let seen = 0;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const n = toNumber(values[i]);
    if (n !== null) {
      seen += 1;
      if (seen === 2) return n;
    }
  }
  return null;
}

async function fetchYahooQuote(yahooSymbol) {
  if (!yahooSymbol) return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`;

  try {
    const data = await fetchJsonWithTimeout(url, YAHOO_TIMEOUT_MS);
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) throw new Error("Yahoo chart result empty");

    const meta = result.meta || {};
    const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
    const closes = quote && quote.close ? quote.close : [];

    const price =
      toNumber(meta.regularMarketPrice) ??
      toNumber(meta.previousClose) ??
      lastFinite(closes);

    const previous =
      toNumber(meta.chartPreviousClose) ??
      previousFinite(closes) ??
      toNumber(meta.previousClose);

    const marketChange = price !== null && previous !== null && previous !== 0
      ? ((price - previous) / previous) * 100
      : null;

    return {
      yahooSymbol,
      ok: marketChange !== null,
      price: round(price, 6),
      previous: round(previous, 6),
      marketChange: round(marketChange, 6),
      currency: meta.currency || null,
      exchangeName: meta.exchangeName || null,
      source: "Yahoo Finance chart",
      error: null,
    };
  } catch (error) {
    return {
      yahooSymbol,
      ok: false,
      price: null,
      previous: null,
      marketChange: null,
      source: "Yahoo Finance chart",
      error: error.message,
    };
  }
}

async function fetchQuotes(symbols) {
  const unique = Array.from(new Set(symbols.filter(Boolean))).slice(0, MAX_SYMBOLS_TO_PRICE);
  const quoteMap = new Map();
  const batchSize = 8;

  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(fetchYahooQuote));
    for (const quote of results) {
      if (quote && quote.yahooSymbol) quoteMap.set(quote.yahooSymbol, quote);
    }
  }

  return quoteMap;
}

function direction(value) {
  const n = toNumber(value, 0);
  if (n > 0.05) return "up";
  if (n < -0.05) return "down";
  return "flat";
}

function gradeCoverage(coverage) {
  if (coverage >= 75) return "high";
  if (coverage >= 50) return "medium";
  if (coverage >= 25) return "low";
  return "weak";
}

function buildFundReport(fund, selected, quoteMap) {
  const normalized = normalizeWeights(selected.rows);
  const totalWeight = normalized.reduce((sum, item) => sum + (item.weight || 0), 0);

  const priced = [];
  const unpriced = [];

  for (const item of normalized) {
    const quote = item.yahooSymbol ? quoteMap.get(item.yahooSymbol) : null;
    const isPriced = quote && quote.ok && quote.marketChange !== null;
    const contribution = isPriced ? (item.weight / 100) * quote.marketChange : 0;

    const detail = {
      symbol: item.symbol,
      yahooSymbol: item.yahooSymbol,
      name: item.name,
      assetType: item.assetType,
      assetClass: item.assetClass,
      weight: round(item.weight, 4),
      marketChange: isPriced ? round(quote.marketChange, 4) : null,
      contribution: isPriced ? round(contribution, 4) : null,
      pricingSource: isPriced ? quote.source : null,
      pricingIssue: !isPriced ? (quote && quote.error ? quote.error : "not priced or not stock") : null,
    };

    if (isPriced) priced.push(detail);
    else unpriced.push(detail);
  }

  const pricedWeight = priced.reduce((sum, item) => sum + (item.weight || 0), 0);
  const stockWeight = normalized
    .filter((item) => item.assetClass === "stock")
    .reduce((sum, item) => sum + (item.weight || 0), 0);
  const causalNavChange = priced.reduce((sum, item) => sum + (item.contribution || 0), 0);
  const positiveContribution = priced.filter((x) => (x.contribution || 0) > 0).reduce((sum, x) => sum + x.contribution, 0);
  const negativeContribution = priced.filter((x) => (x.contribution || 0) < 0).reduce((sum, x) => sum + x.contribution, 0);

  const topNegative = priced
    .filter((x) => (x.contribution || 0) < 0)
    .sort((a, b) => a.contribution - b.contribution)
    .slice(0, 12);

  const topPositive = priced
    .filter((x) => (x.contribution || 0) > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 12);

  const coverageRatio = totalWeight > 0 ? (pricedWeight / totalWeight) * 100 : 0;
  const stockCoverageRatio = stockWeight > 0 ? (pricedWeight / stockWeight) * 100 : 0;

  let verdict = "not_enough_data";
  if (selected.rows.length && coverageRatio >= 60) verdict = "causal_signal_usable";
  else if (selected.rows.length && coverageRatio >= 30) verdict = "partial_signal";
  else if (selected.rows.length) verdict = "weak_signal_unpriced_holdings";

  return {
    fund,
    reportDate: selected.reportDate,
    holdingsCount: selected.rows.length,
    totalWeight: round(totalWeight, 4),
    stockWeight: round(stockWeight, 4),
    pricedWeight: round(pricedWeight, 4),
    unpricedWeight: round(Math.max(totalWeight - pricedWeight, 0), 4),
    coverageRatio: round(coverageRatio, 2),
    stockCoverageRatio: round(stockCoverageRatio, 2),
    coverageGrade: gradeCoverage(coverageRatio),
    causalNavChange: round(causalNavChange, 4),
    signalDirection: direction(causalNavChange),
    positiveContribution: round(positiveContribution, 4),
    negativeContribution: round(negativeContribution, 4),
    verdict,
    topNegative,
    topPositive,
    unpricedHoldings: unpriced
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 25),
    pricedHoldings: priced
      .sort((a, b) => Math.abs(b.contribution || 0) - Math.abs(a.contribution || 0))
      .slice(0, 40),
  };
}

module.exports = async function handler(req, res) {
  try {
    const manual = String((req.query && req.query.manual) || "");
    if (manual !== "finscope") {
      return setJson(res, 401, {
        ok: false,
        version: API_VERSION,
        error: "Unauthorized. Use ?manual=finscope",
      });
    }

    const holdings = await supabaseGet("fund_holdings?select=*&fund_code=in.(PBR,PHE,TLY,THF)&limit=2500");
    const selectedByFund = selectLatestHoldings(holdings);

    const allNormalized = [];
    for (const selected of selectedByFund.values()) {
      allNormalized.push(...normalizeWeights(selected.rows));
    }

    const symbolWeight = new Map();
    for (const item of allNormalized) {
      if (!item.yahooSymbol) continue;
      symbolWeight.set(item.yahooSymbol, (symbolWeight.get(item.yahooSymbol) || 0) + (item.weight || 0));
    }

    const symbols = Array.from(symbolWeight.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([symbol]) => symbol);

    const quoteMap = await fetchQuotes(symbols);
    const byFund = {};

    for (const fund of FUNDS) {
      const selected = selectedByFund.get(fund) || { fund, reportDate: null, rows: [] };
      byFund[fund] = buildFundReport(fund, selected, quoteMap);
    }

    const portfolioFreshness = Object.fromEntries(
      FUNDS.map((fund) => [fund, byFund[fund].reportDate])
    );

    const summary = {
      funds: FUNDS,
      holdingsRows: holdings.length,
      pricedSymbolsRequested: symbols.length,
      pricedSymbolsUsed: quoteMap.size,
      maxSymbolsToPrice: MAX_SYMBOLS_TO_PRICE,
      portfolioFreshness,
      averageCoverageRatio: round(
        FUNDS.reduce((sum, fund) => sum + (byFund[fund].coverageRatio || 0), 0) / FUNDS.length,
        2
      ),
      averageCausalNavChange: round(
        FUNDS.reduce((sum, fund) => sum + (byFund[fund].causalNavChange || 0), 0) / FUNDS.length,
        4
      ),
      nextStep: "If coverage is high but prediction is weak, api/predict.js must use causalNavChange as the primary prediction input. If coverage is weak, symbol mapping and holdings quality must be fixed first.",
    };

    return setJson(res, 200, {
      ok: true,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
      source: "fund_holdings + Yahoo Finance chart",
      modelPrinciple: "fund prediction must be built from holding weight x market move contributions",
      funds: FUNDS,
      summary,
      byFund,
      disclaimer: "Diagnostic report only. It does not change Supabase data and is not investment advice.",
    });
  } catch (error) {
    return setJson(res, 500, {
      ok: false,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
      error: error.message,
    });
  }
};
