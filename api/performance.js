const FUNDS = ["PBR", "PHE", "TLY"];

const API_VERSION = "FinScope Performance API v3";
const ACTIVE_MODEL = "v7_1_accuracy_layer";

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

function getGrade(errorAbs) {
  const e = Math.abs(num(errorAbs, 0));

  if (e <= 0.25) return "Çok iyi";
  if (e <= 0.50) return "İyi";
  if (e <= 0.85) return "Makul";
  if (e <= 1.25) return "Zayıf";
  return "Çok zayıf";
}

function normalizeRow(row) {
  const predicted = getPredictedChange(row);
  const actual = num(row.actual_change);
  const error =
    row.error_change !== null && row.error_change !== undefined
      ? num(row.error_change)
      : actual !== null && predicted !== null
        ? actual - predicted
        : null;

  const completed = actual !== null && error !== null;

  return {
    id: row.id,
    fundCode: row.fund_code,
    predictionDate: row.prediction_date,
    model: row.model || null,
    modelVersion: row.model_version || null,
    status: completed ? "completed" : "pending",
    predictedChange: predicted === null ? null : round(predicted, 4),
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
    predictedDirection: predicted === null ? "unknown" : direction(predicted),
    actualDirection: actual === null ? "unknown" : direction(actual),
    directionHit:
      predicted === null || actual === null || Math.abs(predicted) < 0.01 || Math.abs(actual) < 0.01
        ? null
        : direction(predicted) === direction(actual),
    confidence: row.confidence ?? null,
    coverage: row.coverage ?? null,
    residualWeight: row.residual_weight ?? null,
    sampleSize: row.sample_size ?? null,
    grade: completed ? getGrade(Math.abs(error)) : "Bekliyor",
    note: completed
      ? `Sapma: ${round(error, 4)} puan`
      : "Gerçekleşen TEFAS fiyatı bekleniyor",
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function sortNewestFirst(a, b) {
  const dateA = new Date(a.updated_at || a.created_at || "1970-01-01").getTime();
  const dateB = new Date(b.updated_at || b.created_at || "1970-01-01").getTime();

  if (dateB !== dateA) return dateB - dateA;

  const predDateA = String(a.prediction_date || "");
  const predDateB = String(b.prediction_date || "");

  return predDateB.localeCompare(predDateA);
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
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY)&order=updated_at.desc,created_at.desc&limit=500"
  );

  return Array.isArray(rows) ? rows : [];
}

function buildSummary(normalizedRows) {
  const completedRows = normalizedRows.filter(row => row.status === "completed");
  const pendingRows = normalizedRows.filter(row => row.status === "pending");

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
    const fundRows = normalizedRows.filter(row => row.fundCode === code);
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
    totalRows: normalizedRows.length,
    completedRows: completedRows.length,
    pendingRows: pendingRows.length,
    averageAbsoluteError:
      averageAbsoluteError === null ? null : round(averageAbsoluteError, 4),
    directionHitRate:
      directionHitRate === null ? null : round(directionHitRate, 2),
    byFund
  };
}

function buildDisplayRows(normalizedRows) {
  const rows = [];

  for (const code of FUNDS) {
    const fundRows = normalizedRows.filter(row => row.fundCode === code);
    const latestCompleted = fundRows.find(row => row.status === "completed");
    const latestPending = fundRows.find(row => row.status === "pending");

    /*
      Dashboard için öncelik:
      1. Tamamlanan son kayıt varsa onu göster.
      2. Yoksa bekleyen son tahmini göster.
      Böylece performans kutusu gerçek TEFAS verisi geldikten sonra
      tamamlanan kayıtları yansıtır.
    */
    rows.push(latestCompleted || latestPending || {
      fundCode: code,
      predictionDate: null,
      model: ACTIVE_MODEL,
      status: "missing",
      predictedChange: null,
      actualChange: null,
      errorChange: null,
      absoluteError: null,
      grade: "Veri yok",
      note: "Kayıt bulunamadı"
    });
  }

  return rows;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const rawRows = await getPredictionHistory();

    const activeRows = rawRows
      .filter(row => FUNDS.includes(row.fund_code))
      .filter(row => {
        /*
          Öncelik v7.1 kayıtlarında.
          Eğer geçmiş model kayıtları kapanmışsa onları da performans geçmişi olarak tutuyoruz.
          Böylece eski tamamlanan veriler kaybolmaz.
        */
        return true;
      })
      .sort(sortNewestFirst);

    const normalizedRows = activeRows.map(normalizeRow);
    const summary = buildSummary(normalizedRows);
    const displayRows = buildDisplayRows(normalizedRows);

    const completedHistory = normalizedRows
      .filter(row => row.status === "completed")
      .slice(0, 30);

    const pendingHistory = normalizedRows
      .filter(row => row.status === "pending")
      .slice(0, 30);

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      version: API_VERSION,
      source: "supabase.prediction_history",
      model: ACTIVE_MODEL,
      logic:
        "Performance v3: dashboard rows prefer latest completed record per fund; pending predictions are still counted separately.",
      rows: displayRows,
      summary,
      byFund: summary.byFund,
      completedHistory,
      pendingHistory,
      note:
        "Tamamlanan kayıtlar actual_change ve error_change dolu satırlardan hesaplanır. Bekleyen kayıtlar ayrı sayılır."
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      version: API_VERSION,
      error: String(err.message || err)
    });
  }
};
