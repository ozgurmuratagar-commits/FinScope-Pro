// api/causal-nav-report.js
// FinScope Causal NAV Coverage Report API v1.1 - Deploy Safe
// Bu endpoint veri yazmaz. Sadece fund_holdings tablosunu okuyarak
// tahmin motoru icin fon icerigi ve agirlik kapsamasini raporlar.

const API_VERSION = "FinScope Causal NAV Coverage Report API v1.1 - Deploy Safe";
const FUNDS = ["PBR", "PHE", "TLY", "THF"];

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(JSON.stringify(body));
}

function getQueryValue(req, key) {
  if (req && req.query && req.query[key] !== undefined) return req.query[key];
  try {
    const parsed = new URL(req.url, "http://localhost");
    return parsed.searchParams.get(key);
  } catch (error) {
    return null;
  }
}

function cleanText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function upper(value) {
  return cleanText(value).toUpperCase();
}

function firstValue(row, fields) {
  for (let i = 0; i < fields.length; i += 1) {
    const key = fields[i];
    if (row && row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }
  }
  return null;
}

function toNumber(value, fallback) {
  if (fallback === undefined) fallback = null;
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;

  let text = String(value).trim().replace("%", "");
  if (!text) return fallback;

  // 1.234,56 -> 1234.56 ; 1234,56 -> 1234.56 ; 1234.56 -> 1234.56
  if (text.indexOf(",") >= 0) {
    text = text.replace(/\./g, "").replace(",", ".");
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits) {
  if (digits === undefined) digits = 4;
  const n = toNumber(value, null);
  if (n === null) return null;
  const factor = Math.pow(10, digits);
  return Math.round(n * factor) / factor;
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

  return {
    url: String(url).replace(/\/$/, ""),
    key: key,
  };
}

async function supabaseGet(path) {
  const cfg = getSupabaseConfig();
  const endpoint = cfg.url + "/rest/v1/" + path;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      apikey: cfg.key,
      Authorization: "Bearer " + cfg.key,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = text;
  }

  if (!response.ok) {
    throw new Error("Supabase GET failed: HTTP " + response.status + " - " + text.slice(0, 500));
  }

  return Array.isArray(data) ? data : [];
}

function getFundCode(row) {
  return upper(firstValue(row, ["fund_code", "fundCode", "fund", "code"]));
}

function getDateValue(row) {
  const value = firstValue(row, [
    "report_date",
    "reportDate",
    "holding_date",
    "holdingDate",
    "portfolio_date",
    "portfolioDate",
    "as_of_date",
    "date",
    "updated_at",
    "created_at",
  ]);

  if (!value) return null;
  const text = String(value);
  const datePart = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : text;
}

