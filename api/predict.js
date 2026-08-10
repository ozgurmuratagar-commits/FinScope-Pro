const FUNDS = ["PBR", "PHE", "TLY"];

const MODEL_NAME = "FinScope Prediction Engine v6 - Actual Error Learning Model";
const MODEL_KEY = "v6_actual_error_learning";

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
  const n = num(value, 0);
  return Number(n.toFixed(digits));
}

function todayTR() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(now);
}

function nowHourTR() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    hour12: false
  });
  return Number(formatter.format(now));
}

function nextBusinessDay(dateText) {
  const d = new Date(dateText + "T12:00:00Z");

  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);

  return d.toISOString().slice(0, 10);
}

function choosePredictionDate(latestFundDate) {
  const trToday = todayTR();
  const hour = nowHourTR();

  if (latestFundDate && latestFundDate >= trToday && hour >= 18) {
    return nextBusinessDay(latestFundDate);
  }

  if (latestFundDate && latestFundDate > trToday) {
    return latestFundDate;
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

async function getLatestFundPrices() {
  const rows = await supabaseRequest(
    "fund_prices?select=*&fund_code=in.(PBR,PHE,TLY)&order=price_date.desc,created_at.desc&limit=80"
  );

  const latest = {};

  for (const row of rows) {
    if (!latest[row.fund_code]) {
      latest[row.fund_code] = row;
    }
  }

  return latest;
}

async function getHoldings() {
  const rows = await supabaseRequest(
    "fund_holdings?select=*&fund_code=in.(PBR,PHE,TLY)&order=fund_code.asc,weight.desc"
  );

  const grouped = {};

  for (const code of FUNDS) {
    grouped[code] = [];
  }

  for (const row of rows) {
    if (!grouped[row.fund_code]) grouped[row.fund_code] = [];
    grouped[row.fund_code].push(row);
  }

  return grouped;
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

  symbols.add("XU100");
  symbols.add("USDTRY");
  symbols.add("DXY");

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

function proxyChangeForNonStock(assetType, symbol) {
  const type = String(assetType || "").toUpperCase();
  const sym = String(symbol || "").toUpperCase();

  if (type.includes("MONEY") || sym.includes("REPO") || sym.includes("PARA")) {
    return 0.12;
  }

  if (type.includes("CASH") || sym === "TRY") {
    return 0;
  }

  if (type.includes("BOND") || type.includes("DEBT")) {
    return 0.05;
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
    marketChange: proxyChangeForNonStock(assetType, symbol),
    directPricing: false,
    pricingSource: "non-stock proxy"
  };
}

async function getCalibrationRows() {
  const rows = await supabaseRequest(
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY)&actual_change=not.is.null&error_change=not.is.null&order=updated_at.desc,created_at.desc&limit=150"
  );

  const byFund = {};

  for (const code of FUNDS) {
    byFund[code] = rows.filter(r => r.fund_code === code);
  }

  return byFund;
}

function getCalibrationForFund(code, calibrationRows) {
  const rows = calibrationRows[code] || [];

  if (!rows.length) {
    return {
      status: "no_history",
      sampleSize: 0,
      averageError: 0,
      offset: 0
    };
  }

  const recent = rows.slice(0, 20);
  const avgError =
    recent.reduce((sum, row) => sum + num(row.error_change, 0), 0) / recent.length;

  return {
    status: "learned",
    sampleSize: recent.length,
    averageError: round(avgError, 4),
    offset: round(clamp(avgError, -0.45, 0.45), 4)
  };
}

function buildPredictionForFund(code, holdings, marketChanges, latestFundPrice, calibration) {
  const details = [];

  let weightedChange = 0;
  let directWeight = 0;
  let totalWeight = 0;
  let positiveContribution = 0;
  let negativeContribution = 0;

  for (const h of holdings) {
    const weight = num(h.weight, 0);
    if (weight <= 0) continue;

    const pricing = getHoldingMarketChange(h, marketChanges);
    const contribution = (weight / 100) * pricing.marketChange;

    totalWeight += weight;
    weightedChange += contribution;

    if (pricing.directPricing) directWeight += weight;
    if (contribution >= 0) positiveContribution += contribution;
    if (contribution < 0) negativeContribution += contribution;

    details.push({
      assetType: h.asset_type,
      symbol: h.symbol,
      name: h.name,
      weight: round(weight, 4),
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

  const residualContribution = (residualWeight / 100) * latestActual * 0.35;
  const unsmoothedChange = weightedChange + residualContribution;

  const volatility = Math.abs(unsmoothedChange);
  let smoothingFactor = 0.58;

  if (volatility > 2.5) smoothingFactor = 0.42;
  else if (volatility > 1.5) smoothingFactor = 0.48;
  else if (volatility < 0.5) smoothingFactor = 0.68;

  const smoothedChange = unsmoothedChange * smoothingFactor;
  const smoothingImpact = smoothedChange - unsmoothedChange;

  const calibratedChange = clamp(
    smoothedChange + calibration.offset,
    -2.25,
    2.25
  );

  const coverage = clamp(totalWeight, 0, 100);

  const confidence =
    coverage >= 98
      ? 88 + Math.min(5, calibration.sampleSize)
      : coverage >= 80
        ? 78
        : 68;

  return {
    status: "v6_actual_error_learning",
    predictedChange: round(calibratedChange, 4),
    rawPredictedChange: round(smoothedChange, 4),
    unsmoothedChange: round(unsmoothedChange, 4),
    rangeLow: round(calibratedChange - 0.45, 4),
    rangeHigh: round(calibratedChange + 0.45, 4),
    confidence: clamp(confidence, 60, 96),
    confidenceText: confidenceText(confidence),
    coverage: round(coverage, 2),
    missingWeight: round(residualWeight, 2),
    residualWeight: round(residualWeight, 2),
    directPricedWeight: round(directWeight, 2),
    proxyWeight: round(100 - directWeight, 2),
    positiveContribution: round(positiveContribution, 4),
    negativeContribution: round(negativeContribution, 4),
    smoothingFactor: round(smoothingFactor, 4),
    smoothingImpact: round(smoothingImpact, 4),
    calibrationOffset: round(calibration.offset, 4),
    calibration,
    observations: details.length,
    methodology:
      "v6: eski bekleyen tahminleri gerçek TEFAS verisiyle kapatır, hata sapmasını öğrenir, holdings ağırlıklı piyasa hareketini TEFAS yumuşatma filtresiyle gerçekçi aralığa çeker.",
    details
  };
}

async function savePredictionHistory(predictionDate, predictions) {
  const saved = [];

  for (const code of FUNDS) {
    const p = predictions[code];
    if (!p) continue;

    const payload = {
      fund_code: code,
      prediction_date: predictionDate,
      model: MODEL_KEY,
      model_version: MODEL_NAME,
      raw_predicted_change: p.rawPredictedChange,
      calibrated_change: p.predictedChange,
      calibration_offset: p.calibrationOffset,
      confidence: p.confidence,
      coverage: p.coverage,
      residual_weight: p.residualWeight,
      sample_size: p.calibration ? p.calibration.sampleSize : 0,
      updated_at: new Date().toISOString()
    };

    const existing = await supabaseRequest(
      `prediction_history?select=id&fund_code=eq.${encodeURIComponent(code)}&prediction_date=eq.${encodeURIComponent(predictionDate)}&model=eq.${encodeURIComponent(MODEL_KEY)}&limit=1`
    );

    if (existing && existing.length > 0) {
      const patched = await supabaseRequest(
        `prediction_history?id=eq.${encodeURIComponent(existing[0].id)}`,
        {
          method: "PATCH",
          body: payload
        }
      );

      saved.push({
        fundCode: code,
        action: "updated",
        id: existing[0].id,
        rows: patched
      });
    } else {
      const inserted = await supabaseRequest("prediction_history", {
        method: "POST",
        body: [
          {
            ...payload,
            actual_change: null,
            error_change: null
          }
        ]
      });

      saved.push({
        fundCode: code,
        action: "inserted",
        rows: inserted
      });
    }
  }

  return saved;
}

async function updatePendingActuals(latestFundPrices) {
  const pendingRows = await supabaseRequest(
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY)&actual_change=is.null&order=created_at.asc&limit=300"
  );

  const today = todayTR();
  const updated = [];

  for (const row of pendingRows) {
    const code = row.fund_code;
    const predictionDate = row.prediction_date;
    const latest = latestFundPrices[code];

    if (!latest || !predictionDate) continue;

    const latestDate = latest.price_date || latest.date;
    const latestUpdatedAt = latest.updated_at || latest.created_at;
    const rowCreatedAt = row.created_at;

    const sameDateActualArrivedAfterPrediction =
      latestDate === predictionDate &&
      latestUpdatedAt &&
      rowCreatedAt &&
      new Date(latestUpdatedAt).getTime() > new Date(rowCreatedAt).getTime();

    const olderPredictionCanBeClosed =
      predictionDate < today && latestDate >= predictionDate;

    if (!sameDateActualArrivedAfterPrediction && !olderPredictionCanBeClosed) {
      continue;
    }

    const actual = num(latest.daily_change);
    const predicted =
      num(row.calibrated_change) ??
      num(row.predicted_change) ??
      num(row.raw_predicted_change);

    if (actual === null || predicted === null) continue;

    const error = actual - predicted;

    await supabaseRequest(
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
      predicted: round(predicted, 4),
      actual: round(actual, 4),
      error: round(error, 4)
    });
  }

  return updated;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const latestFundPrices = await getLatestFundPrices();

    const actualUpdates = await updatePendingActuals(latestFundPrices);

    const groupedHoldings = await getHoldings();
    const marketChanges = await getMarketChangesForHoldings(groupedHoldings);
    const calibrationRows = await getCalibrationRows();

    const latestDates = FUNDS
      .map(code => latestFundPrices[code] && latestFundPrices[code].price_date)
      .filter(Boolean)
      .sort();

    const latestFundDate = latestDates[latestDates.length - 1] || todayTR();
    const predictionDate = choosePredictionDate(latestFundDate);

    const predictions = {};

    for (const code of FUNDS) {
      const calibration = getCalibrationForFund(code, calibrationRows);

      predictions[code] = buildPredictionForFund(
        code,
        groupedHoldings[code] || [],
        marketChanges,
        latestFundPrices[code] || null,
        calibration
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

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      model: MODEL_NAME,
      modelKey: MODEL_KEY,
      horizon: "next published daily fund return",
      marketSource: "Yahoo Finance delayed market data + BIST proxy fallback",
      holdingsSource: "supabase.fund_holdings",
      calibrationSource: "supabase.prediction_history",
      actualUpdate: {
        updated: actualUpdates.length,
        rows: actualUpdates
      },
      latestByFund,
      predictionDate,
      savedToday: savedRows.length,
      saveActions: savedRows,
      funds: FUNDS,
      predictions,
      disclaimer:
        "Bu tahminler model bazlıdır, kesinlik içermez ve yatırım tavsiyesi değildir."
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err.message || err),
      model: MODEL_NAME,
      modelKey: MODEL_KEY
    });
  }
};
