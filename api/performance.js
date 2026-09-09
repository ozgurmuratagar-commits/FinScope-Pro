const FUNDS = ["PBR", "PHE", "TLY", "THF"];

const API_VERSION = "FinScope Performance API v8.9.3 - Quarantine Aware Performance API";
const ACTIVE_MODEL = "v7_1_accuracy_layer";
const MODEL_VERSION = "FinScope Prediction Engine v8.9.1 - Strict Learning Gate";
const FINAL_LABEL = "T-1 18:00 Nihai Tahmin";

const MAX_RELIABLE_ACTUAL_CHANGE = 6;
const MAX_RELIABLE_FINAL_PREDICTION = 5;
const MAX_RELIABLE_ABSOLUTE_ERROR = 2.5;

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
  return String(value).slice(0, 10);
}

function boolOrNull(value) {
  if (value === null || value === undefined) return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return Boolean(value);
}

function direction(value) {
  const n = num(value, 0);
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function gradeFromError(errorAbs) {
  const e = Math.abs(num(errorAbs, 0));

  if (e <= 0.25) return "Çok iyi";
  if (e <= 0.50) return "İyi";
  if (e <= 0.85) return "Makul";
  if (e <= 1.25) return "Zayıf";
  return "Çok zayıf";
}

function fundOrder(code) {
  const index = FUNDS.indexOf(code);
  return index === -1 ? 999 : index;
}

function sortDisplayRows(a, b) {
  const dateCompare = String(b.predictionDate || "").localeCompare(
    String(a.predictionDate || "")
  );

  if (dateCompare !== 0) return dateCompare;

  return fundOrder(a.fundCode) - fundOrder(b.fundCode);
}

function isClosedStatus(value) {
  const status = String(value || "").toLowerCase();
  return status === "closed" || status === "completed";
}

function isQuarantinedStatus(value) {
  const status = String(value || "").toLowerCase();
  return status === "quarantined" || status === "karantina";
}

function reliabilityReasons(row) {
  const reasons = [];

  const predictionDate = dateText(row.prediction_date);
  const actualPriceDate = dateText(row.actual_price_date);
  const actualChange = num(row.actual_change, null);
  const finalPredictionChange = num(row.final_prediction_change, null);

  const errorChange =
    actualChange !== null && finalPredictionChange !== null
      ? actualChange - finalPredictionChange
      : num(row.error_change, null);

  const absoluteError =
    errorChange !== null
      ? Math.abs(errorChange)
      : num(row.absolute_error, null);

  if (isQuarantinedStatus(row.status)) {
    reasons.push("status_quarantined");
  }

  if (!isClosedStatus(row.status)) {
    reasons.push("status_not_closed");
  }

  if (!predictionDate) {
    reasons.push("prediction_date_missing");
  }

  if (!actualPriceDate) {
    reasons.push("actual_price_date_missing");
  }

  if (predictionDate && actualPriceDate && actualPriceDate <= predictionDate) {
    reasons.push("actual_price_date_not_after_prediction_date");
  }

  if (actualChange === null) {
    reasons.push("actual_change_missing");
  } else if (Math.abs(actualChange) > MAX_RELIABLE_ACTUAL_CHANGE) {
    reasons.push(`actual_change_outlier_abs_gt_${MAX_RELIABLE_ACTUAL_CHANGE}`);
  }

  if (finalPredictionChange === null) {
    reasons.push("final_prediction_missing");
  } else if (Math.abs(finalPredictionChange) > MAX_RELIABLE_FINAL_PREDICTION) {
    reasons.push(
      `final_prediction_outlier_abs_gt_${MAX_RELIABLE_FINAL_PREDICTION}`
    );
  }

  if (absoluteError === null) {
    reasons.push("absolute_error_missing");
  } else if (Math.abs(absoluteError) > MAX_RELIABLE_ABSOLUTE_ERROR) {
    reasons.push(
      `absolute_error_outlier_abs_gt_${MAX_RELIABLE_ABSOLUTE_ERROR}`
    );
  }

  return reasons;
}

function isReliablePerformanceRow(row) {
  return reliabilityReasons(row).length === 0;
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

async function getPerformanceRows() {
  const path =
    "prediction_performance" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    "&order=prediction_date.desc,closed_at.desc,updated_at.desc" +
    "&limit=1000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

async function getFinalRows() {
  const path =
    "prediction_finals" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    "&order=prediction_date.desc,finalized_at.desc,updated_at.desc" +
    "&limit=1000";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

async function getLearningRows() {
  const path =
    "model_learning_stats" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    `&model=eq.${encodeURIComponent(ACTIVE_MODEL)}` +
    "&order=fund_code.asc";

  const rows = await supabaseRequest(path);
  return Array.isArray(rows) ? rows : [];
}

function makeKey(row) {
  return `${row.fund_code}|${dateText(row.prediction_date)}|${row.model || ACTIVE_MODEL}`;
}

function latestDate(rows, fieldName) {
  const dates = rows
    .map(row => dateText(row[fieldName]))
    .filter(Boolean)
    .sort();

  return dates.length ? dates[dates.length - 1] : null;
}

function normalizeCompletedRow(row) {
  const finalPredictionChange = num(row.final_prediction_change, null);
  const actualChange = num(row.actual_change, null);

  const errorChange =
    actualChange !== null && finalPredictionChange !== null
      ? actualChange - finalPredictionChange
      : num(row.error_change, null);

  const absoluteError =
    errorChange !== null
      ? Math.abs(errorChange)
      : num(row.absolute_error, null);

  return {
    id: row.id,
    finalId: row.final_id || null,

    fundCode: row.fund_code,
    predictionDate: dateText(row.prediction_date),

    model: row.model || ACTIVE_MODEL,
    modelVersion: row.model_version || null,

    status: "completed",
    rawStatus: row.status || null,
    completed: true,
    reliableForMetrics: true,
    quarantineReasons: [],

    source: "prediction_performance",
    finalPredictionSource: "prediction_finals.final_prediction_change",

    actualChange: round(actualChange, 4),

    finalPredictionChange: round(finalPredictionChange, 4),
    finalPredictionLabel: FINAL_LABEL,

    predictedChange: round(finalPredictionChange, 4),

    errorChange: round(errorChange, 4),
    absoluteError: round(absoluteError, 4),

    predictedDirection:
      row.predicted_direction || direction(finalPredictionChange),

    actualDirection:
      row.actual_direction || direction(actualChange),

    directionHit: boolOrNull(row.direction_hit),

    grade: row.grade || gradeFromError(absoluteError),

    note:
      row.note ||
      "Sapma = gerçekleşen TEFAS değişimi - tahmin tarihinden önceki gün 18:00 sonrası kilitlenen nihai tahmin.",

    actualPrice: round(row.actual_price, 8),
    actualPriceDate: dateText(row.actual_price_date),

    closedAt: row.closed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function normalizeQuarantinedRow(row) {
  const normalized = normalizeCompletedRow(row);
  const reasons = reliabilityReasons(row);

  return {
    ...normalized,
    status: "quarantined",
    rawStatus: row.status || "quarantined",
    completed: false,
    reliableForMetrics: false,
    quarantineReasons: reasons,
    grade: row.grade || "Karantina",
    note:
      row.note ||
      `Strict Learning Gate: Bu kayıt genel performans ortalamasına ve öğrenme metriklerine dahil edilmedi. Nedenler: ${reasons.join(", ")}`
  };
}

function normalizePendingFinalRow(row) {
  const finalPredictionChange = num(row.final_prediction_change, null);

  return {
    id: row.id,
    finalId: row.id,

    fundCode: row.fund_code,
    predictionDate: dateText(row.prediction_date),

    model: row.model || ACTIVE_MODEL,
    modelVersion: row.model_version || null,

    status: "waiting_actual",
    completed: false,

    source: "prediction_finals",
    finalPredictionSource: "prediction_finals.final_prediction_change",

    actualChange: null,

    finalPredictionChange: round(finalPredictionChange, 4),
    finalPredictionLabel: FINAL_LABEL,

    predictedChange: round(finalPredictionChange, 4),

    errorChange: null,
    absoluteError: null,

    predictedDirection:
      row.predicted_direction || direction(finalPredictionChange),

    actualDirection: null,
    directionHit: null,

    grade: "Bekliyor",

    note:
      "Final tahmin kilitlendi; gerçekleşen TEFAS fiyatı geldiğinde performans kapanacak.",

    actualPrice: null,
    actualPriceDate: null,

    finalizedAt: row.finalized_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function getPendingFinalRows(finalRows, performanceRows) {
  const closedKeys = new Set(performanceRows.map(makeKey));

  return finalRows.filter(row => {
    const key = makeKey(row);
    return !closedKeys.has(key);
  });
}

function buildLearningMap(learningRows) {
  const map = {};

  for (const code of FUNDS) {
    const row = learningRows.find(item => item.fund_code === code) || null;

    map[code] = row
      ? {
          fundCode: row.fund_code,
          model: row.model || ACTIVE_MODEL,
          calculatedAt: row.calculated_at || null,

          sampleSize: Number(row.sample_size || 0),
          completedPredictionCount: Number(row.completed_prediction_count || 0),

          averageError: round(row.average_error, 4),
          averageAbsoluteError: round(row.average_absolute_error, 4),

          last5AverageError: round(row.last5_average_error, 4),
          last5AverageAbsoluteError: round(row.last5_average_absolute_error, 4),

          last10AverageError: round(row.last10_average_error, 4),
          last10AverageAbsoluteError: round(row.last10_average_absolute_error, 4),

          directionHitCount: Number(row.direction_hit_count || 0),
          directionTotalCount: Number(row.direction_total_count || 0),
          directionHitRate: round(row.direction_hit_rate, 2),

          biasLabel: row.bias_label || null,
          learningStatus: row.learning_status || null,
          suggestedOffset: round(row.suggested_offset, 4),
          confidenceAdjustment: round(row.confidence_adjustment, 4),

          note: row.note || null
        }
      : {
          fundCode: code,
          model: ACTIVE_MODEL,
          sampleSize: 0,
          completedPredictionCount: 0,
          averageError: null,
          averageAbsoluteError: null,
          directionHitRate: null,
          biasLabel: "Veri yok",
          learningStatus:
            code === "THF"
              ? "THF yeni fon; henüz kapanmış performans verisi yok"
              : "Henüz öğrenme verisi yok",
          note:
            code === "THF"
              ? "THF için öğrenme istatistiği, ilk final tahmin kapanışı tamamlandıktan sonra oluşacaktır."
              : "model_learning_stats kaydı bulunamadı."
        };
  }

  return map;
}

function averageNumber(rows, fieldName) {
  const values = rows
    .map(row => num(row[fieldName], null))
    .filter(value => value !== null);

  if (!values.length) return null;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function directionRate(rows) {
  const directionRows = rows.filter(row => row.directionHit !== null);
  const hits = directionRows.filter(row => row.directionHit === true).length;

  if (!directionRows.length) {
    return {
      hitCount: 0,
      totalCount: 0,
      rate: null
    };
  }

  return {
    hitCount: hits,
    totalCount: directionRows.length,
    rate: (hits / directionRows.length) * 100
  };
}

function buildSummary(completedRows, pendingRows, quarantinedRows, learningMap) {
  const latestCompletedDate =
    completedRows.length > 0
      ? latestDate(
          completedRows.map(row => ({ prediction_date: row.predictionDate })),
          "prediction_date"
        )
      : null;

  const latestCompletedRows = completedRows.filter(
    row => row.predictionDate === latestCompletedDate
  );

  const allDirection = directionRate(completedRows);
  const latestDirection = directionRate(latestCompletedRows);

  const byFund = {};

  for (const code of FUNDS) {
    const fundRows = completedRows.filter(row => row.fundCode === code);
    const fundPendingRows = pendingRows.filter(row => row.fundCode === code);
    const fundQuarantinedRows = quarantinedRows.filter(row => row.fundCode === code);
    const fundDirection = directionRate(fundRows);

    byFund[code] = {
      fundCode: code,

      completedRows: fundRows.length,
      reliableCompletedRows: fundRows.length,
      pendingRows: fundPendingRows.length,
      quarantinedRows: fundQuarantinedRows.length,
      rawPerformanceRows: fundRows.length + fundQuarantinedRows.length,

      averageAbsoluteError: round(averageNumber(fundRows, "absoluteError"), 4),
      averageError: round(averageNumber(fundRows, "errorChange"), 4),

      directionHitCount: fundDirection.hitCount,
      directionTotalCount: fundDirection.totalCount,
      directionHitRate: round(fundDirection.rate, 2),

      learning: learningMap[code] || null
    };
  }

  return {
    totalRows: completedRows.length + pendingRows.length,
    reliableTotalRows: completedRows.length + pendingRows.length,
    rawTotalRows: completedRows.length + pendingRows.length + quarantinedRows.length,
    completedRows: completedRows.length,
    reliableCompletedRows: completedRows.length,
    pendingRows: pendingRows.length,
    quarantinedRows: quarantinedRows.length,
    quarantineRate:
      completedRows.length + quarantinedRows.length > 0
        ? round(
            (quarantinedRows.length / (completedRows.length + quarantinedRows.length)) * 100,
            2
          )
        : null,

    averageAbsoluteError: round(averageNumber(completedRows, "absoluteError"), 4),
    averageError: round(averageNumber(completedRows, "errorChange"), 4),

    latestDateAverageAbsoluteError: round(
      averageNumber(latestCompletedRows, "absoluteError"),
      4
    ),
    latestDateAverageError: round(
      averageNumber(latestCompletedRows, "errorChange"),
      4
    ),

    directionHitCount: allDirection.hitCount,
    directionTotalCount: allDirection.totalCount,
    directionHitRate: round(allDirection.rate, 2),

    latestDateDirectionHitCount: latestDirection.hitCount,
    latestDateDirectionTotalCount: latestDirection.totalCount,
    latestDateDirectionHitRate: round(latestDirection.rate, 2),

    latestCompletedDate,

    latestPendingFinalDate:
      pendingRows.length > 0
        ? latestDate(
            pendingRows.map(row => ({ prediction_date: row.predictionDate })),
            "prediction_date"
          )
        : null,

    finalPredictionLabel: FINAL_LABEL,
    fundOrder: FUNDS,
    thfIncluded: FUNDS.includes("THF"),
    thfCompletedRows: completedRows.filter(row => row.fundCode === "THF").length,
    thfPendingRows: pendingRows.filter(row => row.fundCode === "THF").length,

    formula:
      "Sapma = prediction_date sonrasındaki ilk TEFAS gerçekleşmesi - T-1 18:00 sonrası kilitlenen nihai tahmin",

    metricPolicy:
      "averageAbsoluteError ve directionHitRate yalnızca status=closed olan ve Strict Learning Gate filtresinden geçen güvenilir performans kayıtlarından hesaplanır. Karantina kayıtları genel ortalamaya katılmaz; summary.quarantinedRows ve byFund[].quarantinedRows içinde ayrıca raporlanır.",

    byFund
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const performanceRows = await getPerformanceRows();
    const finalRows = await getFinalRows();
    const learningRows = await getLearningRows();

    const reliablePerformanceRows = performanceRows.filter(isReliablePerformanceRow);
    const quarantinedPerformanceRows = performanceRows.filter(
      row => !isReliablePerformanceRow(row)
    );

    const completedRows = reliablePerformanceRows
      .map(normalizeCompletedRow)
      .sort(sortDisplayRows);

    const quarantinedRows = quarantinedPerformanceRows
      .map(normalizeQuarantinedRow)
      .sort(sortDisplayRows);

    const pendingRows = getPendingFinalRows(finalRows, performanceRows)
      .map(normalizePendingFinalRow)
      .sort(sortDisplayRows);

    const learningMap = buildLearningMap(learningRows);
    const summary = buildSummary(completedRows, pendingRows, quarantinedRows, learningMap);

    const rows = [...completedRows, ...pendingRows];

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      version: API_VERSION,

      source: "prediction_performance + prediction_finals + model_learning_stats",
      quarantineAware: true,
      strictLearningGate: {
        maxReliableActualChange: MAX_RELIABLE_ACTUAL_CHANGE,
        maxReliableFinalPrediction: MAX_RELIABLE_FINAL_PREDICTION,
        maxReliableAbsoluteError: MAX_RELIABLE_ABSOLUTE_ERROR,
        rule:
          "Dashboard ortalamaları sadece güvenilir closed kayıtları kullanır; quarantined kayıtlar audit amaçlı ayrıca döner."
      },
      model: ACTIVE_MODEL,
      modelVersion: MODEL_VERSION,
      fundOrder: FUNDS,
      thfIncluded: FUNDS.includes("THF"),

      selectionRule:
        "Dashboard rows THF dahil yalnızca güvenilir closed performans kayıtlarını ve bekleyen final tahminleri döndürür. Karantina kayıtları genel metriklerden ayrıştırılır.",

      finalPredictionLabel: FINAL_LABEL,
      finalPredictionSource: "prediction_finals.final_prediction_change",

      summary,

      rows,
      completedRows,
      pendingFinalRows: pendingRows,
      quarantinedRows,

      learningStats: learningMap,

      rawCounts: {
        predictionPerformanceRows: performanceRows.length,
        reliablePerformanceRows: reliablePerformanceRows.length,
        quarantinedPerformanceRows: quarantinedPerformanceRows.length,
        predictionFinalRows: finalRows.length,
        modelLearningRows: learningRows.length,
        thfPerformanceRows: performanceRows.filter(row => row.fund_code === "THF").length,
        thfReliablePerformanceRows: reliablePerformanceRows.filter(row => row.fund_code === "THF").length,
        thfQuarantinedPerformanceRows: quarantinedPerformanceRows.filter(row => row.fund_code === "THF").length,
        thfFinalRows: finalRows.filter(row => row.fund_code === "THF").length,
        thfLearningRows: learningRows.filter(row => row.fund_code === "THF").length
      },

      note:
        "Bu API eski prediction_history satır seçme mantığını kullanmaz. Performans yalnızca kilitli T-1 final tahmin ve gerçekleşen TEFAS verisi üzerinden hesaplanır. v8.9.3 ile quarantined kayıtlar genel ortalama ve yön isabeti hesabından ayrılır."
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: API_VERSION,
      model: ACTIVE_MODEL,
      modelVersion: MODEL_VERSION,
      error: String(error.message || error)
    });
  }
};
