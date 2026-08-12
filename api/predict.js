const FUNDS = ["PBR", "PHE", "TLY"];

const MODEL_NAME = "FinScope Prediction Engine v7.2 - Safe Current Prediction";

/*
  Model key'i şimdilik v7_1_accuracy_layer olarak koruyoruz.
  Çünkü performance.js ve predictions.js bu model key üzerinden okuyor.
*/
const MODEL_KEY = "v7_1_accuracy_layer";

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

function nextBusinessDay(dateText) {
  const d = new Date(dateText + "T12:00:00Z");

  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);

  return d.toISOString().slice(0, 10);
}

function isWeekend(dateText) {
  const d = new Date(dateText + "T12:00:00Z");
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function choosePredictionDate(latestFundDate) {
  const trToday = todayTR();

  /*
    Kritik düzeltme:
    Eğer TEFAS fiyat tarihi bugün veya bugünden ileriyse,
    bugünün performansı artık kapanmış sayılır.
    Yeni tahmin aynı güne yazılmamalı; bir sonraki iş gününe yazılmalı.
  */
  if (latestFundDate && latestFundDate >= trToday) {
    return nextBusinessDay(latestFundDate);
  }

  /*
    Eğer son TEFAS tarihi bugünden eskiyse:
    - Bugün iş günüyse bugünkü açıklanacak TEFAS için tahmin üret.
    - Bugün hafta sonuysa son TEFAS tarihinden sonraki iş gününü hedefle.
  */
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

  for (const row of rows || []) {
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

  for (const row of rows || []) {
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
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY)&actual_change=not.is.null&error_change=not.is.null&order=updated_at.desc,created_at.desc&limit=240"
  );

  const byFund = {};

  for (const code of FUNDS) {
    byFund[code] = rows.filter(r => r.fund_code === code);
  }

  return byFund;
}

function calculateDirectionHit(row) {
  const predicted =
    num(row.calibrated_change) ??
    num(row.predicted_change) ??
    num(row.raw_predicted_change);

  const actual = num(row.actual_change);

  if (predicted === null || actual === null) return null;
  if (Math.abs(predicted) < 0.01 || Math.abs(actual) < 0.01) return null;

  return direction(predicted) === direction(actual);
}

function getAccuracyLayerForFund(code, calibrationRows) {
  const rows = calibrationRows[code] || [];

  if (!rows.length) {
    return {
      status: "no_history",
      sampleSize: 0,
      averageError: 0,
      recentError: 0,
      averageAbsoluteError: 0,
      directionHitRate: null,
      offset: 0,
      dampingFactor: 1,
      confidencePenalty: 0,
      note: "Geçmiş gerçekleşen veri yok; v7.2 düzeltmesi uygulanmadı."
    };
  }

  const recent = rows.slice(0, 24);
  const recentShort = rows.slice(0, 6);

  const averageError =
    recent.reduce((sum, row) => sum + num(row.error_change, 0), 0) / recent.length;

  const recentError =
    recentShort.reduce((sum, row) => sum + num(row.error_change, 0), 0) / recentShort.length;

  const averageAbsoluteError =
    recent.reduce((sum, row) => sum + Math.abs(num(row.error_change, 0)), 0) / recent.length;

  const directionHits = recent
    .map(calculateDirectionHit)
    .filter(v => v !== null);

  const directionHitRate =
    directionHits.length > 0
      ? (directionHits.filter(Boolean).length / directionHits.length) * 100
      : null;

  const learningStrength = clamp(recent.length / 12, 0.2, 1);

  const blendedError =
    averageError * 0.65 +
    recentError * 0.35;

  const offset = clamp(blendedError * learningStrength, -0.55, 0.55);

  let dampingFactor = 1;

  if (averageAbsoluteError > 1.4) dampingFactor = 0.82;
  else if (averageAbsoluteError > 1.0) dampingFactor = 0.88;
  else if (averageAbsoluteError > 0.7) dampingFactor = 0.94;

  let confidencePenalty = 0;

  if (averageAbsoluteError > 1.4) confidencePenalty = 12;
  else if (averageAbsoluteError > 1.0) confidencePenalty = 8;
  else if (averageAbsoluteError > 0.7) confidencePenalty = 4;

  if (directionHitRate !== null && directionHitRate < 45) {
    confidencePenalty += 5;
    dampingFactor = Math.min(dampingFactor, 0.9);
  }

  return {
    status: "learned",
    sampleSize: recent.length,
    averageError: round(averageError, 4),
    recentError: round(recentError, 4),
    averageAbsoluteError: round(averageAbsoluteError, 4),
    directionHitRate: directionHitRate === null ? null : round(directionHitRate, 2),
    offset: round(offset, 4),
    dampingFactor: round(dampingFactor, 4),
    confidencePenalty: round(confidencePenalty, 2),
    note: "v7.2 fon bazlı geçmiş sapma, yakın dönem hata ve yön isabetiyle tahmini kalibre etti."
  };
}

function buildPredictionForFund(code, holdings, marketChanges, latestFundPrice, accuracyLayer) {
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

  const afterErrorOffset = smoothedChange + accuracyLayer.offset;
  const afterDamping = afterErrorOffset * accuracyLayer.dampingFactor;

  const calibratedChange = clamp(afterDamping, -2.15, 2.15);
  const coverage = clamp(totalWeight, 0, 100);

  const baseConfidence =
    coverage >= 98
      ? 88 + Math.min(5, accuracyLayer.sampleSize)
      : coverage >= 80
        ? 78
        : 68;

  const confidence = clamp(baseConfidence - accuracyLayer.confidencePenalty, 60, 96);

  return {
    status: "v7_2_safe_current_prediction",
    predictedChange: round(calibratedChange, 4),
    rawPredictedChange: round(smoothedChange, 4),
    unsmoothedChange: round(unsmoothedChange, 4),
    preAccuracyChange: round(smoothedChange, 4),
    rangeLow: round(calibratedChange - 0.42, 4),
    rangeHigh: round(calibratedChange + 0.42, 4),
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
    calibrationOffset: round(accuracyLayer.offset, 4),
    accuracyDamping: round(accuracyLayer.dampingFactor, 4),
    calibration: accuracyLayer,
    accuracyLayer,
    observations: details.length,
    methodology:
      "v7.2: kapanmış performans kayıtlarını ezmeden, en son TEFAS fiyatından sonraki iş günü için bekleyen güncel tahmin üretir.",
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

      /*
        Güvenlik:
        Eğer aynı gün için kapalı/unique kayıt varsa asla onu ezme.
        Bir sonraki iş gününe fallback yap.
      */
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
  const rows = await supabaseRequest(
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY)&order=created_at.asc&limit=500"
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
        reason: "no_latest_fund_price"
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

    const actualUpdate = await updatePendingActuals(latestFundPrices);

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
      const accuracyLayer = getAccuracyLayerForFund(code, calibrationRows);

      predictions[code] = buildPredictionForFund(
        code,
        groupedHoldings[code] || [],
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
      closeLogic: "v7.2 safe current prediction; closed performance rows are never overwritten",
      latestFundDate,
      predictionDate,
      actualUpdate,
      latestByFund,
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
