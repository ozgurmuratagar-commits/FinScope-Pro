const FUNDS = ["PBR", "PHE", "TLY", "THF"];

const API_VERSION = "FinScope Finalize Predictions API v8.6 - History Backfill Layer";
const ACTIVE_MODEL = "v7_1_accuracy_layer";
const DEFAULT_MODEL_VERSION = "FinScope Prediction Engine v8.6 - History Backfill Layer";

const TURKEY_TIME_ZONE = "Europe/Istanbul";
const FINAL_START_HOUR = 18;
const FINAL_START_MINUTE = 0;
const FINAL_START_TOTAL_MINUTES = FINAL_START_HOUR * 60 + FINAL_START_MINUTE;
const DEFAULT_REPAIR_FROM_DATE = "2026-08-26";

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

function dateText(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  return isValidDateText(text) ? text : null;
}

function compareDateText(a, b) {
  return String(a || "").localeCompare(String(b || ""));
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
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;

  const minute = Number(parts.minute);
  const second = Number(parts.second);

  const currentDateText = `${parts.year}-${parts.month}-${parts.day}`;
  const timeText = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;

  return {
    dateText: currentDateText,
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

function createdTimeMs(row) {
  const value = row.created_at || row.updated_at || row.finalized_at;
  const t = new Date(value || "1970-01-01T00:00:00Z").getTime();
  return Number.isFinite(t) ? t : 0;
}

function updatedTimeMs(row) {
  const value = row.updated_at || row.created_at || row.finalized_at;
  const t = new Date(value || "1970-01-01T00:00:00Z").getTime();
  return Number.isFinite(t) ? t : 0;
}

function sortPredictionCandidates(a, b) {
  const aPending = a.actual_change === null || a.actual_change === undefined;
  const bPending = b.actual_change === null || b.actual_change === undefined;

  if (aPending !== bPending) return aPending ? -1 : 1;

  const createdDiff = createdTimeMs(b) - createdTimeMs(a);
  if (createdDiff !== 0) return createdDiff;

  const updatedDiff = updatedTimeMs(b) - updatedTimeMs(a);
  if (updatedDiff !== 0) return updatedDiff;

  return num(b.id, 0) - num(a.id, 0);
}

function getPredictionValue(row) {
  const calibrated = num(row.calibrated_change, null);
  if (calibrated !== null) return calibrated;

  const predicted = num(row.predicted_change, null);
  if (predicted !== null) return predicted;

  const raw = num(row.raw_predicted_change, null);
  if (raw !== null) return raw;

  const finalPrediction = num(row.final_prediction_change, null);
  if (finalPrediction !== null) return finalPrediction;

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
      `Supabase ${options.method || "GET"} ${path} HTTP ${response.status}: ${text.slice(0, 1200)}`
    );
  }

  if (!text) return [];
  return JSON.parse(text);
}

function queryValue(req, key) {
  return req && req.query ? req.query[key] : undefined;
}

function isTruthyQuery(value) {
  return value === true || value === "1" || value === "true" || value === "yes" || value === "evet";
}

function isBackfillMode(req) {
  return (
    isTruthyQuery(queryValue(req, "backfill")) ||
    isTruthyQuery(queryValue(req, "repair")) ||
    queryValue(req, "mode") === "backfill" ||
    queryValue(req, "mode") === "repair"
  );
}

function resolveFromDate(req) {
  const explicitDate = queryValue(req, "date");
  if (isValidDateText(explicitDate)) return explicitDate;

  const from = queryValue(req, "from");
  if (isValidDateText(from)) return from;

  return DEFAULT_REPAIR_FROM_DATE;
}

function resolveToDate(req, turkeyNow) {
  const explicitDate = queryValue(req, "date");
  if (isValidDateText(explicitDate)) return explicitDate;

  const to = queryValue(req, "to");
  if (isValidDateText(to)) return to;

  return turkeyNow.dateText;
}

