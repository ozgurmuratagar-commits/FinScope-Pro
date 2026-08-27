const FUNDS = ["PBR", "PHE", "TLY", "THF"];

const API_VERSION = "FinScope Read-Only Predictions API v8.4 - THF Read Layer";
const MODEL_NAME = "FinScope Prediction Engine v8.4 - THF Initial Learning Layer";
const MODEL_KEY = "v7_1_accuracy_layer";
const TARGET_ABSOLUTE_ERROR = 0.10;

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

function confidenceText(score) {
  const s = num(score, null);
  if (s === null) return "Belirsiz";
  if (s >= 90) return "Çok yüksek";
  if (s >= 80) return "Yüksek";
  if (s >= 70) return "Orta";
  return "Düşük";
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

async function supabaseRequest(path) {
  const { url, key } = getSupabaseConfig();

  const response = await fetch(`${url}/rest/v1/${path}`, {
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
      `Supabase GET ${path} HTTP ${response.status}: ${text.slice(0, 900)}`
    );
  }

  if (!text) return [];
  return JSON.parse(text);
}

function getPredictionValue(row) {
  return (
    num(row.calibrated_change, null) ??
    num(row.predicted_change, null) ??
    num(row.raw_predicted_change, null) ??
    num(row.final_prediction_change, null)
  );
}

function rowTime(row) {
  const text =
    row.updated_at ||
    row.created_at ||
    row.closed_at ||
    "1970-01-01T00:00:00Z";

  const t = new Date(text).getTime();
  return Number.isFinite(t) ? t : 0;
}

function sortPredictionRows(a, b) {
  const ad = String(a.prediction_date || "");
  const bd = String(b.prediction_date || "");

  if (ad !== bd) return bd.localeCompare(ad);

  const at = rowTime(a);
  const bt = rowTime(b);

  if (at !== bt) return bt - at;

  return num(b.id, 0) - num(a.id, 0);
}

function expectedErrorBandForRow(code, row) {
  const sampleSize = num(row.sample_size, 0);
  const confidence = num(row.confidence, null);

  if (code === "THF" && sampleSize < 5) return 0.45;
  if (confidence !== null && confidence >= 85) return 0.25;
  if (confidence !== null && confidence >= 70) return 0.35;

  return 0.45;
}

function normalizePrediction(row) {
  const code = String(row.fund_code || "").toUpperCase();
  const predicted = getPredictionValue(row);
  const raw = num(row.raw_predicted_change, predicted);
  const calibrated = num(row.calibrated_change, predicted);
  const confidence = num(row.confidence, null);
  const band = expectedErrorBandForRow(code, row);

  return {
    id: row.id ?? null,
    fundCode: code,
    code,
    predictionDate: row.prediction_date || null,

    model: row.model || MODEL_KEY,
    modelKey: row.model || MODEL_KEY,
    modelVersion: row.model_version || MODEL_NAME,

    source: "prediction_history",
    status: row.status || "read_only_pending_prediction",
    selectionRule: "latest_pending_prediction_by_fund_actual_change_is_null",

    predictedChange: round(predicted, 4),
    currentPredictionChange: round(predicted, 4),
    finalPredictionChange: round(predicted, 4),
    calibratedChange: round(calibrated, 4),
    rawPredictedChange: round(raw, 4),
    predictionDirection: direction(predicted),

    rangeLow: predicted === null ? null : round(predicted - band, 4),
    rangeHigh: predicted === null ? null : round(predicted + band, 4),
    expectedErrorBand: round(band, 4),
    targetAbsoluteError: TARGET_ABSOLUTE_ERROR,

    confidence: confidence === null ? null : round(confidence, 2),
    confidenceText: confidenceText(confidence),

    coverage: round(row.coverage, 2),
    residualWeight: round(row.residual_weight, 2),
    sampleSize: num(row.sample_size, 0),
    calibrationOffset: round(row.calibration_offset, 4),

    actualChange:
      row.actual_change === null || row.actual_change === undefined
        ? null
        : round(row.actual_change, 4),

    errorChange:
      row.error_change === null || row.error_change === undefined
        ? null
        : round(row.error_change, 4),

    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,

    note:
      code === "THF" && num(row.sample_size, 0) < 5
        ? "THF yeni fon; yeterli kapanış performansı oluşana kadar düşük güvenli başlangıç katmanıyla okunur."
        : "Kilitlenmemiş güncel tahmin prediction_history tablosundan okunur."
  };
}

function pickLatestPendingByFund(rows) {
  const out = {};
  const sorted = [...(rows || [])].sort(sortPredictionRows);

  for (const row of sorted) {
    const code = String(row.fund_code || "").toUpperCase();

    if (!FUNDS.includes(code)) continue;
    if (row.actual_change !== null && row.actual_change !== undefined) continue;

    if (!out[code]) out[code] = row;
  }

  return out;
}

async function getPendingPredictionRows() {
  return await supabaseRequest(
    "prediction_history?select=*&fund_code=in.(PBR,PHE,TLY,THF)&model=eq." +
      encodeURIComponent(MODEL_KEY) +
      "&actual_change=is.null&order=prediction_date.desc,updated_at.desc,created_at.desc&limit=300"
  );
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const pendingRows = await getPendingPredictionRows();
    const latestByFund = pickLatestPendingByFund(pendingRows);

    const predictions = {};
    const rows = [];
    const missingFunds = [];

    for (const code of FUNDS) {
      const selected = latestByFund[code];

      if (!selected) {
        predictions[code] = null;
        missingFunds.push(code);
        continue;
      }

      const normalized = normalizePrediction(selected);

      predictions[code] = normalized;
      rows.push(normalized);
    }

    return res.status(200).json({
      ok: true,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),

      readOnly: true,
      source: "supabase_prediction_history_pending_only",
      selectionRule:
        "Only prediction_history rows where actual_change IS NULL are used as current predictions. This endpoint never runs /api/predict.",

      model: MODEL_NAME,
      modelName: MODEL_NAME,
      modelKey: MODEL_KEY,
      targetAbsoluteError: TARGET_ABSOLUTE_ERROR,

      funds: FUNDS,
      fundOrder: FUNDS,

      count: rows.length,
      pendingRowCount: Array.isArray(pendingRows) ? pendingRows.length : 0,
      missingFunds,

      predictions,
      rows,
      latestRows: rows,
      data: rows,

      summary: {
        totalFunds: FUNDS.length,
        availablePredictions: rows.length,
        missingPredictions: missingFunds.length,
        pendingRows: Array.isArray(pendingRows) ? pendingRows.length : 0,
        thfIncluded: predictions.THF !== null,
        note: "THF dahil 4 fon için read-only güncel tahmin okuma katmanı."
      },

      disclaimer:
        "Bu tahminler model bazlıdır, kesinlik içermez ve yatırım tavsiyesi değildir."
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      version: API_VERSION,
      model: MODEL_NAME,
      modelKey: MODEL_KEY,
      error: String(err.message || err)
    });
  }
};
