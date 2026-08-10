const FUNDS = ["PBR", "PHE", "TLY"];
const DEFAULT_MODEL = "v6_actual_error_learning";

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 4) {
  const n = Number(v || 0);
  return Number(n.toFixed(d));
}

function direction(v) {
  const n = num(v) || 0;
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function gradeFromError(absError) {
  const e = Math.abs(num(absError) || 0);

  if (e <= 0.10) return "Mükemmel";
  if (e <= 0.25) return "Çok iyi";
  if (e <= 0.50) return "İyi";
  if (e <= 0.80) return "Orta";
  return "Zayıf";
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

async function supabaseGet(path) {
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
    throw new Error(`Supabase GET ${path} HTTP ${response.status}: ${text.slice(0, 700)}`);
  }

  if (!text) return [];
  return JSON.parse(text);
}

function enrichRow(row) {
  const predicted =
    num(row.calibrated_change) ??
    num(row.predicted_change) ??
    num(row.raw_predicted_change);

  const actual = num(row.actual_change);

  const error =
    row.error_change !== null && row.error_change !== undefined
      ? num(row.error_change)
      : actual !== null && predicted !== null
        ? actual - predicted
        : null;

  const absError = error === null ? null : Math.abs(error);

  return {
    id: row.id,
    fundCode: row.fund_code,
    predictionDate: row.prediction_date,
    model: row.model,
    modelVersion: row.model_version || null,
    predictedChange: predicted,
    rawPredictedChange: num(row.raw_predicted_change),
    calibratedChange: num(row.calibrated_change),
    calibrationOffset: num(row.calibration_offset),
    actualChange: actual,
    errorChange: error,
    absoluteError: absError,
    confidence: num(row.confidence),
    coverage: num(row.coverage),
    residualWeight: num(row.residual_weight),
    sampleSize: num(row.sample_size) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at || null,
    status: actual === null ? "pending" : "completed",
    predictedDirection: predicted === null ? "unknown" : direction(predicted),
    actualDirection: actual === null ? "unknown" : direction(actual),
    directionHit:
      actual === null || predicted === null
        ? null
        : direction(actual) === direction(predicted),
    grade: absError === null ? "Bekliyor" : gradeFromError(absError)
  };
}

function latestByFund(rows) {
  const out = {};

  for (const code of FUNDS) {
    out[code] = rows.find(r => r.fundCode === code) || null;
  }

  return out;
}

function summarize(rows) {
  const completed = rows.filter(r => r.status === "completed");
  const pending = rows.filter(r => r.status === "pending");
  const latest = latestByFund(rows);

  const byFund = {};

  for (const code of FUNDS) {
    const fundRows = rows.filter(r => r.fundCode === code);
    const fundCompleted = fundRows.filter(r => r.status === "completed");

    const avgAbsError =
      fundCompleted.length > 0
        ? fundCompleted.reduce((s, r) => s + (r.absoluteError || 0), 0) / fundCompleted.length
        : null;

    const directionHits = fundCompleted.filter(r => r.directionHit === true).length;

    byFund[code] = {
      total: fundRows.length,
      completed: fundCompleted.length,
      pending: fundRows.length - fundCompleted.length,
      averageAbsoluteError: avgAbsError === null ? null : round(avgAbsError, 4),
      directionHitRate:
        fundCompleted.length > 0
          ? round((directionHits / fundCompleted.length) * 100, 2)
          : null,
      latest: latest[code]
    };
  }

  const avgAbsError =
    completed.length > 0
      ? completed.reduce((s, r) => s + (r.absoluteError || 0), 0) / completed.length
      : null;

  const directionHits = completed.filter(r => r.directionHit === true).length;

  return {
    totalRows: rows.length,
    completedRows: completed.length,
    pendingRows: pending.length,
    averageAbsoluteError: avgAbsError === null ? null : round(avgAbsError, 4),
    directionHitRate:
      completed.length > 0
        ? round((directionHits / completed.length) * 100, 2)
        : null,
    byFund
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 60), 1), 300);
    const model = req.query.model ? String(req.query.model) : DEFAULT_MODEL;

    const path =
      "prediction_history?" +
      "select=*" +
      "&fund_code=in.(PBR,PHE,TLY)" +
      `&model=eq.${encodeURIComponent(model)}` +
      "&order=updated_at.desc.nullslast" +
      "&order=created_at.desc" +
      `&limit=${limit}`;

    const rawRows = await supabaseGet(path);
    const rows = rawRows.map(enrichRow);

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      version: "FinScope Performance API v2",
      source: "supabase.prediction_history",
      model,
      rows,
      summary: summarize(rows),
      note:
        "Performans verisi updated_at öncelikli sıralanır. Böylece v6 upsert sonrası en güncel tahmin kayıtları dashboard ile uyumlu gelir."
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
};