function shouldBlockCurrentDay(req, turkeyNow) {
  const explicitDate = queryValue(req, "date");
  const backfill = isBackfillMode(req);

  if (isAfterFinalWindow(turkeyNow)) return false;

  if (isValidDateText(explicitDate)) {
    return explicitDate >= turkeyNow.dateText;
  }

  if (backfill) return false;

  return true;
}

function allowedDateForCurrentTime(date, turkeyNow) {
  if (isAfterFinalWindow(turkeyNow)) return date <= turkeyNow.dateText;
  return date < turkeyNow.dateText;
}

async function getPredictionRows(fromDate, toDate, includeCompletedHistory) {
  const actualFilter = includeCompletedHistory ? "" : "&actual_change=is.null";

  const path =
    "prediction_history" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    actualFilter +
    `&prediction_date=gte.${encodeURIComponent(fromDate)}` +
    `&prediction_date=lte.${encodeURIComponent(toDate)}` +
    "&order=prediction_date.desc,created_at.desc,updated_at.desc" +
    "&limit=8000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

async function getExistingPerformanceRows(fromDate, toDate) {
  const path =
    "prediction_performance" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    `&prediction_date=gte.${encodeURIComponent(fromDate)}` +
    `&prediction_date=lte.${encodeURIComponent(toDate)}` +
    "&limit=8000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

async function getExistingFinalRows(fromDate, toDate) {
  const path =
    "prediction_finals" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    `&prediction_date=gte.${encodeURIComponent(fromDate)}` +
    `&prediction_date=lte.${encodeURIComponent(toDate)}` +
    "&limit=8000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

function isUsablePredictionRow(row, allowCompletedActual) {
  const fundCode = String(row.fund_code || "").toUpperCase();
  const predictionDate = dateText(row.prediction_date);
  const actualIsEmpty = row.actual_change === null || row.actual_change === undefined;

  return (
    FUNDS.includes(fundCode) &&
    Boolean(predictionDate) &&
    (allowCompletedActual || actualIsEmpty) &&
    getPredictionValue(row) !== null
  );
}

function uniqueTargetDates(rows, req, turkeyNow) {
  const explicitDate = queryValue(req, "date");
  if (isValidDateText(explicitDate)) return [explicitDate];

  const backfill = isBackfillMode(req);

  if (!backfill) {
    return [turkeyNow.dateText];
  }

  const dates = new Set();

  for (const row of rows || []) {
    const d = dateText(row.prediction_date);
    if (!d) continue;
    if (!allowedDateForCurrentTime(d, turkeyNow)) continue;
    dates.add(d);
  }

  return [...dates].sort((a, b) => compareDateText(a, b));
}

function keyFor(fundCode, predictionDate) {
  return `${fundCode}|${predictionDate}`;
}

function buildRowMap(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const fundCode = String(row.fund_code || "").toUpperCase();
    const predictionDate = dateText(row.prediction_date);
    if (!FUNDS.includes(fundCode) || !predictionDate) continue;

    const key = keyFor(fundCode, predictionDate);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }

  return map;
}

function hasExistingFinal(rows) {
  return (rows || []).some(row => {
    const value = getPredictionValue(row);
    return (
      row.locked === true ||
      row.locked === "true" ||
      row.finalization_status === "finalized" ||
      value !== null
    );
  });
}

function pickLatestPredictionForFundDate(rowsByKey, fundCode, predictionDate, allowCompletedActual) {
  const key = keyFor(fundCode, predictionDate);
  const rows = (rowsByKey.get(key) || [])
    .filter(row => isUsablePredictionRow(row, allowCompletedActual))
    .sort(sortPredictionCandidates);

  return rows[0] || null;
}

function buildFinalPayload(row, finalizeReason) {
  const finalPrediction = getPredictionValue(row);

  return {
    fund_code: String(row.fund_code || "").toUpperCase(),
    prediction_date: dateText(row.prediction_date),

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
      modelVersion: DEFAULT_MODEL_VERSION,
      error: auth.reason
    });
  }

  const turkeyNow = getTurkeyTimeParts(new Date());
  const explicitDate = queryValue(req, "date");
  const backfill = isBackfillMode(req);
  const includeCompletedHistory = backfill || isTruthyQuery(queryValue(req, "includeCompletedHistory"));
  const mode = isValidDateText(explicitDate)
    ? "single_date"
    : backfill
      ? "backfill_repair"
      : "normal_daily_final";

  if (shouldBlockCurrentDay(req, turkeyNow)) {
    return res.status(200).json({
      ok: false,
      blocked: true,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
      model: ACTIVE_MODEL,
      modelVersion: DEFAULT_MODEL_VERSION,
      fundOrder: FUNDS,
      thfIncluded: FUNDS.includes("THF"),
      mode,
      finalized: 0,
      total: FUNDS.length,
      turkeyNow,
      rule:
        "Türkiye saati 18:00 öncesi yalnızca geçmiş tarih backfill çalışabilir. Bugünün finali 18:00 öncesi kilitlenmez.",
      usage:
        "Geçmiş kayıt onarımı için /api/finalize-predictions?manual=finscope&backfill=1&from=2026-08-26 kullanılır."
    });
  }

  try {
    const fromDate = resolveFromDate(req);
    const toDate = resolveToDate(req, turkeyNow);

    if (compareDateText(fromDate, toDate) > 0) {
      return res.status(400).json({
        ok: false,
        version: API_VERSION,
        model: ACTIVE_MODEL,
        modelVersion: DEFAULT_MODEL_VERSION,
        error: "from tarihi to tarihinden büyük olamaz.",
        fromDate,
        toDate
      });
    }

    const predictionRows = await getPredictionRows(fromDate, toDate, includeCompletedHistory);
    const usablePredictionRows = predictionRows.filter(row =>
      isUsablePredictionRow(row, includeCompletedHistory)
    );
    const targetDates = uniqueTargetDates(usablePredictionRows, req, turkeyNow);

    const existingPerformanceRows = await getExistingPerformanceRows(fromDate, toDate);
    const existingFinalRows = await getExistingFinalRows(fromDate, toDate);

    const predictionRowsByKey = buildRowMap(usablePredictionRows);
    const performanceRowsByKey = buildRowMap(existingPerformanceRows);
    const finalRowsByKey = buildRowMap(existingFinalRows);

    const payloads = [];
    const results = [];

    for (const predictionDate of targetDates) {
      if (!allowedDateForCurrentTime(predictionDate, turkeyNow)) {
        results.push({
          date: predictionDate,
          ok: false,
          skipped: true,
          reason:
            predictionDate === turkeyNow.dateText
              ? "Bugünün finali Türkiye saati 18:00 öncesi kilitlenemez."
              : "Hedef tarih geçersiz veya gelecekte.",
          fund: null
        });
        continue;
      }

      for (const fundCode of FUNDS) {
        const rowKey = keyFor(fundCode, predictionDate);
        const performanceRows = performanceRowsByKey.get(rowKey) || [];
        const finalRows = finalRowsByKey.get(rowKey) || [];

        if (performanceRows.length > 0) {
          results.push({
            fund: fundCode,
            predictionDate,
            ok: true,
            skipped: true,
            reason: "performance_already_closed",
            note:
              "Bu fon ve tarih için performans zaten kapanmış. Final tahmin değiştirilmedi."
          });
          continue;
        }

        if (hasExistingFinal(finalRows)) {
          const existing = finalRows[0];

          results.push({
            fund: fundCode,
            predictionDate,
            ok: true,
            skipped: true,
            alreadyFinalized: true,
            reason: "final_already_exists",
            existingFinalPredictionChange:
              existing && existing.final_prediction_change !== undefined
                ? round(existing.final_prediction_change, 6)
                : null,
            existingFinalizedAt: existing ? existing.finalized_at : null
          });
          continue;
        }

        const selected = pickLatestPredictionForFundDate(
          predictionRowsByKey,
          fundCode,
          predictionDate,
          includeCompletedHistory
        );

        if (!selected) {
          results.push({
            fund: fundCode,
            predictionDate,
            ok: false,
            skipped: true,
            reason: "no_prediction_history_for_date",
            note:
              "Bu fon ve tarih için geçerli prediction_history satırı bulunamadı."
          });
          continue;
        }

        const selectedWasPending =
          selected.actual_change === null || selected.actual_change === undefined;

        const payload = buildFinalPayload(
          selected,
          mode === "backfill_repair"
            ? selectedWasPending
              ? "v8.6 backfill repair: hedef tarihin en son pending tahmini eksik final kaydı için kilitlendi."
              : "v8.6 backfill repair: pending satır kalmadığı için prediction_history completed satırındaki tahmin değeri final olarak onarıldı."
            : "v8.6 final repair: Türkiye saati 18:00 sonrası, hedef tarihin en son pending tahmini nihai tahmin olarak kilitlendi."
        );

        payloads.push(payload);

        results.push({
          fund: fundCode,
          predictionDate,
          ok: true,
          skipped: false,
          sourcePredictionId: selected.id || null,
          sourceCreatedAt: selected.created_at || null,
          sourceUpdatedAt: selected.updated_at || null,
          sourceActualChange: selected.actual_change === undefined ? null : selected.actual_change,
          sourceSelection:
            selectedWasPending
              ? "pending_prediction"
              : "completed_history_fallback",
          modelVersion: payload.model_version,
          finalPredictionChange: payload.final_prediction_change,
          predictedDirection: payload.predicted_direction,
          confidence: payload.confidence,
          coverage: payload.coverage,
          thfInitialLayer: fundCode === "THF"
        });
      }
    }

    const savedRows = await upsertFinalRows(payloads);

    const alreadyFinalizedCount = results.filter(row => row.reason === "final_already_exists").length;
    const performanceClosedCount = results.filter(row => row.reason === "performance_already_closed").length;
    const noPredictionCount = results.filter(row => row.reason === "no_prediction_history_for_date").length;
    const finalizedCount = payloads.length;

    return res.status(200).json({
      ok: true,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),
      model: ACTIVE_MODEL,
      modelVersion: DEFAULT_MODEL_VERSION,
      fundOrder: FUNDS,
      thfIncluded: FUNDS.includes("THF"),

      mode,
      includeCompletedHistory,
      fromDate,
      toDate,
      targetDates,
      turkeyNow,

      finalized: finalizedCount,
      alreadyFinalized: alreadyFinalizedCount,
      performanceAlreadyClosed: performanceClosedCount,
      noPredictionHistory: noPredictionCount,
      totalTargets: targetDates.length * FUNDS.length,

      predictionRows: predictionRows.length,
      usablePredictionRows: usablePredictionRows.length,
      existingFinalRows: existingFinalRows.length,
      existingPerformanceRows: existingPerformanceRows.length,
      savedRows: Array.isArray(savedRows) ? savedRows.length : 0,

      rule:
        "v8.6: Normal final kilidi 18:00 sonrası çalışır. Backfill modunda actual_change dolmuş eski prediction_history satırları da tahmin değeri taşıyorsa final onarımında kullanılabilir.",
      selectionRule:
        "Aynı fon/tarih için önce actual_change IS NULL pending tahmin seçilir. Pending yoksa backfill modunda en son created_at sıralı completed history satırı fallback olarak seçilir. Mevcut final veya kapanmış performance asla değiştirilmez.",
      nextStep:
        finalizedCount > 0
          ? "Şimdi /api/close-performance?manual=finscope çalıştırılarak yeni finaller performansa kapatılabilir."
          : "Yeni final yazılmadıysa predictionRows ve usablePredictionRows değerlerini kontrol edin. Sıfırsa ilgili tarih aralığında prediction_history yoktur ya da model/fund filtresi farklıdır.",

      results,
      saved: savedRows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: API_VERSION,
      model: ACTIVE_MODEL,
      modelVersion: DEFAULT_MODEL_VERSION,
      error: String(error.message || error)
    });
  }
};
