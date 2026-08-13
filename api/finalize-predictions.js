const FUNDS = ["PBR", "PHE", "TLY"];

const API_VERSION = "FinScope Finalize Predictions API v2 - 18:00 Guard";
const ACTIVE_MODEL = "v7_1_accuracy_layer";
const DEFAULT_MODEL_VERSION = "FinScope Prediction Engine v7.2 - Safe Current Prediction";

const TURKEY_TIME_ZONE = "Europe/Istanbul";
const FINAL_START_HOUR = 18;
const FINAL_START_MINUTE = 0;
const FINAL_START_TOTAL_MINUTES = FINAL_START_HOUR * 60 + FINAL_START_MINUTE;

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

function getTurkeyTimeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TURKEY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;

  const minute = Number(parts.minute);
  const second = Number(parts.second);

  const dateText = `${parts.year}-${parts.month}-${parts.day}`;
  const timeText = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;

  return {
    dateText,
    timeText,
    hour,
    minute,
    second,
    totalMinutes: hour * 60 + minute,
    iso: date.toISOString()
  };
}

function isAfterFinalWindow(turkeyNow) {
  return turkeyNow.totalMinutes >= FINAL_START_TOTAL_MINUTES;
}

function rowCandidateTimestamp(row) {
  return row.updated_at || row.created_at || null;
}

