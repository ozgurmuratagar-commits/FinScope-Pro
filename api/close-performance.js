const FUNDS = ["PBR", "PHE", "TLY", "THF"];

const API_VERSION = "FinScope Close Performance API v10.2 - Object Key Safe Deterministic TEFAS Close Repair";
const ACTIVE_MODEL = "v7_1_accuracy_layer";
const MODEL_VERSION = "FinScope Prediction Engine v10.0 - Causal NAV Prediction Engine";

const DEFAULT_FROM_DATE = "2026-08-26";
const MIN_VALID_PRICE = 0;

const MAX_ABSOLUTE_ACTUAL_CHANGE = 35;
const MAX_ABSOLUTE_FINAL_PREDICTION = 25;

const SHOCK_ACTUAL_CHANGE_THRESHOLD = 6;
const SHOCK_ABSOLUTE_ERROR_THRESHOLD = 2.5;
const SHOCK_FINAL_PREDICTION_THRESHOLD = 5;

const DIRECTION_EPSILON = 0.01;
const CHANGE_TOLERANCE = 0.0001;
const DAILY_CHANGE_WARNING_TOLERANCE = 0.10;

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

function dateText(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function isValidDateText(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function compareDateText(a, b) {
  return String(a || "").localeCompare(String(b || ""));
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
  if (Math.abs(p) < DIRECTION_EPSILON || Math.abs(a) < DIRECTION_EPSILON) return null;

  return direction(p) === direction(a);
}

function gradeFromError(errorAbs) {
  const e = Math.abs(num(errorAbs, 0));

  if (e <= 0.10) return "Hedefte";
  if (e <= 0.25) return "Çok iyi";
  if (e <= 0.50) return "İyi";
  if (e <= 0.85) return "Makul";
  if (e <= 1.25) return "Zayıf";
  return "Çok zayıf";
}

function getBiasLabel(averageError) {
  const e = num(averageError, 0);

  if (e > 0.20) return "Model temkinli kalıyor / düşük tahmin ediyor";
  if (e < -0.20) return "Model iyimser kalıyor / yüksek tahmin ediyor";
  return "Dengeli";
}

function getLearningStatus(sampleSize, averageAbsoluteError, directionHitRate, shockRows) {
  const n = num(sampleSize, 0);
  const err = num(averageAbsoluteError, null);
  const hit = num(directionHitRate, null);
  const shocks = num(shockRows, 0);

  if (n === 0) return "Henüz öğrenme verisi yok";
  if (n < 5) return "Örnek sayısı düşük";
  if (shocks >= 3 && err !== null && err > 2.5) return "Şok öğrenmesi gerekli / causal engine öncelikli";
  if (err !== null && err <= 0.10 && hit !== null && hit >= 70) return "Hedefe yakın öğreniyor";
  if (err !== null && err <= 0.35 && hit !== null && hit >= 60) return "İyi öğreniyor";
  if (err !== null && err <= 0.65) return "Öğreniyor";
  if (err !== null && err <= 1.00) return "Takip ediliyor";
  if (err !== null && err > 1.25) return "Model yaklaşımı gözden geçirilmeli";
  return "Takip ediliyor";
}

function average(rows, field) {
  const values = rows
    .map(row => num(row[field], null))
    .filter(value => value !== null);

  if (!values.length) return null;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rowTimeMs(row) {
  const value =
    row.updated_at ||
    row.created_at ||
    row.closed_at ||
    row.finalized_at ||
    row.price_date ||
    "1970-01-01T00:00:00.000Z";

  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function sortPriceRows(a, b) {
  const dateCompare = compareDateText(dateText(a.price_date), dateText(b.price_date));
  if (dateCompare !== 0) return dateCompare;

  const timeCompare = rowTimeMs(a) - rowTimeMs(b);
  if (timeCompare !== 0) return timeCompare;

  return num(a.id, 0) - num(b.id, 0);
}

function sortNewestPerformance(a, b) {
  const dateCompare = compareDateText(dateText(b.prediction_date), dateText(a.prediction_date));
  if (dateCompare !== 0) return dateCompare;
  return rowTimeMs(b) - rowTimeMs(a);
}

function finalSelectionTimeMs(row) {
  const value =
    row.finalized_at ||
    row.updated_at ||
    row.source_created_at ||
    row.created_at ||
    "1970-01-01T00:00:00.000Z";

  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function makeFinalKey(row) {
  return `${String(row.fund_code || "").toUpperCase()}|${dateText(row.prediction_date)}|${row.model || ACTIVE_MODEL}`;
}

function makePerformanceKey(row) {
  return `${String(row.fund_code || "").toUpperCase()}|${dateText(row.prediction_date)}|${row.model || ACTIVE_MODEL}`;
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
      `Supabase ${options.method || "GET"} ${path} HTTP ${response.status}: ${text.slice(0, 1800)}`
    );
  }

  if (!text) return [];

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Supabase JSON parse failed for ${path}: ${text.slice(0, 800)}`);
  }
}

async function optionalSupabaseRequest(path, fallback = []) {
  try {
    const rows = await supabaseRequest(path);
    return Array.isArray(rows) ? rows : fallback;
  } catch {
    return fallback;
  }
}

function authStatus(req) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  const querySecret = req.query && req.query.secret;
  const manualKey = req.query && req.query.manual;

  const authorizedByHeader = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const authorizedByQuery = cronSecret && querySecret === cronSecret;
  const authorizedByManual = manualKey === "finscope";

  if (cronSecret && !authorizedByHeader && !authorizedByQuery && !authorizedByManual) {
    return { ok: false, reason: "Yetkisiz istek." };
  }

  return {
    ok: true,
    authorizedByHeader: Boolean(authorizedByHeader),
    authorizedByQuery: Boolean(authorizedByQuery),
    authorizedByManual: Boolean(authorizedByManual)
  };
}

function queryValue(req, key) {
  return req && req.query ? req.query[key] : undefined;
}

function isTruthyQuery(value) {
  return value === true || value === "1" || value === "true" || value === "yes" || value === "evet";
}

function getFromDate(req) {
  const exactDate = queryValue(req, "date");
  if (isValidDateText(exactDate)) return exactDate;

  const from = queryValue(req, "from");
  if (isValidDateText(from)) return from;

  return DEFAULT_FROM_DATE;
}

function getToDate(req) {
  const exactDate = queryValue(req, "date");
  if (isValidDateText(exactDate)) return exactDate;

  const to = queryValue(req, "to");
  if (isValidDateText(to)) return to;

  return null;
}

function predictionValueFromAnyRow(row) {
  return (
    num(row.final_prediction_change, null) ??
    num(row.calibrated_change, null) ??
    num(row.predicted_change, null) ??
    num(row.raw_predicted_change, null)
  );
}

function normalizeFinalFromPredictionFinal(row) {
  const finalPrediction = predictionValueFromAnyRow(row);

  return {
    ...row,
    source_table: "prediction_finals",
    source_priority: 100,
    source_id: row.id,
    final_id: row.id,
    final_prediction_change: finalPrediction,
    predicted_direction: row.predicted_direction || direction(finalPrediction),
    model: row.model || ACTIVE_MODEL,
    model_version: row.model_version || MODEL_VERSION,
    finalized_at: row.finalized_at || row.updated_at || row.created_at || null
  };
}

function normalizeFinalFromPredictionHistory(row) {
  const finalPrediction = predictionValueFromAnyRow(row);

  return {
    ...row,
    source_table: "prediction_history_fallback",
    source_priority: 10,
    source_id: row.id,
    final_id: null,
    final_prediction_change: finalPrediction,
    predicted_direction: row.predicted_direction || direction(finalPrediction),
    model: row.model || ACTIVE_MODEL,
    model_version: row.model_version || MODEL_VERSION,
    finalized_at: row.updated_at || row.created_at || null
  };
}

async function getPredictionFinalRows(req) {
  const fromDate = getFromDate(req);
  const toDate = getToDate(req);

  let path =
    "prediction_finals" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    "&finalization_status=eq.finalized" +
    `&prediction_date=gte.${encodeURIComponent(fromDate)}`;

  if (toDate) {
    path += `&prediction_date=lte.${encodeURIComponent(toDate)}`;
  }

  path += "&order=prediction_date.asc,fund_code.asc,finalized_at.asc,updated_at.asc,created_at.asc&limit=10000";

  const rows = await optionalSupabaseRequest(path, []);
  return rows.map(normalizeFinalFromPredictionFinal).filter(row => predictionValueFromAnyRow(row) !== null);
}

async function getPredictionHistoryFallbackRows(req) {
  const fromDate = getFromDate(req);
  const toDate = getToDate(req);

  let path =
    "prediction_history" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    `&prediction_date=gte.${encodeURIComponent(fromDate)}`;

  if (toDate) {
    path += `&prediction_date=lte.${encodeURIComponent(toDate)}`;
  }

  path += "&order=prediction_date.asc,fund_code.asc,updated_at.asc,created_at.asc&limit=12000";

  const rows = await optionalSupabaseRequest(path, []);

  return rows
    .map(normalizeFinalFromPredictionHistory)
    .filter(row => predictionValueFromAnyRow(row) !== null)
    .filter(row => dateText(row.prediction_date))
    .filter(row => FUNDS.includes(String(row.fund_code || "").toUpperCase()));
}

function selectBestFinalRow(existing, candidate) {
  if (!existing) return candidate;

  if (num(candidate.source_priority, 0) !== num(existing.source_priority, 0)) {
    return num(candidate.source_priority, 0) > num(existing.source_priority, 0) ? candidate : existing;
  }

  return finalSelectionTimeMs(candidate) >= finalSelectionTimeMs(existing) ? candidate : existing;
}

function mergeFinalSources(predictionFinalRows, historyFallbackRows) {
  const map = new Map();
  const sourceMap = {};

  for (const row of [...(historyFallbackRows || []), ...(predictionFinalRows || [])]) {
    const key = makeFinalKey(row);
    const selected = selectBestFinalRow(map.get(key), row);
    map.set(key, selected);
  }

  const rows = [...map.values()].sort((a, b) => {
    const dateCompare = compareDateText(dateText(a.prediction_date), dateText(b.prediction_date));
    if (dateCompare !== 0) return dateCompare;

    const fundCompare = String(a.fund_code || "").localeCompare(String(b.fund_code || ""));
    if (fundCompare !== 0) return fundCompare;

    return finalSelectionTimeMs(b) - finalSelectionTimeMs(a);
  });

  for (const row of rows) {
    const source = row.source_table || "unknown";
    sourceMap[source] = (sourceMap[source] || 0) + 1;
  }

  return {
    rows,
    sourceMap,
    predictionFinalRows: predictionFinalRows.length,
    historyFallbackRows: historyFallbackRows.length,
    mergedRows: rows.length,
    fallbackRowsUsed: rows.filter(row => row.source_table === "prediction_history_fallback").length
  };
}

async function getExistingPerformanceRows(req) {
  const fromDate = getFromDate(req);
  const toDate = getToDate(req);

  let path =
    "prediction_performance" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    `&prediction_date=gte.${encodeURIComponent(fromDate)}`;

  if (toDate) {
    path += `&prediction_date=lte.${encodeURIComponent(toDate)}`;
  }

  path += "&order=prediction_date.desc,closed_at.desc,updated_at.desc,created_at.desc&limit=12000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

async function getAllPerformanceRowsForLearning() {
  const path =
    "prediction_performance" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    `&prediction_date=gte.${encodeURIComponent(DEFAULT_FROM_DATE)}` +
    "&order=prediction_date.desc,closed_at.desc,updated_at.desc,created_at.desc&limit=12000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

async function getFundPriceRows() {
  const path =
    "fund_prices" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    "&order=fund_code.asc,price_date.asc,created_at.asc" +
    "&limit=30000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

function isValidPriceRow(row) {
  const fundCode = String(row.fund_code || "").toUpperCase();
  const priceDate = dateText(row.price_date);
  const price = num(row.price, null);

  return FUNDS.includes(fundCode) && Boolean(priceDate) && price !== null && price > MIN_VALID_PRICE;
}

function buildPriceSeries(fundPriceRows) {
  const latestByFundDate = new Map();
  const rejected = [];

  for (const row of fundPriceRows || []) {
    const fundCode = String(row.fund_code || "").toUpperCase();
    const priceDate = dateText(row.price_date);

    if (!FUNDS.includes(fundCode) || !priceDate) continue;

    const key = `${fundCode}|${priceDate}`;
    const existing = latestByFundDate.get(key);
    const rowValid = isValidPriceRow(row);
    const existingValid = existing ? isValidPriceRow(existing) : false;

    if (!rowValid) {
      rejected.push({
        fundCode,
        priceDate,
        price: row.price ?? null,
        reason: "invalid_price_row_ignored_if_valid_alternative_exists"
      });
    }

    if (!existing) {
      latestByFundDate.set(key, row);
      continue;
    }

    if (rowValid && !existingValid) {
      latestByFundDate.set(key, row);
      continue;
    }

    if (rowValid === existingValid && rowTimeMs(row) >= rowTimeMs(existing)) {
      latestByFundDate.set(key, row);
    }
  }

  const grouped = {};
  for (const code of FUNDS) grouped[code] = [];

  for (const row of latestByFundDate.values()) {
    const code = String(row.fund_code || "").toUpperCase();
    if (!isValidPriceRow(row)) continue;
    grouped[code].push(row);
  }

  for (const code of FUNDS) grouped[code].sort(sortPriceRows);

  return {
    grouped,
    diagnostics: {
      rawPriceRows: Array.isArray(fundPriceRows) ? fundPriceRows.length : 0,
      selectedPriceRows: Object.values(grouped).reduce((sum, rows) => sum + rows.length, 0),
      rejectedInvalidPriceRows: rejected.length,
      rejectedSample: rejected.slice(0, 20)
    }
  };
}

function buildExistingPerformanceMap(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const key = makePerformanceKey(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }

  for (const [key, value] of map.entries()) {
    value.sort(sortNewestPerformance);
    map.set(key, value);
  }

  return map;
}

function validateFinalRow(finalRow) {
  const fundCode = String(finalRow.fund_code || "").toUpperCase();
  const finalPrediction = predictionValueFromAnyRow(finalRow);
  const issues = [];

  if (!FUNDS.includes(fundCode)) issues.push("fund_code_invalid");
  if (!dateText(finalRow.prediction_date)) issues.push("prediction_date_missing");

  if (finalPrediction === null) {
    issues.push("final_prediction_change_missing");
  } else if (Math.abs(finalPrediction) > MAX_ABSOLUTE_FINAL_PREDICTION) {
    issues.push("final_prediction_change_out_of_absolute_range");
  }

  return {
    ok: issues.length === 0,
    issues,
    fundCode,
    finalPrediction
  };
}

function findNextActualPriceForFinal(finalRow, priceSeries) {
  const finalValidation = validateFinalRow(finalRow);

  if (!finalValidation.ok) {
    return {
      ok: false,
      reason: "invalid_final_prediction",
      issues: finalValidation.issues,
      row: null,
      previousRow: null
    };
  }

  const fundCode = finalValidation.fundCode;
  const predictionDate = dateText(finalRow.prediction_date);
  const rows = priceSeries[fundCode] || [];

  const actualIndex = rows.findIndex(row => compareDateText(dateText(row.price_date), predictionDate) > 0);

  if (actualIndex === -1) {
    return {
      ok: false,
      reason: "next_actual_price_not_available_yet",
      issues: ["next_actual_price_not_available_yet"],
      row: null,
      previousRow: rows.length ? rows[rows.length - 1] : null,
      predictionDate
    };
  }

  const actualRow = rows[actualIndex];
  const previousRow = rows[actualIndex - 1] || null;

  const actualPriceDate = dateText(actualRow.price_date);
  const actualPrice = num(actualRow.price, null);
  const previousPrice = num(previousRow && previousRow.price, null);
  const storedDailyChange = num(actualRow.daily_change, null);

  const issues = [];

  if (!previousRow) issues.push("previous_price_not_available");
  if (actualPrice === null || actualPrice <= MIN_VALID_PRICE) issues.push("actual_price_invalid_or_zero");
  if (previousPrice === null || previousPrice <= MIN_VALID_PRICE) issues.push("previous_price_invalid_or_zero");

  let calculatedActualChange = null;

  if (actualPrice !== null && previousPrice !== null && previousPrice > 0) {
    calculatedActualChange = ((actualPrice - previousPrice) / previousPrice) * 100;
  }

  if (calculatedActualChange === null) {
    issues.push("actual_change_calculation_failed");
  } else if (Math.abs(calculatedActualChange) > MAX_ABSOLUTE_ACTUAL_CHANGE) {
    issues.push(`actual_change_out_of_absolute_range_abs_gt_${MAX_ABSOLUTE_ACTUAL_CHANGE}`);
  }

  const storedVsCalculatedDifference =
    storedDailyChange !== null && calculatedActualChange !== null
      ? storedDailyChange - calculatedActualChange
      : null;

  const dailyChangeWarning =
    storedVsCalculatedDifference !== null &&
    Math.abs(storedVsCalculatedDifference) > DAILY_CHANGE_WARNING_TOLERANCE;

  return {
    ok: issues.length === 0,
    reason: issues.length ? "actual_price_invalid_or_suspicious" : "next_actual_price",
    issues,
    row: actualRow,
    previousRow,
    predictionDate,
    actualPriceDate,
    actualPrice,
    previousPrice,
    previousPriceDate: previousRow ? dateText(previousRow.price_date) : null,
    actualChange: calculatedActualChange,
    storedDailyChange,
    storedVsCalculatedDifference,
    dailyChangeWarning,
    matchRule: "deterministic_next_available_tefas_price_after_prediction_date"
  };
}

function buildPerformancePayload(finalRow, actualMatch) {
  const finalPrediction = predictionValueFromAnyRow(finalRow);
  const actualChange = num(actualMatch.actualChange, null);

  const errorChange = actualChange - finalPrediction;
  const absoluteError = Math.abs(errorChange);

  const predictedDirection = finalRow.predicted_direction || direction(finalPrediction);
  const actualDirection = direction(actualChange);
  const hit = directionHit(finalPrediction, actualChange);

  const payload = {
    fund_code: String(finalRow.fund_code || "").toUpperCase(),
    prediction_date: dateText(finalRow.prediction_date),

    model: finalRow.model || ACTIVE_MODEL,
    model_version: MODEL_VERSION,

    final_prediction_change: round(finalPrediction, 6),
    actual_change: round(actualChange, 6),

    error_change: round(errorChange, 6),
    absolute_error: round(absoluteError, 6),

    predicted_direction: predictedDirection,
    actual_direction: actualDirection,
    direction_hit: hit,

    grade: gradeFromError(absoluteError),
    note:
      `v10.2: Sapma = prediction_date sonrasındaki ilk TEFAS fiyat değişimi - kilitli nihai tahmin. ` +
      `Final kaynak: ${finalRow.source_table || "prediction_finals"}. ` +
      "Büyük ve fiyat zinciriyle tutarlı hareketler shock_closed olarak saklanır.",

    actual_price: round(actualMatch.actualPrice, 8),
    actual_price_date: actualMatch.actualPriceDate,

    closed_at: new Date().toISOString(),
    status: "closed",

    updated_at: new Date().toISOString()
  };

  if (finalRow.source_table === "prediction_finals" && finalRow.final_id !== null && finalRow.final_id !== undefined) {
    payload.final_id = finalRow.final_id;
  }

  return payload;
}

function evaluatePerformanceQuality(payload, actualMatch) {
  const reasons = [];
  const warnings = [];
  const shockReasons = [];

  const fundCode = String(payload.fund_code || "").toUpperCase();
  const actualPrice = num(payload.actual_price, null);
  const actualChange = num(payload.actual_change, null);
  const finalPrediction = num(payload.final_prediction_change, null);
  const absoluteError = num(payload.absolute_error, null);

  if (!FUNDS.includes(fundCode)) reasons.push("fund_code_invalid");

  if (actualPrice === null || actualPrice <= MIN_VALID_PRICE) {
    reasons.push("actual_price_invalid_or_zero");
  }

  if (actualChange === null) {
    reasons.push("actual_change_missing");
  } else if (Math.abs(actualChange) > MAX_ABSOLUTE_ACTUAL_CHANGE) {
    reasons.push(`actual_change_out_of_absolute_range_abs_gt_${MAX_ABSOLUTE_ACTUAL_CHANGE}`);
  } else if (Math.abs(actualChange) > SHOCK_ACTUAL_CHANGE_THRESHOLD) {
    shockReasons.push(`real_price_shock_abs_actual_change_gt_${SHOCK_ACTUAL_CHANGE_THRESHOLD}`);
  }

  if (finalPrediction === null) {
    reasons.push("final_prediction_missing");
  } else if (Math.abs(finalPrediction) > MAX_ABSOLUTE_FINAL_PREDICTION) {
    reasons.push(`final_prediction_out_of_absolute_range_abs_gt_${MAX_ABSOLUTE_FINAL_PREDICTION}`);
  } else if (Math.abs(finalPrediction) > SHOCK_FINAL_PREDICTION_THRESHOLD) {
    shockReasons.push(`model_final_prediction_extreme_abs_gt_${SHOCK_FINAL_PREDICTION_THRESHOLD}`);
  }

  if (absoluteError === null) {
    reasons.push("absolute_error_missing");
  } else if (Math.abs(absoluteError) > SHOCK_ABSOLUTE_ERROR_THRESHOLD) {
    shockReasons.push(`large_model_miss_abs_error_gt_${SHOCK_ABSOLUTE_ERROR_THRESHOLD}`);
  }

  if (actualMatch && actualMatch.dailyChangeWarning) {
    warnings.push("stored_daily_change_mismatch_warning");
  }

  const quarantined = reasons.length > 0;
  const shocked = !quarantined && shockReasons.length > 0;

  return {
    reliable: !quarantined,
    learningEligible: !quarantined,
    shock: shocked,
    status: quarantined ? "quarantined" : shocked ? "shock_closed" : "closed",
    grade: quarantined ? "Karantina" : shocked ? "Şok" : payload.grade,
    reasons,
    warnings,
    shockReasons
  };
}

function applyQualityToPayload(payload, quality) {
  payload.status = quality.status;
  payload.grade = quality.grade;

  if (quality.status === "quarantined") {
    payload.note =
      `v10.2 STRICT GATE: Bu satır model öğrenmesine alınmadı. Nedenler: ${quality.reasons.join(", ")}. ` +
      "Performans kaydı denetim için saklanır; model_learning_stats quarantined kayıtları kullanmaz.";
  } else if (quality.status === "shock_closed") {
    payload.note =
      `v10.2 SHOCK AWARE: Büyük hareket gerçek fiyat zinciriyle kapatıldı ve shock_closed olarak saklandı. ` +
      `Şok nedenleri: ${quality.shockReasons.join(", ")}. ` +
      "Bu kayıt veri hatası sayılmaz; Causal NAV Engine için şok öğrenme örneği olarak korunur.";
  }

  return payload;
}

function performanceNeedsUpsert(existingRows, payload, forceRepair) {
  if (forceRepair) return true;
  if (!existingRows || !existingRows.length) return true;

  const existing = existingRows[0];

  const existingActualDate = dateText(existing.actual_price_date);
  const payloadActualDate = dateText(payload.actual_price_date);

  if (existingActualDate !== payloadActualDate) return true;
  if (String(existing.status || "") !== String(payload.status || "")) return true;
  if (String(existing.grade || "") !== String(payload.grade || "")) return true;

  const fields = [
    "actual_change",
    "final_prediction_change",
    "error_change",
    "absolute_error",
    "actual_price"
  ];

  for (const field of fields) {
    const oldValue = num(existing[field], null);
    const newValue = num(payload[field], null);

    if (oldValue === null && newValue === null) continue;
    if (oldValue === null || newValue === null) return true;
    if (Math.abs(oldValue - newValue) > CHANGE_TOLERANCE) return true;
  }

  return false;
}

function dedupePerformancePayloads(payloads) {
  const map = new Map();

  for (const payload of payloads || []) {
    const key = makePerformanceKey(payload);
    const existing = map.get(key);

    if (!existing || rowTimeMs(payload) >= rowTimeMs(existing)) {
      map.set(key, payload);
    }
  }

  return [...map.values()];
}

function payloadKeySignature(payload) {
  return Object.keys(payload).sort().join("|");
}

function groupPayloadsByKeys(payloads) {
  const groups = new Map();

  for (const payload of payloads || []) {
    const signature = payloadKeySignature(payload);
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(payload);
  }

  return [...groups.entries()].map(([signature, rows]) => ({ signature, rows }));
}

async function postPerformancePayloadGroup(rows) {
  if (!rows.length) return [];

  const path =
    "prediction_performance" +
    "?on_conflict=fund_code,prediction_date,model";

  return await supabaseRequest(path, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: rows
  });
}

async function upsertPerformanceRows(payloads) {
  const groups = groupPayloadsByKeys(payloads);
  const savedRows = [];
  const errors = [];

  for (const group of groups) {
    try {
      const saved = await postPerformancePayloadGroup(group.rows);
      if (Array.isArray(saved)) savedRows.push(...saved);
    } catch (groupError) {
      if (group.rows.length === 1) {
        errors.push({
          stage: "group_single",
          signature: group.signature,
          row: {
            fund_code: group.rows[0].fund_code,
            prediction_date: group.rows[0].prediction_date,
            actual_price_date: group.rows[0].actual_price_date
          },
          error: String(groupError.message || groupError).slice(0, 1500)
        });
        continue;
      }

      for (const row of group.rows) {
        try {
          const saved = await postPerformancePayloadGroup([row]);
          if (Array.isArray(saved)) savedRows.push(...saved);
        } catch (rowError) {
          errors.push({
            stage: "row_retry",
            signature: group.signature,
            row: {
              fund_code: row.fund_code,
              prediction_date: row.prediction_date,
              actual_price_date: row.actual_price_date
            },
            error: String(rowError.message || rowError).slice(0, 1500)
          });
        }
      }
    }
  }

  if (errors.length && savedRows.length === 0) {
    throw new Error(`prediction_performance upsert failed. First error: ${JSON.stringify(errors[0]).slice(0, 1800)}`);
  }

  return {
    rows: savedRows,
    errors,
    groupCount: groups.length,
    groupSignatures: groups.map(group => ({
      count: group.rows.length,
      signature: group.signature
    }))
  };
}

function isLearningPerformanceRow(row) {
  const status = String(row.status || "").toLowerCase();
  const predictionDate = dateText(row.prediction_date);
  const actualPriceDate = dateText(row.actual_price_date);
  const actualPrice = num(row.actual_price, null);
  const actualChange = num(row.actual_change, null);
  const finalPrediction = num(row.final_prediction_change, null);
  const absoluteError = num(row.absolute_error, null);

  if (status !== "closed" && status !== "shock_closed") return false;
  if (!predictionDate || !actualPriceDate) return false;
  if (compareDateText(actualPriceDate, predictionDate) <= 0) return false;
  if (actualPrice === null || actualPrice <= MIN_VALID_PRICE) return false;
  if (actualChange === null || Math.abs(actualChange) > MAX_ABSOLUTE_ACTUAL_CHANGE) return false;
  if (finalPrediction === null || Math.abs(finalPrediction) > MAX_ABSOLUTE_FINAL_PREDICTION) return false;
  if (absoluteError === null) return false;

  return true;
}

function isShockLearningRow(row) {
  return String(row.status || "").toLowerCase() === "shock_closed";
}

function computeLearningStatsForFund(fundCode, performanceRows) {
  const rows = performanceRows
    .filter(row => row.fund_code === fundCode)
    .filter(row => row.model === ACTIVE_MODEL)
    .filter(isLearningPerformanceRow)
    .sort((a, b) => String(b.prediction_date || "").localeCompare(String(a.prediction_date || "")));

  const shockRows = rows.filter(isShockLearningRow);
  const normalRows = rows.filter(row => !isShockLearningRow(row));

  const sampleSize = rows.length;
  const last5 = rows.slice(0, 5);
  const last10 = rows.slice(0, 10);

  const averageError = average(rows, "error_change");
  const averageAbsoluteError = average(rows, "absolute_error");

  const last5AverageError = average(last5, "error_change");
  const last5AverageAbsoluteError = average(last5, "absolute_error");

  const last10AverageError = average(last10, "error_change");
  const last10AverageAbsoluteError = average(last10, "absolute_error");

  const directionRows = rows.filter(row => row.direction_hit !== null && row.direction_hit !== undefined);
  const directionHitCount = directionRows.filter(row => row.direction_hit === true || row.direction_hit === "true").length;
  const directionTotalCount = directionRows.length;

  const directionHitRate =
    directionTotalCount > 0
      ? (directionHitCount / directionTotalCount) * 100
      : null;

  const suggestedOffset =
    averageError === null
      ? null
      : round(Math.max(-0.85, Math.min(0.85, averageError * 0.35)), 6);

  let confidenceAdjustment = 0;

  if (averageAbsoluteError === null) {
    confidenceAdjustment = 0;
  } else if (averageAbsoluteError <= 0.35) {
    confidenceAdjustment = 5;
  } else if (averageAbsoluteError <= 0.65) {
    confidenceAdjustment = 2;
  } else if (averageAbsoluteError <= 1.00) {
    confidenceAdjustment = -3;
  } else if (shockRows.length >= 3) {
    confidenceAdjustment = -10;
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
    learning_status: getLearningStatus(sampleSize, averageAbsoluteError, directionHitRate, shockRows.length),

    suggested_offset: suggestedOffset,
    confidence_adjustment: round(confidenceAdjustment, 6),

    note:
      sampleSize === 0
        ? "Henüz güvenilir sonraki TEFAS günü kapanmış final performans kaydı yok."
        : `v10.2: İstatistikler normal closed + shock_closed gerçek fiyat hareketlerinden hesaplandı. Normal kayıt: ${normalRows.length}, şok kayıt: ${shockRows.length}. Quarantined kayıtlar öğrenmeye alınmaz.`,

    updated_at: new Date().toISOString()
  };
}

async function updateLearningStats() {
  const allRows = await getAllPerformanceRowsForLearning();
  const learningRows = allRows.filter(isLearningPerformanceRow);

  const payloads = FUNDS.map(fundCode => computeLearningStatsForFund(fundCode, learningRows));

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
    learningPerformanceRows: learningRows.length,
    ignoredPerformanceRows: allRows.length - learningRows.length,
    rows: saved
  };
}

function summarizeResults(results) {
  const summary = {
    created: 0,
    corrected: 0,
    verified: 0,
    waitingActual: 0,
    invalidFinal: 0,
    invalidActual: 0,
    closed: 0,
    shockClosed: 0,
    quarantined: 0,
    byFund: {}
  };

  for (const code of FUNDS) {
    summary.byFund[code] = {
      total: 0,
      created: 0,
      corrected: 0,
      verified: 0,
      waitingActual: 0,
      invalidActual: 0,
      invalidFinal: 0,
      closed: 0,
      shockClosed: 0,
      quarantined: 0
    };
  }

  for (const row of results || []) {
    const code = row.fund || row.fundCode || row.fund_code || "UNKNOWN";
    if (!summary.byFund[code]) {
      summary.byFund[code] = {
        total: 0,
        created: 0,
        corrected: 0,
        verified: 0,
        waitingActual: 0,
        invalidActual: 0,
        invalidFinal: 0,
        closed: 0,
        shockClosed: 0,
        quarantined: 0
      };
    }

    summary.byFund[code].total += 1;

    if (row.reason === "performance_created") {
      summary.created += 1;
      summary.byFund[code].created += 1;
    }

    if (row.reason === "performance_corrected") {
      summary.corrected += 1;
      summary.byFund[code].corrected += 1;
    }

    if (row.reason === "performance_already_closed_verified") {
      summary.verified += 1;
      summary.byFund[code].verified += 1;
    }

    if (row.reason === "next_actual_price_not_available_yet") {
      summary.waitingActual += 1;
      summary.byFund[code].waitingActual += 1;
    }

    if (row.reason === "invalid_final_prediction") {
      summary.invalidFinal += 1;
      summary.byFund[code].invalidFinal += 1;
    }

    if (row.reason === "actual_price_invalid_or_suspicious") {
      summary.invalidActual += 1;
      summary.byFund[code].invalidActual += 1;
    }

    if (row.qualityStatus === "closed") {
      summary.closed += 1;
      summary.byFund[code].closed += 1;
    }

    if (row.qualityStatus === "shock_closed") {
      summary.shockClosed += 1;
      summary.byFund[code].shockClosed += 1;
    }

    if (row.qualityStatus === "quarantined") {
      summary.quarantined += 1;
      summary.byFund[code].quarantined += 1;
    }
  }

  return summary;
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

  try {
    const forceRepair =
      isTruthyQuery(queryValue(req, "force")) ||
      isTruthyQuery(queryValue(req, "repair"));

    const dryRun = isTruthyQuery(queryValue(req, "dryRun"));

    const predictionFinalRows = await getPredictionFinalRows(req);
    const historyFallbackRows = await getPredictionHistoryFallbackRows(req);
    const finalMerge = mergeFinalSources(predictionFinalRows, historyFallbackRows);
    const finalRows = finalMerge.rows;

    const existingPerformanceRows = await getExistingPerformanceRows(req);
    const existingPerformanceMap = buildExistingPerformanceMap(existingPerformanceRows);

    const fundPriceRows = await getFundPriceRows();
    const priceBundle = buildPriceSeries(fundPriceRows);
    const priceSeries = priceBundle.grouped;

    const payloads = [];
    const results = [];

    for (const finalRow of finalRows) {
      const finalValidation = validateFinalRow(finalRow);

      if (!finalValidation.ok) {
        results.push({
          fund: finalRow.fund_code || null,
          predictionDate: dateText(finalRow.prediction_date),
          sourceTable: finalRow.source_table || null,
          sourceId: finalRow.source_id || null,
          ok: false,
          skipped: true,
          reason: "invalid_final_prediction",
          issues: finalValidation.issues
        });
        continue;
      }

      const actualMatch = findNextActualPriceForFinal(finalRow, priceSeries);

      if (!actualMatch.ok) {
        results.push({
          fund: finalValidation.fundCode,
          predictionDate: dateText(finalRow.prediction_date),
          sourceTable: finalRow.source_table || null,
          sourceId: finalRow.source_id || null,
          ok: false,
          skipped: true,
          reason: actualMatch.reason,
          issues: actualMatch.issues,
          previousPriceDate: actualMatch.previousRow ? dateText(actualMatch.previousRow.price_date) : null,
          note:
            actualMatch.reason === "next_actual_price_not_available_yet"
              ? "Bu final tahmin için prediction_date sonrasındaki ilk TEFAS fiyatı henüz yok."
              : "Gerçekleşen fiyat satırı mutlak güvenlik sınırını geçtiği veya hesaplanamadığı için performans kapatılmadı."
        });
        continue;
      }

      const payload = buildPerformancePayload(finalRow, actualMatch);
      const quality = evaluatePerformanceQuality(payload, actualMatch);
      applyQualityToPayload(payload, quality);

      const key = makePerformanceKey(payload);
      const existingRows = existingPerformanceMap.get(key) || [];
      const needsUpsert = performanceNeedsUpsert(existingRows, payload, forceRepair);

      if (!needsUpsert) {
        results.push({
          fund: payload.fund_code,
          predictionDate: payload.prediction_date,
          sourceTable: finalRow.source_table || null,
          sourceId: finalRow.source_id || null,
          ok: true,
          skipped: true,
          reason: "performance_already_closed_verified",
          matchRule: actualMatch.matchRule,
          actualPriceDate: payload.actual_price_date,
          actualChange: payload.actual_change,
          finalPredictionChange: payload.final_prediction_change,
          errorChange: payload.error_change,
          absoluteError: payload.absolute_error,
          qualityStatus: payload.status
        });
        continue;
      }

      payloads.push(payload);

      results.push({
        fund: payload.fund_code,
        predictionDate: payload.prediction_date,
        sourceTable: finalRow.source_table || null,
        sourceId: finalRow.source_id || null,
        ok: true,
        skipped: false,
        reason: existingRows.length ? "performance_corrected" : "performance_created",
        existingActualPriceDate: existingRows[0] ? dateText(existingRows[0].actual_price_date) : null,
        matchRule: actualMatch.matchRule,
        previousPriceDate: actualMatch.previousPriceDate,
        actualPriceDate: payload.actual_price_date,
        actualPrice: payload.actual_price,
        storedDailyChange: round(actualMatch.storedDailyChange, 6),
        calculatedActualChange: payload.actual_change,
        storedVsCalculatedDifference: round(actualMatch.storedVsCalculatedDifference, 6),
        dailyChangeWarning: actualMatch.dailyChangeWarning,
        finalPredictionChange: payload.final_prediction_change,
        errorChange: payload.error_change,
        absoluteError: payload.absolute_error,
        predictedDirection: payload.predicted_direction,
        actualDirection: payload.actual_direction,
        directionHit: payload.direction_hit,
        grade: payload.grade,
        qualityStatus: quality.status,
        qualityReasons: quality.reasons,
        qualityWarnings: quality.warnings,
        shockReasons: quality.shockReasons
      });
    }

    const dedupedPayloads = dedupePerformancePayloads(payloads);
    const duplicatePayloadsRemoved = payloads.length - dedupedPayloads.length;

    const upsertBundle = dryRun
      ? { rows: [], errors: [], groupCount: 0, groupSignatures: [] }
      : await upsertPerformanceRows(dedupedPayloads);

    const savedPerformanceRows = upsertBundle.rows;

    const learningStats = dryRun
      ? { savedRows: 0, learningPerformanceRows: 0, ignoredPerformanceRows: 0, rows: [] }
      : await updateLearningStats();

    const summary = summarizeResults(results);

    return res.status(200).json({
      ok: true,
      version: API_VERSION,
      generatedAt: new Date().toISOString(),

      model: ACTIVE_MODEL,
      modelVersion: MODEL_VERSION,
      fundOrder: FUNDS,
      thfIncluded: FUNDS.includes("THF"),

      fromDate: getFromDate(req),
      toDate: getToDate(req),
      forceRepair,
      dryRun,

      objectKeySafety: {
        enabled: true,
        reason:
          "Supabase bulk POST ayni request icindeki tum JSON objelerinde ayni key setini ister. v10.2 payloadlari key imzasina gore ayri gruplar halinde gonderir.",
        groupCount: upsertBundle.groupCount,
        groupSignatures: upsertBundle.groupSignatures,
        upsertErrors: upsertBundle.errors
      },

      deterministicCloseRepair: {
        enabled: true,
        rule:
          "Her fon ve prediction_date icin once prediction_finals final satiri kullanilir. Final yoksa prediction_history icindeki ayni tarihli son tahmin fallback final kabul edilir. Gerceklesme her zaman prediction_date sonrasindaki ilk gecerli TEFAS fiyatindan hesaplanir.",
        actualFormula:
          "actual_change = ((next_tefas_price_after_prediction_date - previous_tefas_price) / previous_tefas_price) * 100",
        errorFormula:
          "error_change = actual_change - final_prediction_change"
      },

      sourceSelection: {
        predictionFinalRows: finalMerge.predictionFinalRows,
        historyFallbackRows: finalMerge.historyFallbackRows,
        mergedFinalRows: finalMerge.mergedRows,
        fallbackRowsUsed: finalMerge.fallbackRowsUsed,
        sourceMap: finalMerge.sourceMap
      },

      priceSeriesDiagnostics: priceBundle.diagnostics,
      existingPerformanceRows: existingPerformanceRows.length,

      payloadsBeforeDedupe: payloads.length,
      duplicatePayloadsRemoved,
      payloadsAfterDedupe: dedupedPayloads.length,
      savedPerformanceRows: Array.isArray(savedPerformanceRows) ? savedPerformanceRows.length : 0,

      summary,

      created: summary.created,
      corrected: summary.corrected,
      alreadyClosedVerified: summary.verified,

      normalClosed: summary.closed,
      shockClosed: summary.shockClosed,
      quarantined: summary.quarantined,
      reliableClosed: summary.closed + summary.shockClosed,

      waitingActual: summary.waitingActual,
      invalidActual: summary.invalidActual,
      invalidFinal: summary.invalidFinal,

      learningPolicy:
        "model_learning_stats status=closed ve status=shock_closed gercek fiyat hareketlerini kullanir. status=quarantined kayitlar ogrenmeye alinmaz.",
      learningStatsUpdated: learningStats.savedRows,
      learningStatsLearningRows: learningStats.learningPerformanceRows,
      learningStatsIgnoredRows: learningStats.ignoredPerformanceRows,

      resultCount: results.length,
      resultSample: results.slice(0, 160),
      changedRowsSample: results.filter(row => !row.skipped).slice(0, 80),
      waitingActualSample: results.filter(row => row.reason === "next_actual_price_not_available_yet").slice(0, 40),
      savedPerformanceRowsSample: Array.isArray(savedPerformanceRows)
        ? savedPerformanceRows.slice(0, 40)
        : [],
      learningStatsSummary: {
        savedRows: learningStats.savedRows,
        learningPerformanceRows: learningStats.learningPerformanceRows,
        ignoredPerformanceRows: learningStats.ignoredPerformanceRows
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: API_VERSION,
      model: ACTIVE_MODEL,
      modelVersion: MODEL_VERSION,
      error: String(error.message || error).slice(0, 2500)
    });
  }
};
