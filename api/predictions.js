const FUNDS = ["PBR", "PHE", "TLY"];

const API_VERSION = "FinScope Read-Only Predictions API v2";
const ACTIVE_MODEL = "v7_1_accuracy_layer";
const ACTIVE_MODEL_NAME = "FinScope Prediction Engine v7.1 - Accuracy Layer";

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

function confidenceText(value) {
  const n = num(value, null);

  if (n === null) return "—";
  if (n >= 90) return "Çok yüksek";
  if (n >= 80) return "Yüksek";
  if (n >= 60) return "Orta";
  if (n >= 40) return "Düşük";
  return "Çok düşük";
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

function getPredictionValue(row) {
  const calibrated = num(row.calibrated_change, null);
  if (calibrated !== null) return calibrated;

  const predicted = num(row.predicted_change, null);
  if (predicted !== null) return predicted;

  const raw = num(row.raw_predicted_change, null);
  if (raw !== null) return raw;

  return null;
}

function normalizePrediction(row) {
  const predictedChange = getPredictionValue(row);
  const rawPredictedChange = num(row.raw_predicted_change, predictedChange);

  const smoothingImpact =
    predictedChange !== null && rawPredictedChange !== null
      ? predictedChange - rawPredictedChange
      : 0;

  const calibrationOffset =
    predictedChange !== null && rawPredictedChange !== null
      ? predictedChange - rawPredictedChange
      : 0;

  const coverage = num(row.coverage, 100);
  const confidence = num(row.confidence, coverage);

  return {
    fundCode: row.fund_code,
    predictionDate: row.prediction_date,
    model: ACTIVE_MODEL_NAME,
    modelKey: ACTIVE_MODEL,

    status: "pending_prediction",
    readOnly: true,

    predictedChange: round(predictedChange, 4),
    rawPredictedChange: round(rawPredictedChange, 4),
    unsmoothedChange: round(rawPredictedChange, 4),

    smoothingImpact: round(smoothingImpact, 4),
    calibrationOffset: round(calibrationOffset, 4),
    accuracyDamping: round(row.accuracy_damping ?? 1, 4),

    direction: direction(predictedChange),
    coverage: round(coverage, 2),
    confidence: round(confidence, 2),
    confidenceText: confidenceText(confidence),

    actualChange: null,
    errorChange: null,

    residualWeight: round(row.residual_weight, 4),
    sampleSize: row.sample_size ?? null,

    source: "prediction_history.pending_only",
    selectionRule: "actual_change IS NULL only",

    accuracyLayer: {
      status: "read_only_pending_prediction",
      source: "prediction_history",
      modelKey: ACTIVE_MODEL
    },

    calibration: {
      status: "read_only_pending_prediction",
      source: "prediction_history.calibrated_change"
    },

    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function emptyPrediction(code) {
  return {
    fundCode: code,
    model: ACTIVE_MODEL_NAME,
    modelKey: ACTIVE_MODEL,

    status: "no_pending_prediction",
    readOnly: true,

    predictedChange: null,
    rawPredictedChange: null,
    unsmoothedChange: null,

    smoothingImpact: 0,
    calibrationOffset: 0,
    accuracyDamping: 1,

    direction: "flat",
    coverage: null,
    confidence: null,
    confidenceText: "—",

    actualChange: null,
    errorChange: null,

    residualWeight: null,
    sampleSize: null,

    source: "prediction_history.pending_only",
    selectionRule: "actual_change IS NULL only",

    accuracyLayer: {
      status: "no_pending_prediction",
      source: "prediction_history",
      modelKey: ACTIVE_MODEL
    },

    calibration: {
      status: "no_pending_prediction",
      source: "prediction_history.calibrated_change"
    },

    note:
      "Bu fon için bekleyen güncel tahmin bulunamadı. Completed performans kayıtları güncel tahmin olarak kullanılmaz."
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

async function getPendingPredictionHistory() {
  const path =
    "prediction_history" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY)" +
    "&model=eq.v7_1_accuracy_layer" +
    "&actual_change=is.null" +
    "&order=prediction_date.desc,created_at.desc" +
    "&limit=200";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

function pickLatestPendingPredictionForFund(rows, code) {
  const fundRows = rows
    .filter(row => row.fund_code === code)
    .filter(row => row.actual_change === null || row.actual_change === undefined)
    .sort(sortNewest);

  return fundRows[0] || null;
}

function buildPredictions(rows) {
  const predictions = {};
  const missingFunds = [];

  for (const code of FUNDS) {
    const row = pickLatestPendingPredictionForFund(rows, code);

    if (!row) {
      predictions[code] = emptyPrediction(code);
      missingFunds.push(code);
      continue;
    }

    predictions[code] = normalizePrediction(row);
  }

  return {
    predictions,
    missingFunds
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const rows = await getPendingPredictionHistory();
    const built = buildPredictions(rows);

    return res.status(200).json({
      ok: true,
      readOnly: true,
      generatedAt: new Date().toISOString(),
      version: API_VERSION,
      source: "supabase.prediction_history.pending_only",
      model: ACTIVE_MODEL_NAME,
      modelKey: ACTIVE_MODEL,
      selectionRule: "Only rows where actual_change IS NULL are used as current predictions.",
      funds: FUNDS,
      predictions: built.predictions,
      pendingCount: rows.length,
      missingFunds: built.missingFunds,
      rowCount: rows.length,
      note:
        "Bu endpoint tahmin üretmez. Completed performans kayıtlarını güncel tahmin olarak kullanmaz."
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      readOnly: true,
      version: API_VERSION,
      model: ACTIVE_MODEL_NAME,
      modelKey: ACTIVE_MODEL,
      error: String(err.message || err)
    });
  }
};