function rowCandidateTimeMs(row) {
  const value = rowCandidateTimestamp(row);
  if (!value) return 0;

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function rowTurkeyCandidateParts(row) {
  const value = rowCandidateTimestamp(row);
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return getTurkeyTimeParts(date);
}

function isRowInCurrentFinalWindow(row, turkeyNow) {
  const rowTurkey = rowTurkeyCandidateParts(row);
  if (!rowTurkey) return false;

  return (
    rowTurkey.dateText === turkeyNow.dateText &&
    rowTurkey.totalMinutes >= FINAL_START_TOTAL_MINUTES
  );
}

function sortNewest(a, b) {
  const dateCompare = String(b.prediction_date || "").localeCompare(
    String(a.prediction_date || "")
  );

  if (dateCompare !== 0) return dateCompare;

  return rowCandidateTimeMs(b) - rowCandidateTimeMs(a);
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

function getValidFinalWindowRows(pendingRows, turkeyNow) {
  return pendingRows
    .filter(row => row.actual_change === null || row.actual_change === undefined)
    .filter(row => getPredictionValue(row) !== null)
    .filter(row => isRowInCurrentFinalWindow(row, turkeyNow));
}

function resolveTargetDate(req, validFinalWindowRows) {
  const queryDate = req.query && req.query.date;

  if (isValidDateText(queryDate)) {
    return queryDate;
  }

  const dates = validFinalWindowRows
    .map(row => row.prediction_date)
    .filter(Boolean)
    .sort((a, b) => String(b).localeCompare(String(a)));

  return dates[0] || null;
}

function pickLatestPendingForFund(validFinalWindowRows, fundCode, targetDate) {
  const rows = validFinalWindowRows
    .filter(row => row.fund_code === fundCode)
    .filter(row => row.prediction_date === targetDate)
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

async function getExistingFinalRows(targetDate) {
  if (!targetDate) return [];

  const path =
    "prediction_finals" +
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

function authStatus(req) {
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
    return {
      ok: false,
      reason: "Yetkisiz istek."
    };
  }

  return {
    ok: true,
    authorizedByHeader: Boolean(authorizedByHeader),
    authorizedByQuery: Boolean(authorizedByQuery),
    authorizedByManual: Boolean(authorizedByManual)
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const auth = authStatus(req);

  if (!auth.ok) {
    return res.status(401).json({
      ok: false,
      version: API_VERSION,
      model: ACTIVE_MODEL,
      error: auth.reason
    });
  }

  const turkeyNow = getTurkeyTimeParts(new Date());

  if (!isAfterFinalWindow(turkeyNow)) {
    return res.status(200).json({
      ok: false,
      blocked: true,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
      model: ACTIVE_MODEL,
      finalized: 0,
      total: FUNDS.length,
      turkeyNow,
      rule:
        "Türkiye saati 18:00 öncesi final kilitleme yapılmaz. Bu endpoint manuel testte veya erken cron çağrısında prediction_finals tablosuna yazmaz.",
      reason:
        "Türkiye saati 18:00 öncesi final kilitleme yapılmaz. Final tahmin yalnızca T günü 18:00 sonrası üretilen pending tahminlerden oluşturulur."
    });
  }

  try {
    const pendingRows = await getPendingPredictionRows();
    const validFinalWindowRows = getValidFinalWindowRows(pendingRows, turkeyNow);
    const targetDate = resolveTargetDate(req, validFinalWindowRows);

    if (!targetDate) {
      return res.status(200).json({
        ok: false,
        blocked: false,
        version: API_VERSION,
        generatedAt: new Date().toISOString(),
        model: ACTIVE_MODEL,
        finalized: 0,
        total: FUNDS.length,
        turkeyNow,
        pendingRows: pendingRows.length,
        validFinalWindowRows: validFinalWindowRows.length,
        error:
          "Final yapılacak geçerli 18:00 sonrası pending tahmin bulunamadı.",
        rule:
          "Final için aday kayıt, Türkiye saatine göre bugün 18:00 sonrası güncellenmiş/oluşturulmuş ve actual_change IS NULL olmalıdır."
      });
    }

    const existingPerformanceRows = await getExistingPerformanceRows(targetDate);
    const existingFinalRows = await getExistingFinalRows(targetDate);

    const closedFunds = new Set(
      existingPerformanceRows.map(row => row.fund_code)
    );

    const lockedFinalFunds = new Set(
      existingFinalRows
        .filter(row => row.locked === true || row.locked === "true")
        .filter(row => row.finalization_status === "finalized")
        .map(row => row.fund_code)
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

      if (lockedFinalFunds.has(fundCode)) {
        const existing = existingFinalRows.find(row => row.fund_code === fundCode);

        results.push({
          fund: fundCode,
          ok: true,
          skipped: true,
          alreadyFinalized: true,
          reason:
            "Bu fon ve tarih için kilitli final tahmin zaten var. Tekrar yazılmadı.",
          predictionDate: targetDate,
          existingFinalPredictionChange:
            existing && existing.final_prediction_change !== undefined
              ? round(existing.final_prediction_change, 6)
              : null,
          existingFinalizedAt: existing ? existing.finalized_at : null
        });

        continue;
      }

      const row = pickLatestPendingForFund(
        validFinalWindowRows,
        fundCode,
        targetDate
      );

      if (!row) {
        results.push({
          fund: fundCode,
          ok: false,
          skipped: true,
          reason:
            "Bu fon için hedef tarihte Türkiye saati 18:00 sonrası geçerli pending tahmin bulunamadı.",
          predictionDate: targetDate
        });

        continue;
      }

      const rowTurkey = rowTurkeyCandidateParts(row);

      const payload = buildFinalPayload(
        row,
        "T günü 18:00 sonrası güncel pending tahmin, T+1/T-hedef fiyat tarihi için nihai tahmin olarak kilitlendi."
      );

      payloads.push(payload);

      results.push({
        fund: fundCode,
        ok: true,
        predictionDate: targetDate,
        sourcePredictionId: row.id || null,
        sourceCreatedAt: row.created_at || null,
        sourceUpdatedAt: row.updated_at || null,
        sourceTurkeyDate: rowTurkey ? rowTurkey.dateText : null,
        sourceTurkeyTime: rowTurkey ? rowTurkey.timeText : null,
        finalPredictionChange: payload.final_prediction_change,
        predictedDirection: payload.predicted_direction,
        confidence: payload.confidence,
        coverage: payload.coverage
      });
    }

    const savedRows = await upsertFinalRows(payloads);

    const alreadyFinalizedCount = results.filter(
      item => item.ok && item.alreadyFinalized
    ).length;

    const successfulCount = payloads.length + alreadyFinalizedCount;

    return res.status(200).json({
      ok: successfulCount === FUNDS.length,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
      model: ACTIVE_MODEL,
      targetDate,
      turkeyNow,
      finalized: payloads.length,
      alreadyFinalized: alreadyFinalizedCount,
      successful: successfulCount,
      total: FUNDS.length,
      pendingRows: pendingRows.length,
      validFinalWindowRows: validFinalWindowRows.length,
      savedRows: Array.isArray(savedRows) ? savedRows.length : 0,
      rule:
        "Final tahmin yalnızca Türkiye saati 18:00 sonrası, aynı gün oluşturulmuş/güncellenmiş actual_change IS NULL tahminlerden seçilir.",
      protection:
        "18:00 öncesi çağrılar veri yazmaz. Performance kapanmışsa veya kilitli final zaten varsa final tahmin güncellenmez.",
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
