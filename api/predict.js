const FUNDS = ["PBR", "PHE", "TLY"];

const DEFAULT_REPO_DAILY_CHANGE = Number(process.env.REPO_DAILY_CHANGE || 0.12);
const DEFAULT_CASH_DAILY_CHANGE = Number(process.env.CASH_DAILY_CHANGE || 0);

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 4) {
  const n = Number(v || 0);
  return Number(n.toFixed(d));
}

function confidenceText(v) {
  v = Number(v || 0);
  if (v >= 90) return "Çok yüksek";
  if (v >= 75) return "Yüksek";
  if (v >= 60) return "Orta";
  if (v > 0) return "Düşük";
  return "—";
}

async function supabaseGet(path, key) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase GET ${path} HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Supabase JSON parse error: ${text.slice(0, 500)}`);
  }
}

async function fetchMarketFromSelf(req) {
  try {
    const host = req.headers.host;
    const protocol =
      req.headers["x-forwarded-proto"] ||
      (host && host.includes("localhost") ? "http" : "https");

    const url = `${protocol}://${host}/api/market?t=${Date.now()}`;

    const response = await fetch(url, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`market HTTP ${response.status}`);
    }

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
  if (s === "TRY" || s === "CASH") return "TRY";
  if (s === "REPO" || s === "MONEY_MARKET") return "REPO";
  if (s === "USD" || s === "USDTRY") return "USDTRY";
  if (s === "EUR" || s === "EURTRY") return "EURTRY";
  if (s === "GOLD" || s === "XAU") return "XAU";
  if (s === "SILVER" || s === "XAG") return "XAG";

  return s;
}

function assetChangeFromMarket(asset, marketAssets) {
  const type = String(asset.asset_type || asset.assetType || "").toUpperCase();
  const symbol = normalizeSymbol(asset.symbol);

  if (type === "CASH" || symbol === "TRY") {
    return {
      change: DEFAULT_CASH_DAILY_CHANGE,
      source: "cash/TRY varsayımı"
    };
  }

  if (
    type === "MONEY_MARKET" ||
    type === "REPO" ||
    symbol === "REPO" ||
    symbol === "MONEY_MARKET"
  ) {
    return {
      change: DEFAULT_REPO_DAILY_CHANGE,
      source: "repo/para piyasası günlük varsayım"
    };
  }

  if (type === "STOCK") {
    if (marketAssets[symbol] && marketAssets[symbol].change != null) {
      return {
        change: num(marketAssets[symbol].change),
        source: `market:${symbol}`
      };
    }

    if (marketAssets.XU100 && marketAssets.XU100.change != null) {
      return {
        change: num(marketAssets.XU100.change),
        source: "XU100 proxy"
      };
    }

    return {
      change: 0,
      source: "stock değişim bulunamadı"
    };
  }

  if (type === "BIST" || symbol === "XU100") {
    return {
      change: num(marketAssets.XU100 && marketAssets.XU100.change) || 0,
      source: "XU100"
    };
  }

  if (type === "FX" || symbol === "USDTRY" || symbol === "EURTRY") {
    const key = symbol === "EUR" ? "EURTRY" : symbol;
    return {
      change: num(marketAssets[key] && marketAssets[key].change) || 0,
      source: key
    };
  }

  if (type === "GOLD" || type === "PRECIOUS_METAL" || symbol === "XAU") {
    return {
      change: num(marketAssets.XAU && marketAssets.XAU.change) || 0,
      source: "XAU"
    };
  }

  if (type === "SILVER" || symbol === "XAG") {
    return {
      change: num(marketAssets.XAG && marketAssets.XAG.change) || 0,
      source: "XAG"
    };
  }

  if (type === "BOND" || type === "EUROBOND" || type === "DEBT") {
    return {
      change: DEFAULT_REPO_DAILY_CHANGE * 0.6,
      source: "tahvil/borçlanma proxy"
    };
  }

  return {
    change: 0,
    source: "bilinmeyen varlık tipi"
  };
}

function buildPredictions(holdingsRows, marketJson) {
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

    let predicted = 0;
    let coveredWeight = 0;
    let totalWeight = 0;
    let positiveContribution = 0;
    let negativeContribution = 0;

    const details = [];

    for (const h of holdings) {
      const weight = num(h.weight) || 0;
      totalWeight += weight;

      const move = assetChangeFromMarket(h, marketAssets);
      const change = num(move.change) || 0;
      const contribution = (weight * change) / 100;

      predicted += contribution;
      coveredWeight += weight;

      if (contribution >= 0) positiveContribution += contribution;
      else negativeContribution += contribution;

      details.push({
        assetType: h.asset_type,
        symbol: h.symbol,
        name: h.name,
        weight: round(weight, 4),
        marketChange: round(change, 4),
        contribution: round(contribution, 4),
        pricingSource: move.source,
        reportDate: h.reportDate,
        source: h.source
      });
    }

    const coverage = Math.min(100, totalWeight);
    const missingWeight = Math.max(0, 100 - coverage);

    const volatilityBuffer =
      coverage >= 95 ? 0.28 :
      coverage >= 80 ? 0.45 :
      coverage >= 60 ? 0.70 :
      1.10;

    const rangeLow = predicted - volatilityBuffer;
    const rangeHigh = predicted + volatilityBuffer;

    const confidence = Math.min(
      92,
      Math.max(
        35,
        Math.round(40 + coverage * 0.45 + Math.min(details.length, 20) * 0.4)
      )
    );

    predictions[code] = {
      status: holdings.length ? "holdings_weighted" : "no_holdings",
      predictedChange: round(predicted, 4),
      rangeLow: round(rangeLow, 4),
      rangeHigh: round(rangeHigh, 4),
      confidence,
      confidenceText: confidenceText(confidence),
      coverage: round(coverage, 2),
      missingWeight: round(missingWeight, 2),
      observations: details.length,
      positiveContribution: round(positiveContribution, 4),
      negativeContribution: round(negativeContribution, 4),
      methodology:
        "Holdings ağırlıklı model: varlık ağırlığı x gün içi piyasa değişimi",
      horizon: "next published daily fund return",
      details
    };
  }

  return predictions;
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

    const holdingsRows = await supabaseGet(
      "fund_holdings?select=*&order=fund_code.asc,weight.desc",
      supabaseKey
    );

    const marketJson = await fetchMarketFromSelf(req);

    const predictions = buildPredictions(holdingsRows, marketJson);

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      model: "FinScope Holdings Weighted Prediction v1",
      horizon: "next published daily fund return",
      marketSource: marketJson.version || "api/market",
      holdingsSource: "supabase.fund_holdings",
      funds: FUNDS,
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
