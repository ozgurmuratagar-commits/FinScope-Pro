const FUNDS = ["PBR", "PHE", "TLY"];

const API_VERSION = "FinScope Finalize Predictions API v1";
const ACTIVE_MODEL = "v7_1_accuracy_layer";
const DEFAULT_MODEL_VERSION = "FinScope Prediction Engine v7.2 - Safe Current Prediction";

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

function direction(value) {
  const n = num(value, 0);
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function isValidDateText(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function rowTime(row) {
  const t = new Date(row.updated_at || row.created_at || "1970-01-01").getTime();
  return Number.isFinite(t) ? t : 0;
}

function sortNewest(a, b) {
  const dateCompare = String(b.prediction_date || "").localeCompare(
    String(a.prediction_date || "")
  );

  if (dateCompare !== 0) return dateCompare;

  return rowTime(b) - rowTime(a);
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

async function getPendingPredictionRows() {
  const path =
    "prediction_history" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    "&actual_change=is.null" +
    "&order=prediction_date.desc,updated_at.desc,created_at.desc" +
    "&limit=300";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

function resolveTargetDate(req, pendingRows) {
  const queryDate = req.query && req.query.date;

  if (isValidDateText(queryDate)) {
    return queryDate;
  }

  const dates = pendingRows
    .map(row => row.prediction_date)
    .filter(Boolean)
    .sort((a, b) => String(b).localeCompare(String(a)));

  return dates[0] || null;
}

function pickLatestPendingForFund(pendingRows, fundCode, targetDate) {
  const rows = pendingRows
    .filter(row => row.fund_code === fundCode)
    .filter(row => row.prediction_date === targetDate)
    .filter(row => row.actual_change === null || row.actual_change === undefined)
    .filter(row => getPredictionValue(row) !== null)
    .sort(sortNewest);

  return rows[0] || null;
}

async function getExistingPerformanceRows(targetDate) {
  if (!targetDate) return [];

  const path =
    "prediction_performance" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY)" +
    `&prediction_date=eq.${encodeURIComponent(targetDate)}` +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}`;

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

function buildFinalPayload(row, finalizeReason) {
  const finalPrediction = getPredictionValue(row);

  return {
    fund_code: row.fund_code,
    prediction_date: row.prediction_date,

    model: ACTIVE_MODEL,
    model_version: row.model_version || DEFAULT_MODEL_VERSION,

    source_prediction_id: row.id || null,
    source_created_at: row.created_at || null,
    finalized_at: new Date().toISOString(),

    final_prediction_change: round(finalPrediction, 6),
    raw_predicted_change: round(row.raw_predicted_change, 6),
    calibrated_change: round(row.calibrated_change, 6),

    confidence: round(row.confidence, 4),
    coverage: round(row.coverage, 4),
    residual_weight: round(row.residual_weight, 4),
    sample_size:
      row.sample_size === null || row.sample_size === undefined
        ? null
        : Number(row.sample_size),

    predicted_direction: direction(finalPrediction),
    finalization_status: "finalized",
    finalize_reason: finalizeReason,

    locked: true,
    updated_at: new Date().toISOString()
  };
}

async function upsertFinalRows(payloads) {
  if (!payloads.length) return [];

  const path =
    "prediction_finals" +
    "?on_conflict=fund_code,prediction_date,model";

  return await supabaseRequest(path, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: payloads
  });
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
    const pendingRows = await getPendingPredictionRows();
    const targetDate = resolveTargetDate(req, pendingRows);

    if (!targetDate) {
      return res.status(200).json({
        ok: false,
        version: API_VERSION,
        model: ACTIVE_MODEL,
        finalized: 0,
        total: FUNDS.length,
        error: "Final yapılacak pending tahmin bulunamadı.",
        pendingRows: pendingRows.length
      });
    }

    const existingPerformanceRows = await getExistingPerformanceRows(targetDate);

    const closedFunds = new Set(
      existingPerformanceRows.map(row => row.fund_code)
    );

    const payloads = [];
    const results = [];

    for (const fundCode of FUNDS) {
      if (closedFunds.has(fundCode)) {
        results.push({
          fund: fundCode,
          ok: false,
          skipped: true,
          reason:
            "Bu fon ve tarih için performance kapanmış. Final tahmin artık değiştirilemez.",
          predictionDate: targetDate
        });

        continue;
      }

      const row = pickLatestPendingForFund(pendingRows, fundCode, targetDate);

      if (!row) {
        results.push({
          fund: fundCode,
          ok: false,
          skipped: true,
          reason: "Bu fon için pending tahmin bulunamadı.",
          predictionDate: targetDate
        });

        continue;
      }

      const payload = buildFinalPayload(
        row,
        "18:00 sonrası güncel pending tahmin nihai tahmin olarak kilitlendi."
      );

      payloads.push(payload);

      results.push({
        fund: fundCode,
        ok: true,
        predictionDate: targetDate,
        sourcePredictionId: row.id || null,
        sourceCreatedAt: row.created_at || null,
        sourceUpdatedAt: row.updated_at || null,
        finalPredictionChange: payload.final_prediction_change,
        predictedDirection: payload.predicted_direction,
        confidence: payload.confidence,
        coverage: payload.coverage
      });
    }

    const savedRows = await upsertFinalRows(payloads);

    return res.status(200).json({
      ok: payloads.length === FUNDS.length,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
      model: ACTIVE_MODEL,
      targetDate,
      finalized: payloads.length,
      total: FUNDS.length,
      pendingRows: pendingRows.length,
      savedRows: Array.isArray(savedRows) ? savedRows.length : 0,
      rule:
        "Her fon için hedef prediction_date içindeki en güncel actual_change IS NULL tahmin final olarak prediction_finals tablosuna yazılır.",
      protection:
        "Eğer aynı fon/tarih için prediction_performance kapanmışsa final tahmin güncellenmez.",
      results,
      saved: savedRows
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
