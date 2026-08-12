const FUNDS = ["PBR", "PHE", "TLY"];

const API_VERSION = "FinScope Performance API v6";
const ACTIVE_MODEL = "v7_1_accuracy_layer";
const FINAL_LABEL = "Önceki 18:00 Nihai Tahmin";

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

function direction(value) {
  const n = num(value, 0);
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function getFinalPrediction(row) {
  return num(row.calibrated_change);
}

function getGrade(errorAbs) {
  const e = Math.abs(num(errorAbs, 0));

  if (e <= 0.25) return "Çok iyi";
  if (e <= 0.50) return "İyi";
  if (e <= 0.85) return "Makul";
  if (e <= 1.25) return "Zayıf";
  return "Çok zayıf";
}

function parseYmd(value) {
  if (!value || typeof value !== "string") return null;
  const parts = value.slice(0, 10).split("-").map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;

  return {
    year: parts[0],
    month: parts[1],
    day: parts[2]
  };
}

function toYmdString(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function previousDateString(ymd) {
  const parsed = parseYmd(ymd);
  if (!parsed) return null;

  const d = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  d.setUTCDate(d.getUTCDate() - 1);

  return toYmdString(d);
}

function turkeyPartsFromIso(isoValue) {
  if (!isoValue) return null;

  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return null;

  const turkey = new Date(d.getTime() + 3 * 60 * 60 * 1000);

  return {
    ymd: toYmdString(turkey),
    hour: turkey.getUTCHours(),
    minute: turkey.getUTCMinutes(),
    decimalHour: turkey.getUTCHours() + turkey.getUTCMinutes() / 60
  };
}

function isPreviousDayFinalWindow(row) {
  const predictionDate = row.prediction_date;
  const prevDate = previousDateString(predictionDate);
  const turkey = turkeyPartsFromIso(row.created_at || row.updated_at);

  if (!prevDate || !turkey) return false;

  return turkey.ymd === prevDate && turkey.decimalHour >= 18;
}

function sortNewest(a, b) {
  const dateCompare = String(b.prediction_date || "").localeCompare(
    String(a.prediction_date || "")
  );

  if (dateCompare !== 0) return dateCompare;

  const timeA = new Date(a.created_at || a.updated_at || "1970-01-01").getTime();
  const timeB = new Date(b.created_at || b.updated_at || "1970-01-01").getTime();

  return timeB - timeA;
}

function sortByCreatedNewest(a, b) {
  const timeA = new Date(a.created_at || a.updated_at || "1970-01-01").getTime();
  const timeB = new Date(b.created_at || b.updated_at || "1970-01-01").getTime();

  return timeB - timeA;
}

function normalizeRow(row) {
  const finalPrediction = getFinalPrediction(row);
  const actual = num(row.actual_change);

  const completed = actual !== null && finalPrediction !== null;
  const error = completed ? actual - finalPrediction : null;

  return {
    id: row.id,
    fundCode: row.fund_code,
    predictionDate: row.prediction_date,
    model: row.model || ACTIVE_MODEL,
    modelVersion: row.model_version || null,

    status: completed ? "completed" : "pending",

    predictedChange: finalPrediction === null ? null : round(finalPrediction, 4),

    finalPredictionChange: finalPrediction === null ? null : round(finalPrediction, 4),
    finalPredictionLabel: FINAL_LABEL,
    finalPredictionSource: "prediction_history.calibrated_change",
    finalWindowRule: "prediction_date bir önceki gün 18:00 sonrası Türkiye saati",
    isPreviousDayFinalWindow: isPreviousDayFinalWindow(row),

    rawPredictedChange: round(row.raw_predicted_change, 4),
    calibratedChange: round(row.calibrated_change, 4),

    actualChange: actual === null ? null : round(actual, 4),
    errorChange: error === null ? null : round(error, 4),
    absoluteError: error === null ? null : round(Math.abs(error), 4),

    predictedDirection:
      finalPrediction === null ? "unknown" : direction(finalPrediction),
    actualDirection:
      actual === null ? "unknown" : direction(actual),

    directionHit:
      finalPrediction === null ||
      actual === null ||
      Math.abs(finalPrediction) < 0.01 ||
      Math.abs(actual) < 0.01
        ? null
        : direction(finalPrediction) === direction(actual),

    confidence: row.confidence ?? null,
    coverage: row.coverage ?? null,
    residualWeight: row.residual_weight ?? null,
    sampleSize: row.sample_size ?? null,

    grade: completed ? getGrade(Math.abs(error)) : "Bekliyor",
    note: completed
      ? "Sapma, gerçekleşen TEFAS değişimi ile önceki 18:00 nihai tahmin arasındaki farktır."
      : "Gerçekleşen TEFAS fiyatı bekleniyor.",

    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
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
      `Supabase ${options.method || "GET"} ${path} HTTP ${response.status}: ${text.slice(0, 900)}`
    );
  }

  if (!text) return [];
  return JSON.parse(text);
}

async function getPredictionHistory() {
  const path =
    "prediction_history" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY)" +
    "&model=eq.v7_1_accuracy_layer" +
    "&order=prediction_date.desc,created_at.desc" +
    "&limit=1000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

function uniquePredictionDatesForFund(rawRows, code) {
  const dates = rawRows
    .filter(row => row.fund_code === code)
    .map(row => row.prediction_date)
    .filter(Boolean);

  return [...new Set(dates)].sort((a, b) => String(b).localeCompare(String(a)));
}

function pickCompletedRowForFund(rawRows, code) {
  const dates = uniquePredictionDatesForFund(rawRows, code);

  for (const predictionDate of dates) {
    const completedForDate = rawRows
      .filter(row => row.fund_code === code)
      .filter(row => row.prediction_date === predictionDate)
      .filter(row => row.actual_change !== null && row.actual_change !== undefined)
      .filter(row => row.calibrated_change !== null && row.calibrated_change !== undefined);

    if (completedForDate.length === 0) continue;

    const finalWindowRows = completedForDate
      .filter(row => isPreviousDayFinalWindow(row))
      .sort(sortByCreatedNewest);

    if (finalWindowRows.length > 0) {
      return finalWindowRows[0];
    }

    return completedForDate.sort(sortByCreatedNewest)[0];
  }

  return null;
}

function pickPendingRowForFund(rawRows, code) {
  const pending = rawRows
    .filter(row => row.fund_code === code)
    .filter(row => row.actual_change === null || row.actual_change === undefined)
    .sort(sortNewest);

  return pending[0] || null;
}

function buildDisplayRows(rawRows) {
  return FUNDS.map(code => {
    const completed = pickCompletedRowForFund(rawRows, code);
    const pending = pickPendingRowForFund(rawRows, code);

    if (completed) return normalizeRow(completed);
    if (pending) return normalizeRow(pending);

    return {
      fundCode: code,
      predictionDate: null,
      model: ACTIVE_MODEL,
      status: "missing",
      predictedChange: null,
      finalPredictionChange: null,
      finalPredictionLabel: FINAL_LABEL,
      finalPredictionSource: "prediction_history.calibrated_change",
      finalWindowRule: "prediction_date bir önceki gün 18:00 sonrası Türkiye saati",
      isPreviousDayFinalWindow: false,
      actualChange: null,
      errorChange: null,
      absoluteError: null,
      grade: "Veri yok",
      note: "Kayıt bulunamadı."
    };
  });
}

function buildHistories(rawRows) {
  const normalized = rawRows
    .sort(sortNewest)
    .map(row => normalizeRow(row));

  return {
    normalized,
    completedHistory: normalized
      .filter(row => row.status === "completed")
      .slice(0, 50),
    pendingHistory: normalized
      .filter(row => row.status === "pending")
      .slice(0, 50)
  };
}

function buildSummary(displayRows, allRows) {
  const completedRows = allRows.filter(row => row.status === "completed");
  const pendingRows = allRows.filter(row => row.status === "pending");

  const completedWithError = completedRows.filter(row => row.absoluteError !== null);
  const directionRows = completedRows.filter(row => row.directionHit !== null);

  const averageAbsoluteError =
    completedWithError.length > 0
      ? completedWithError.reduce((sum, row) => sum + row.absoluteError, 0) /
        completedWithError.length
      : null;

  const directionHitRate =
    directionRows.length > 0
      ? (directionRows.filter(row => row.directionHit).length / directionRows.length) * 100
      : null;

  const byFund = {};

  for (const code of FUNDS) {
    const fundRows = allRows.filter(row => row.fundCode === code);
    const completed = fundRows.filter(row => row.status === "completed");
    const pending = fundRows.filter(row => row.status === "pending");

    const completedErrors = completed.filter(row => row.absoluteError !== null);
    const directionFundRows = completed.filter(row => row.directionHit !== null);

    byFund[code] = {
      totalRows: fundRows.length,
      completedRows: completed.length,
      pendingRows: pending.length,
      latestDisplayRow: displayRows.find(row => row.fundCode === code) || null,
      latestCompleted: completed[0] || null,
      latestPending: pending[0] || null,
      averageAbsoluteError:
        completedErrors.length > 0
          ? round(
              completedErrors.reduce((sum, row) => sum + row.absoluteError, 0) /
                completedErrors.length,
              4
            )
          : null,
      directionHitRate:
        directionFundRows.length > 0
          ? round(
              (directionFundRows.filter(row => row.directionHit).length /
                directionFundRows.length) *
                100,
              2
            )
          : null
    };
  }

  return {
    totalRows: allRows.length,
    dashboardRows: displayRows.length,
    completedRows: completedRows.length,
    pendingRows: pendingRows.length,
    completedDisplayRows: displayRows.filter(row => row.status === "completed").length,
    averageAbsoluteError:
      averageAbsoluteError === null ? null : round(averageAbsoluteError, 4),
    directionHitRate:
      directionHitRate === null ? null : round(directionHitRate, 2),
    finalPredictionLabel: FINAL_LABEL,
    finalPredictionSource: "prediction_history.calibrated_change",
    finalWindowRule: "prediction_date bir önceki gün 18:00 sonrası Türkiye saati",
    deviationFormula:
      "Sapma = gerçekleşen TEFAS değişimi - önceki 18:00 nihai tahmin",
    byFund
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const rawRows = await getPredictionHistory();

    const displayRows = buildDisplayRows(rawRows);
    const histories = buildHistories(rawRows);
    const summary = buildSummary(displayRows, histories.normalized);

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      version: API_VERSION,
      source: "supabase.prediction_history",
      model: ACTIVE_MODEL,
      logic:
        "Performance v6: Aynı prediction_date için birden çok completed kayıt varsa, önce prediction_date bir önceki gün 18:00 sonrası Türkiye saatiyle oluşturulmuş kayıt seçilir. Sapma actual_change - calibrated_change olarak hesaplanır.",
      finalPredictionLabel: FINAL_LABEL,
      finalPredictionSource: "prediction_history.calibrated_change",
      finalWindowRule: "prediction_date bir önceki gün 18:00 sonrası Türkiye saati",
      rows: displayRows,
      summary,
      byFund: summary.byFund,
      completedHistory: histories.completedHistory,
      pendingHistory: histories.pendingHistory,
      note:
        "Bu API sadece v7_1_accuracy_layer model kayıtlarını kullanır. Önceki 18:00 nihai tahmin için final window kaydı önceliklidir."
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      version: API_VERSION,
      model: ACTIVE_MODEL,
      error: String(err.message || err)
    });
  }
};