function getSymbol(row) {
  return upper(firstValue(row, [
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
  return cleanText(firstValue(row, [
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
  return upper(firstValue(row, [
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
  return toNumber(firstValue(row, [
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
  ]), null);
}

function looksLikeStock(assetType, symbol, name) {
  const text = (assetType + " " + symbol + " " + name).toUpperCase();

  if (text.indexOf("HISSE") >= 0) return true;
  if (text.indexOf("STOCK") >= 0) return true;
  if (/^[A-Z]{2,6}[0-9]?$/.test(symbol)) return true;
  if (/^[A-Z0-9.-]+\.IS$/.test(symbol)) return true;

  return false;
}

function looksLikeCash(assetType, symbol, name) {
  const text = (assetType + " " + symbol + " " + name).toUpperCase();
  return (
    text.indexOf("NAKIT") >= 0 ||
    text.indexOf("CASH") >= 0 ||
    text.indexOf("MEVDUAT") >= 0 ||
    text.indexOf("DEPOSIT") >= 0 ||
    text.indexOf("REPO") >= 0
  );
}

function looksLikeBond(assetType, symbol, name) {
  const text = (assetType + " " + symbol + " " + name).toUpperCase();
  return (
    text.indexOf("TAHVIL") >= 0 ||
    text.indexOf("BONO") >= 0 ||
    text.indexOf("BOND") >= 0 ||
    text.indexOf("EUROBOND") >= 0 ||
    text.indexOf("DIBS") >= 0
  );
}

function classify(row) {
  const assetType = getAssetType(row);
  const symbol = getSymbol(row);
  const name = getName(row);

  if (looksLikeCash(assetType, symbol, name)) return "cash";
  if (looksLikeBond(assetType, symbol, name)) return "bond";
  if (looksLikeStock(assetType, symbol, name)) return "stock";
  return "other";
}

function normalizeSymbol(symbol) {
  let s = upper(symbol);
  if (!s) return null;

  s = s.replace(/\s+/g, "");
  s = s.replace(/\.E$/i, "");
  s = s.replace(/\.IS$/i, "");
  s = s.replace(/_E$/i, "");

  if (!s || FUNDS.indexOf(s) >= 0) return null;
  if (["TRY", "TL", "USD", "EUR", "GBP", "CASH", "NAKIT"].indexOf(s) >= 0) return null;

  if (/^[A-Z]{2,6}[0-9]?$/.test(s)) return s + ".IS";
  if (/^[A-Z0-9.-]+\.IS$/.test(s)) return s;
  return null;
}

function sortDateDesc(a, b) {
  const ad = getDateValue(a) || "";
  const bd = getDateValue(b) || "";
  if (ad !== bd) return bd.localeCompare(ad);

  const au = String(a.updated_at || a.created_at || "");
  const bu = String(b.updated_at || b.created_at || "");
  return bu.localeCompare(au);
}

function latestRowsForFund(allRows, fund) {
  const rows = allRows.filter(function (row) {
    return getFundCode(row) === fund;
  }).sort(sortDateDesc);

  if (!rows.length) return { fund: fund, reportDate: null, rows: [] };

  const latestDate = getDateValue(rows[0]);
  const latestRows = latestDate ? rows.filter(function (row) {
    return getDateValue(row) === latestDate;
  }) : rows;

  return { fund: fund, reportDate: latestDate, rows: latestRows };
}

function normalizeWeights(rows) {
  const values = rows.map(getRawWeight).filter(function (n) {
    return n !== null && Number.isFinite(n);
  });

  const rawSum = values.reduce(function (sum, n) {
    return sum + n;
  }, 0);

  return rows.map(function (row) {
    let weight = getRawWeight(row);
    if (weight === null) weight = 0;

    if (rawSum > 0 && rawSum <= 1.5) {
      weight = weight * 100;
    } else if (rawSum > 120) {
      weight = (weight / rawSum) * 100;
    }

    const symbol = getSymbol(row);
    const assetType = getAssetType(row);
    const name = getName(row);
    const assetClass = classify(row);

    return {
      symbol: symbol,
      yahooSymbol: assetClass === "stock" ? normalizeSymbol(symbol) : null,
      name: name,
      assetType: assetType,
      assetClass: assetClass,
      rawWeight: round(getRawWeight(row), 6),
      weight: round(weight, 6),
    };
  });
}

function buildReportForFund(allRows, fund) {
  const latest = latestRowsForFund(allRows, fund);
  const normalized = normalizeWeights(latest.rows);

  let totalWeight = 0;
  let stockWeight = 0;
  let priceCandidateWeight = 0;
  let cashWeight = 0;
  let bondWeight = 0;
  let otherWeight = 0;

  normalized.forEach(function (item) {
    const w = item.weight || 0;
    totalWeight += w;

    if (item.assetClass === "stock") stockWeight += w;
    else if (item.assetClass === "cash") cashWeight += w;
    else if (item.assetClass === "bond") bondWeight += w;
    else otherWeight += w;

    if (item.yahooSymbol) priceCandidateWeight += w;
  });

  const topHoldings = normalized
    .slice()
    .sort(function (a, b) {
      return (b.weight || 0) - (a.weight || 0);
    })
    .slice(0, 25);

  const topStockCandidates = normalized
    .filter(function (item) {
      return item.yahooSymbol;
    })
    .sort(function (a, b) {
      return (b.weight || 0) - (a.weight || 0);
    })
    .slice(0, 30);

  const coverageRatio = totalWeight > 0 ? (priceCandidateWeight / totalWeight) * 100 : 0;

  let verdict = "no_holdings";
  if (latest.rows.length && coverageRatio >= 60) verdict = "causal_engine_ready_for_pricing";
  else if (latest.rows.length && coverageRatio >= 30) verdict = "partial_coverage_needs_symbol_mapping";
  else if (latest.rows.length) verdict = "weak_coverage_holdings_not_priced";

  return {
    fund: fund,
    reportDate: latest.reportDate,
    holdingsCount: latest.rows.length,
    totalWeight: round(totalWeight, 4),
    stockWeight: round(stockWeight, 4),
    cashWeight: round(cashWeight, 4),
    bondWeight: round(bondWeight, 4),
    otherWeight: round(otherWeight, 4),
    priceCandidateWeight: round(priceCandidateWeight, 4),
    priceCandidateCoverageRatio: round(coverageRatio, 2),
    verdict: verdict,
    topHoldings: topHoldings,
    topStockCandidates: topStockCandidates,
  };
}

module.exports = async function handler(req, res) {
  try {
    const manual = String(getQueryValue(req, "manual") || "");
    if (manual !== "finscope") {
      return sendJson(res, 401, {
        ok: false,
        version: API_VERSION,
        error: "Yetkisiz istek. Kullanım: ?manual=finscope",
      });
    }

    const holdings = await supabaseGet("fund_holdings?select=*&fund_code=in.(PBR,PHE,TLY,THF)&limit=3000");

    const byFund = {};
    FUNDS.forEach(function (fund) {
      byFund[fund] = buildReportForFund(holdings, fund);
    });

    const summary = {
      funds: FUNDS,
      holdingsRows: holdings.length,
      averagePriceCandidateCoverage: round(
        FUNDS.reduce(function (sum, fund) {
          return sum + (byFund[fund].priceCandidateCoverageRatio || 0);
        }, 0) / FUNDS.length,
        2
      ),
      principle: "Tahmin motoru fon icerigi, varlik agirligi ve fiyat hareketi carpimindan uretilmelidir.",
      currentLayer: "Bu guvenli surum fiyat cekmez; once holdings/agirlik/symbol altyapisini kontrol eder.",
      nextStep: "Bu endpoint calistiktan sonra fiyatlama katmani ve api/predict.js Causal NAV entegrasyonu eklenecek.",
    };

    return sendJson(res, 200, {
      ok: true,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
      source: "Supabase fund_holdings only",
      destructive: false,
      summary: summary,
      byFund: byFund,
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
      error: error.message,
    });
  }
};
