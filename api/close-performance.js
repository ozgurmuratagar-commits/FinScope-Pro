const FUNDS = ["PBR", "PHE", "TLY"];

const API_VERSION = "FinScope Close Performance API v1";
const ACTIVE_MODEL = "v7_1_accuracy_layer";

function num(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  const n = num(value, null);
  if (n === null) return null;
  return Number(n.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dateText(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function isValidDateText(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
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
  if (Math.abs(p) < 0.01 || Math.abs(a) < 0.01) return null;

  return direction(p) === direction(a);
}

function gradeFromError(errorAbs) {
  const e = Math.abs(num(errorAbs, 0));

  if (e <= 0.25) return "Çok iyi";
  if (e <= 0.50) return "İyi";
  if (e <= 0.85) return "Makul";
  if (e <= 1.25) return "Zayıf";
  return "Çok zayıf";
}

function getBiasLabel(averageError) {
  const e = num(averageError, 0);

  if (e > 0.20) {
    return "Model temkinli kalıyor / düşük tahmin ediyor";
  }

  if (e < -0.20) {
    return "Model iyimser kalıyor / yüksek tahmin ediyor";
  }

  return "Dengeli";
}

function getLearningStatus(sampleSize, averageAbsoluteError, directionHitRate) {
  const n = num(sampleSize, 0);
  const err = num(averageAbsoluteError, null);
  const hit = num(directionHitRate, null);

  if (n === 0) return "Henüz öğrenme verisi yok";
  if (n < 5) return "Örnek sayısı düşük";
  if (err !== null && err <= 0.50 && hit !== null && hit >= 60) return "İyi öğreniyor";
  if (err !== null && err <= 0.85) return "Öğreniyor";
  if (err !== null && err > 1.25) return "Sapma yüksek";
  return "Takip ediliyor";
}

function average(rows, field) {
  const values = rows
    .map(row => num(row[field], null))
    .filter(value => value !== null);

  if (!values.length) return null;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

async function getFinalRows(req) {
  const queryDate = req.query && req.query.date;

  let path =
    "prediction_finals" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    "&finalization_status=eq.finalized" +
    "&order=prediction_date.asc,finalized_at.asc" +
    "&limit=500";

  if (isValidDateText(queryDate)) {
    path += `&prediction_date=eq.${encodeURIComponent(queryDate)}`;
  }

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

async function getExistingPerformanceRows() {
  const path =
    "prediction_performance" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    "&order=prediction_date.desc,closed_at.desc" +
    "&limit=1000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

async function getFundPriceRows() {
  const path =
    "fund_prices" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY)" +
    "&order=price_date.asc,created_at.asc" +
    "&limit=1000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

function makePerformanceKey(row) {
  return `${row.fund_code}|${dateText(row.prediction_date)}|${row.model || ACTIVE_MODEL}`;
}

function findActualPriceForFinal(finalRow, fundPrices) {
  const fundCode = finalRow.fund_code;
  const predictionDate = dateText(finalRow.prediction_date);

  const rows = fundPrices
    .filter(row => row.fund_code === fundCode)
    .filter(row => dateText(row.price_date))
    .filter(row => num(row.daily_change, null) !== null)
    .sort((a, b) => dateText(a.price_date).localeCompare(dateText(b.price_date)));

  const exact = rows.find(row => dateText(row.price_date) === predictionDate);

  if (exact) {
    return {
      row: exact,
      matchRule: "exact_price_date"
    };
  }

  const nextAvailable = rows.find(row => dateText(row.price_date) > predictionDate);

  if (nextAvailable) {
    return {
      row: nextAvailable,
      matchRule: "next_available_price_date"
    };
  }

  return null;
}

function buildPerformancePayload(finalRow, actualMatch) {
  const actualRow = actualMatch.row;

  const finalPrediction = num(finalRow.final_prediction_change, null);
  const actualChange = num(actualRow.daily_change, null);

  const errorChange = actualChange - finalPrediction;
  const absoluteError = Math.abs(errorChange);

  const predictedDirection =
    finalRow.predicted_direction || direction(finalPrediction);

  const actualDirection = direction(actualChange);

  const hit = directionHit(finalPrediction, actualChange);

  return {
    final_id: finalRow.id,

    fund_code: finalRow.fund_code,
    prediction_date: dateText(finalRow.prediction_date),

    model: finalRow.model || ACTIVE_MODEL,
    model_version: finalRow.model_version || null,

    final_prediction_change: round(finalPrediction, 6),
    actual_change: round(actualChange, 6),

    error_change: round(errorChange, 6),
    absolute_error: round(absoluteError, 6),

    predicted_direction: predictedDirection,
    actual_direction: actualDirection,
    direction_hit: hit,

    grade: gradeFromError(absoluteError),
    note:
      "Sapma = gerçekleşen TEFAS değişimi - prediction_finals tablosundaki kilitli nihai tahmin.",

    actual_price: round(actualRow.price, 8),
    actual_price_date: dateText(actualRow.price_date),

    closed_at: new Date().toISOString(),
    status: "closed",

    updated_at: new Date().toISOString()
  };
}

async function upsertPerformanceRows(payloads) {
  if (!payloads.length) return [];

  const path =
    "prediction_performance" +
    "?on_conflict=fund_code,prediction_date,model";

  return await supabaseRequest(path, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: payloads
  });
}

function computeLearningStatsForFund(fundCode, performanceRows) {
  const rows = performanceRows
    .filter(row => row.fund_code === fundCode)
    .filter(row => row.model === ACTIVE_MODEL)
    .sort((a, b) =>
      String(b.prediction_date || "").localeCompare(String(a.prediction_date || ""))
    );

  const sampleSize = rows.length;
  const last5 = rows.slice(0, 5);
  const last10 = rows.slice(0, 10);

  const averageError = average(rows, "error_change");
  const averageAbsoluteError = average(rows, "absolute_error");

  const last5AverageError = average(last5, "error_change");
  const last5AverageAbsoluteError = average(last5, "absolute_error");

  const last10AverageError = average(last10, "error_change");
  const last10AverageAbsoluteError = average(last10, "absolute_error");

  const directionRows = rows.filter(row => row.direction_hit !== null);
  const directionHitCount = directionRows.filter(row => row.direction_hit === true).length;
  const directionTotalCount = directionRows.length;

  const directionHitRate =
    directionTotalCount > 0
      ? (directionHitCount / directionTotalCount) * 100
      : null;

  const suggestedOffset =
    averageError === null
      ? null
      : round(clamp(averageError * 0.45, -0.65, 0.65), 6);

  let confidenceAdjustment = 0;

  if (averageAbsoluteError === null) {
    confidenceAdjustment = 0;
  } else if (averageAbsoluteError <= 0.35) {
    confidenceAdjustment = 5;
  } else if (averageAbsoluteError <= 0.65) {
    confidenceAdjustment = 2;
  } else if (averageAbsoluteError <= 1.00) {
    confidenceAdjustment = -3;
  } else {
    confidenceAdjustment = -8;
  }

  return {
    fund_code: fundCode,
    model: ACTIVE_MODEL,

    calculated_at: new Date().toISOString(),

    sample_size: sampleSize,
    completed_prediction_count: sampleSize,

    average_error: round(averageError, 6),
    average_absolute_error: round(averageAbsoluteError, 6),

    last5_average_error: round(last5AverageError, 6),
    last5_average_absolute_error: round(last5AverageAbsoluteError, 6),

    last10_average_error: round(last10AverageError, 6),
    last10_average_absolute_error: round(last10AverageAbsoluteError, 6),

    direction_hit_count: directionHitCount,
    direction_total_count: directionTotalCount,
    direction_hit_rate: round(directionHitRate, 4),

    bias_label: getBiasLabel(averageError),
    learning_status: getLearningStatus(
      sampleSize,
      averageAbsoluteError,
      directionHitRate
    ),
    suggested_offset: suggestedOffset,
    confidence_adjustment: round(confidenceAdjustment, 6),

    note:
      sampleSize === 0
        ? "Henüz kapanmış final performans kaydı yok."
        : "İstatistikler prediction_performance tablosundaki kapanmış final tahminlerden hesaplandı.",

    updated_at: new Date().toISOString()
  };
}

async function updateLearningStats() {
  const allRows = await getExistingPerformanceRows();

  const payloads = FUNDS.map(fundCode =>
    computeLearningStatsForFund(fundCode, allRows)
  );

  const path =
    "model_learning_stats" +
    "?on_conflict=fund_code,model";

  const saved = await supabaseRequest(path, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: payloads
  });

  return {
    savedRows: Array.isArray(saved) ? saved.length : 0,
    rows: saved
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  const querySecret = req.query && req.query.secret;
  const manualKey = req.query && req.query.manual;

  const authorizedByHeader =
    cronSecret && authHeader === `Bearer ${cronSecret}`;

  const authorizedByQuery =
    cronSecret && querySecret === cronSecret;

  const authorizedByManual =
    manualKey === "finscope";

  if (
    cronSecret &&
    !authorizedByHeader &&
    !authorizedByQuery &&
    !authorizedByManual
  ) {
    return res.status(401).json({
      ok: false,
      version: API_VERSION,
      error: "Yetkisiz istek."
    });
  }

  try {
    const finalRows = await getFinalRows(req);
    const existingPerformanceRows = await getExistingPerformanceRows();
    const fundPriceRows = await getFundPriceRows();

    const existingKeys = new Set(existingPerformanceRows.map(makePerformanceKey));

    const payloads = [];
    const results = [];

    for (const finalRow of finalRows) {
      const key = makePerformanceKey(finalRow);

      if (existingKeys.has(key)) {
        results.push({
          fund: finalRow.fund_code,
          predictionDate: dateText(finalRow.prediction_date),
          ok: true,
          skipped: true,
          reason: "performance_already_closed"
        });

        continue;
      }

      const actualMatch = findActualPriceForFinal(finalRow, fundPriceRows);

      if (!actualMatch) {
        results.push({
          fund: finalRow.fund_code,
          predictionDate: dateText(finalRow.prediction_date),
          ok: false,
          skipped: true,
          reason: "actual_price_not_available_yet"
        });

        continue;
      }

      const payload = buildPerformancePayload(finalRow, actualMatch);
      payloads.push(payload);

      results.push({
        fund: finalRow.fund_code,
        predictionDate: dateText(finalRow.prediction_date),
        ok: true,
        skipped: false,
        matchRule: actualMatch.matchRule,
        finalPredictionChange: payload.final_prediction_change,
        actualChange: payload.actual_change,
        errorChange: payload.error_change,
        absoluteError: payload.absolute_error,
        predictedDirection: payload.predicted_direction,
        actualDirection: payload.actual_direction,
        directionHit: payload.direction_hit,
        grade: payload.grade,
        actualPriceDate: payload.actual_price_date
      });
    }

    const savedPerformanceRows = await upsertPerformanceRows(payloads);
    const learningStats = await updateLearningStats();

    return res.status(200).json({
      ok: true,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
      model: ACTIVE_MODEL,

      finalsFound: finalRows.length,
      closed: payloads.length,
      alreadyClosed: results.filter(row => row.reason === "performance_already_closed").length,
      waitingActual: results.filter(row => row.reason === "actual_price_not_available_yet").length,

      savedPerformanceRows: Array.isArray(savedPerformanceRows)
        ? savedPerformanceRows.length
        : 0,

      formula:
        "error_change = actual_change - final_prediction_change",
      source:
        "prediction_finals + fund_prices",
      learningStatsUpdated: learningStats.savedRows,

      results,
      saved: savedPerformanceRows,
      learningStats
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: API_VERSION,
      model: ACTIVE_MODEL,
      error: String(error.message || error)
    });
  }
};
