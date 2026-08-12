const FUNDS = ["PBR", "PHE", "TLY"];

const API_VERSION = "FinScope Performance API v4";
const ACTIVE_MODEL = "v7_1_accuracy_layer";
const FINAL_LABEL = "18:00 sonrası nihai tahmin";

function num(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = num(value, 0);
  return Number(n.toFixed(digits));
}

function direction(value) {
  const n = num(value, 0);
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function getPredictedChange(row) {
  return (
    num(row.calibrated_change) ??
    num(row.predicted_change) ??
    num(row.raw_predicted_change)
  );
}

function getTurkeyHourFromIso(isoValue) {
  if (!isoValue) return null;
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return null;

  const turkey = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return turkey.getUTCHours() + turkey.getUTCMinutes() / 60;
}

function isAfterFinalWindow(row) {
  const hour = getTurkeyHourFromIso(row.created_at || row.updated_at);
  return hour !== null && hour >= 18;
}

function getGrade(errorAbs) {
  const e = Math.abs(num(errorAbs, 0));

  if (e <= 0.25) return "Çok iyi";
  if (e <= 0.50) return "İyi";
  if (e <= 0.85) return "Makul";
  if (e <= 1.25) return "Zayıf";
  return "Çok zayıf";
}

function normalizeRow(row, currentPredictionChange = null) {
  const finalPrediction = getPredictedChange(row);
  const actual = num(row.actual_change);

  const completed = actual !== null && finalPrediction !== null;
  const error = completed ? actual - finalPrediction : null;

  return {
    id: row.id,
    fundCode: row.fund_code,
    predictionDate: row.prediction_date,
    model: row.model || null,
    modelVersion: row.model_version || null,

    status: completed ? "completed" : "pending",

    /*
      Backward compatibility:
      Dashboard eski hali row.predictedChange kullanıyorsa bozulmasın diye
      predictedChange hâlâ kıyaslamada kullanılan nihai tahmini gösterir.
    */
    predictedChange: finalPrediction === null ? null : round(finalPrediction, 4),

    /*
      Yeni açık alan:
      Sapmanın hangi tahmine göre hesaplandığını netleştirir.
    */
    finalPredictionChange: finalPrediction === null ? null : round(finalPrediction, 4),
    finalPredictionLabel: FINAL_LABEL,

    /*
      Varsa aynı fonun güncel bekleyen tahmini.
      UI isterse bunu ayrı gösterebilir.
    */
    currentPredictionChange:
      currentPredictionChange === null || currentPredictionChange === undefined
        ? null
        : round(currentPredictionChange, 4),

    rawPredictedChange:
      row.raw_predicted_change === null || row.raw_predicted_change === undefined
        ? null
        : round(row.raw_predicted_change, 4),

    calibratedChange:
      row.calibrated_change === null || row.calibrated_change === undefined
        ? null
        : round(row.calibrated_change, 4),

    actualChange: actual === null ? null : round(actual, 4),
    errorChange: error === null ? null : round(error, 4),
    absoluteError: error === null ? null : round(Math.abs(error), 4),

    predictedDirection: finalPrediction === null ? "unknown" : direction(finalPrediction),
    actualDirection: actual === null ? "unknown" : direction(actual),

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

    isFinalWindowPrediction: isAfterFinalWindow(row),

    grade: completed ? getGrade(Math.abs(error)) : "Bekliyor",
    note: completed
      ? `Sapma ${FINAL_LABEL} baz alınarak hesaplandı.`
      : "Gerçekleşen TEFAS fiyatı bekleniyor.",

    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function sortRawRowsNewestFirst(a, b) {
  const predictionDateCompare = String(b.prediction_date || "").localeCompare(
    String(a.prediction_date || "")
  );

  if (predictionDateCompare !== 0) return predictionDateCompare;

  const timeA = new Date(a.created_at || a.updated_at || "1970-01-01").getTime();
  const timeB = new Date(b.created_at || b.updated_at || "1970-01-01").getTime();

  return timeB - timeA;
}

function sortPreferFinalCompleted(a, b) {
  const predictionDateCompare = String(b.prediction_date || "").localeCompare(
    String(a.prediction_date || "")
  );

  if (predictionDateCompare !== 0) return predictionDateCompare;

  const finalA = isAfterFinalWindow(a) ? 1 : 0;
  const finalB = isAfterFinalWindow(b) ? 1 : 0;

  if (finalB !== finalA) return finalB - finalA;

  const timeA = new Date(a.created_at || a.updated_at || "1970-01-01").getTime();
  const timeB = new Date(b.created_at || b.updated_at || "1970-01-01").getTime();

  return timeB - timeA;
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
  const rows = await supabaseRequest(
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY)&order=prediction_date.desc,created_at.desc&limit=1000"
  );

  return Array.isArray(rows) ? rows : [];
}

function latestPendingByFund(rawRows) {
  const result = {};

  for (const code of FUNDS) {
    const pending = rawRows
      .filter(row => row.fund_code === code)
      .filter(row => row.actual_change === null || row.actual_change === undefined)
      .sort(sortRawRowsNewestFirst);

    result[code] = pending[0] || null;
  }

  return result;
}

function latestCompletedFinalByFund(rawRows) {
  const result = {};

  for (const code of FUNDS) {
    const completed = rawRows
      .filter(row => row.fund_code === code)
      .filter(row => row.actual_change !== null && row.actual_change !== undefined)
      .sort(sortPreferFinalCompleted);

    result[code] = completed[0] || null;
  }

  return result;
}

function buildDisplayRows(rawRows) {
  const pendingMap = latestPendingByFund(rawRows);
  const completedMap = latestCompletedFinalByFund(rawRows);

  return FUNDS.map(code => {
    const completed = completedMap[code];
    const pending = pendingMap[code];
    const currentPrediction = pending ? getPredictedChange(pending) : null;

    if (completed) {
      return normalizeRow(completed, currentPrediction);
    }

    if (pending) {
      return normalizeRow(pending, currentPrediction);
    }

    return {
      fundCode: code,
      predictionDate: null,
      model: ACTIVE_MODEL,
      status: "missing",
      predictedChange: null,
      finalPredictionChange: null,
      finalPredictionLabel: FINAL_LABEL,
      currentPredictionChange: null,
      actualChange: null,
      errorChange: null,
      absoluteError: null,
      grade: "Veri yok",
      note: "Kayıt bulunamadı."
    };
  });
}

function buildHistories(rawRows) {
  const pendingMap = latestPendingByFund(rawRows);

  const normalized = rawRows
    .sort(sortRawRowsNewestFirst)
    .map(row => {
      const pending = pendingMap[row.fund_code];
      const currentPrediction = pending ? getPredictedChange(pending) : null;
      return normalizeRow(row, currentPrediction);
    });

  return {
    normalized,
    completedHistory: normalized.filter(row => row.status === "completed").slice(0, 50),
    pendingHistory: normalized.filter(row => row.status === "pending").slice(0, 50)
  };
}

function buildSummary(displayRows, allRows) {
  const completedDisplayRows = displayRows.filter(row => row.status === "completed");
  const pendingRows = allRows.filter(row => row.status === "pending");
  const completedRows = allRows.filter(row => row.status === "completed");

  const completedWithError = completedRows.filter(row => row.absoluteError !== null);
  const directionRows = completedRows.filter(row => row.directionHit !== null);

  const averageAbsoluteError =
    completedWithError.length > 0
      ? completedWithError.reduce((sum, row) => sum + row.absoluteError, 0) / completedWithError.length
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
      latestCompleted: completed[0] || null,
      latestPending: pending[0] || null,
      averageAbsoluteError:
        completedErrors.length > 0
          ? round(
              completedErrors.reduce((sum, row) => sum + row.absoluteError, 0) / completedErrors.length,
              4
            )
          : null,
      directionHitRate:
        directionFundRows.length > 0
          ? round(
              (directionFundRows.filter(row => row.directionHit).length / directionFundRows.length) * 100,
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
    completedDisplayRows: completedDisplayRows.length,
    averageAbsoluteError:
      averageAbsoluteError === null ? null : round(averageAbsoluteError, 4),
    directionHitRate:
      directionHitRate === null ? null : round(directionHitRate, 2),
    finalPredictionLabel: FINAL_LABEL,
    deviationFormula:
      "Sapma = gerçekleşen TEFAS değişimi - 18:00 sonrası nihai tahmin",
    byFund
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const rawRows = await getPredictionHistory();
    const filteredRows = rawRows.filter(row => FUNDS.includes(row.fund_code));

    const displayRows = buildDisplayRows(filteredRows);
    const histories = buildHistories(filteredRows);
    const summary = buildSummary(displayRows, histories.normalized);

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      version: API_VERSION,
      source: "supabase.prediction_history",
      model: ACTIVE_MODEL,
      logic:
        "Performance v4: sapma, gerçekleşen TEFAS değişimi ile 18:00 sonrası nihai tahmin arasındaki fark olarak hesaplanır.",
      finalPredictionLabel: FINAL_LABEL,
      rows: displayRows,
      summary,
      byFund: summary.byFund,
      completedHistory: histories.completedHistory,
      pendingHistory: histories.pendingHistory,
      note:
        "finalPredictionChange alanı performans sapmasının baz aldığı 18:00 sonrası nihai tahmini gösterir."
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      version: API_VERSION,
      error: String(err.message || err)
    });
  }
};
