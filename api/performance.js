const FUNDS = ["PBR", "PHE", "TLY", "THF"];

const API_VERSION = "FinScope Performance API v9.0.1 - Safe Shock Aware Performance API";
const ACTIVE_MODEL = "v7_1_accuracy_layer";
const MODEL_VERSION = "FinScope Prediction Engine v9.0.1 - Safe Shock Layer";
const FINAL_LABEL = "T-1 18:00 Nihai Tahmin";

const MAX_VALID_ACTUAL_CHANGE = 35;
const MAX_VALID_FINAL_PREDICTION = 20;

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

function dateOnly(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function direction(value) {
  const n = num(value, 0);
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function fundOrder(code) {
  const index = FUNDS.indexOf(String(code || "").toUpperCase());
  return index === -1 ? 999 : index;
}

function sortRows(a, b) {
  const d = String(b.predictionDate || "").localeCompare(String(a.predictionDate || ""));
  if (d !== 0) return d;
  return fundOrder(a.fundCode) - fundOrder(b.fundCode);
}

function isClosedStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "closed" || s === "completed";
}

function isShockStatus(status) {
  return String(status || "").toLowerCase() === "shock_closed";
}

function isQuarantineStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "quarantined" || s === "karantina";
}

function isReliableStatus(status) {
  return isClosedStatus(status) || isShockStatus(status);
}

function gradeFromError(absError, shockClosed) {
  if (shockClosed) return "Şok";

  const e = Math.abs(num(absError, 0));

  if (e <= 0.10) return "Hedefte";
  if (e <= 0.25) return "Çok iyi";
  if (e <= 0.50) return "İyi";
  if (e <= 0.85) return "Makul";
  if (e <= 1.25) return "Zayıf";
  return "Çok zayıf";
}

function directionHitValue(row, finalPredictionChange, actualChange) {
  if (row.direction_hit === true || row.direction_hit === "true") return true;
  if (row.direction_hit === false || row.direction_hit === "false") return false;

  if (finalPredictionChange === null || actualChange === null) return null;
  if (Math.abs(finalPredictionChange) < 0.01 || Math.abs(actualChange) < 0.01) return null;

  return direction(finalPredictionChange) === direction(actualChange);
}

function average(rows, field) {
  const values = [];

  for (const row of rows) {
    const value = num(row[field], null);
    if (value !== null) values.push(value);
  }

  if (!values.length) return null;

  return values.reduce(function(sum, value) {
    return sum + value;
  }, 0) / values.length;
}

function directionRate(rows) {
  const usable = rows.filter(function(row) {
    return row.directionHit === true || row.directionHit === false;
  });

  if (!usable.length) {
    return {
      hitCount: 0,
      totalCount: 0,
      rate: null
    };
  }

  const hitCount = usable.filter(function(row) {
    return row.directionHit === true;
  }).length;

  return {
    hitCount: hitCount,
    totalCount: usable.length,
    rate: (hitCount / usable.length) * 100
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

  return { url: url, key: key };
}

async function supabaseGet(path) {
  const config = getSupabaseConfig();

  const response = await fetch(config.url + "/rest/v1/" + path, {
    method: "GET",
    headers: {
      apikey: config.key,
      Authorization: "Bearer " + config.key,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error("Supabase GET " + path + " HTTP " + response.status + ": " + text.slice(0, 800));
  }

  if (!text) return [];

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Supabase JSON parse error: " + text.slice(0, 800));
  }
}

async function getPerformanceRows() {
  const path =
    "prediction_performance" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    "&model=eq." + encodeURIComponent(ACTIVE_MODEL) +
    "&order=prediction_date.desc" +
    "&limit=10000";

  const rows = await supabaseGet(path);
  return Array.isArray(rows) ? rows : [];
}

async function getFinalRows() {
  const path =
    "prediction_finals" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    "&model=eq." + encodeURIComponent(ACTIVE_MODEL) +
    "&order=prediction_date.desc" +
    "&limit=10000";

  const rows = await supabaseGet(path);
  return Array.isArray(rows) ? rows : [];
}

async function getLearningRows() {
  const path =
    "model_learning_stats" +
    "?select=*" +
    "&fund_code=in.(PBR,PHE,TLY,THF)" +
    "&model=eq." + encodeURIComponent(ACTIVE_MODEL) +
    "&order=fund_code.asc";

  const rows = await supabaseGet(path);
  return Array.isArray(rows) ? rows : [];
}

function makeKeyFromPerformance(row) {
  return [
    String(row.fund_code || "").toUpperCase(),
    dateOnly(row.prediction_date),
    row.model || ACTIVE_MODEL
  ].join("|");
}

function makeKeyFromFinal(row) {
  return [
    String(row.fund_code || "").toUpperCase(),
    dateOnly(row.prediction_date),
    row.model || ACTIVE_MODEL
  ].join("|");
}

function isReliablePerformanceRow(row) {
  const status = String(row.status || "").toLowerCase();
  const predictionDate = dateOnly(row.prediction_date);
  const actualPriceDate = dateOnly(row.actual_price_date);
  const actualChange = num(row.actual_change, null);
  const finalPredictionChange = num(row.final_prediction_change, null);

  if (!isReliableStatus(status)) return false;
  if (!predictionDate || !actualPriceDate) return false;
  if (actualPriceDate <= predictionDate) return false;

  if (actualChange === null) return false;
  if (Math.abs(actualChange) > MAX_VALID_ACTUAL_CHANGE) return false;

  if (finalPredictionChange === null) return false;
  if (Math.abs(finalPredictionChange) > MAX_VALID_FINAL_PREDICTION) return false;

  return true;
}

function normalizePerformanceRow(row) {
  const status = String(row.status || "").toLowerCase();
  const shockClosed = isShockStatus(status);

  const finalPredictionChange = num(row.final_prediction_change, null);
  const actualChange = num(row.actual_change, null);

  let errorChange = num(row.error_change, null);

  if (actualChange !== null && finalPredictionChange !== null) {
    errorChange = actualChange - finalPredictionChange;
  }

  const absoluteError =
    errorChange === null
      ? num(row.absolute_error, null)
      : Math.abs(errorChange);

  const hit = directionHitValue(row, finalPredictionChange, actualChange);

  return {
    id: row.id || null,
    finalId: row.final_id || null,

    fundCode: String(row.fund_code || "").toUpperCase(),
    predictionDate: dateOnly(row.prediction_date),

    model: row.model || ACTIVE_MODEL,
    modelVersion: row.model_version || MODEL_VERSION,

    status: shockClosed ? "shock_closed" : "completed",
    rawStatus: row.status || null,
    completed: true,
    reliableForMetrics: true,
    shockClosed: shockClosed,

    source: "prediction_performance",
    finalPredictionSource: "prediction_finals.final_prediction_change",

    actualChange: round(actualChange, 4),
    finalPredictionChange: round(finalPredictionChange, 4),
    finalPredictionLabel: FINAL_LABEL,
    predictedChange: round(finalPredictionChange, 4),

    errorChange: round(errorChange, 4),
    absoluteError: round(absoluteError, 4),

    predictedDirection: row.predicted_direction || direction(finalPredictionChange),
    actualDirection: row.actual_direction || direction(actualChange),
    directionHit: hit,

    grade: row.grade || gradeFromError(absoluteError, shockClosed),

    note:
      row.note ||
      (
        shockClosed
          ? "Büyük ama gerçek fiyat zinciriyle tutarlı hareket. shock_closed olarak güvenilir performans içinde izlenir."
          : "Sapma = gerçekleşen TEFAS değişimi - T-1 18:00 nihai tahmin."
      ),

    actualPrice: round(row.actual_price, 8),
    actualPriceDate: dateOnly(row.actual_price_date),

    closedAt: row.closed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function normalizeQuarantineRow(row) {
  const finalPredictionChange = num(row.final_prediction_change, null);
  const actualChange = num(row.actual_change, null);

  let errorChange = num(row.error_change, null);

  if (actualChange !== null && finalPredictionChange !== null) {
    errorChange = actualChange - finalPredictionChange;
  }

  const absoluteError =
    errorChange === null
      ? num(row.absolute_error, null)
      : Math.abs(errorChange);

  return {
    id: row.id || null,
    finalId: row.final_id || null,

    fundCode: String(row.fund_code || "").toUpperCase(),
    predictionDate: dateOnly(row.prediction_date),

    model: row.model || ACTIVE_MODEL,
    modelVersion: row.model_version || MODEL_VERSION,

    status: "quarantined",
    rawStatus: row.status || "quarantined",
    completed: false,
    reliableForMetrics: false,
    shockClosed: false,

    source: "prediction_performance",
    finalPredictionSource: "prediction_finals.final_prediction_change",

    actualChange: round(actualChange, 4),
    finalPredictionChange: round(finalPredictionChange, 4),
    finalPredictionLabel: FINAL_LABEL,
    predictedChange: round(finalPredictionChange, 4),

    errorChange: round(errorChange, 4),
    absoluteError: round(absoluteError, 4),

    predictedDirection: row.predicted_direction || direction(finalPredictionChange),
    actualDirection: row.actual_direction || direction(actualChange),
    directionHit: directionHitValue(row, finalPredictionChange, actualChange),

    grade: row.grade || "Karantina",

    note: row.note || "Bu kayıt güvenilir performans ortalamasına alınmadı.",

    actualPrice: round(row.actual_price, 8),
    actualPriceDate: dateOnly(row.actual_price_date),

    closedAt: row.closed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function normalizePendingFinalRow(row) {
  const finalPredictionChange = num(row.final_prediction_change, null);

  return {
    id: row.id || null,
    finalId: row.id || null,

    fundCode: String(row.fund_code || "").toUpperCase(),
    predictionDate: dateOnly(row.prediction_date),

    model: row.model || ACTIVE_MODEL,
    modelVersion: row.model_version || MODEL_VERSION,

    status: "waiting_actual",
    rawStatus: "waiting_actual",
    completed: false,
    reliableForMetrics: false,
    shockClosed: false,

    source: "prediction_finals",
    finalPredictionSource: "prediction_finals.final_prediction_change",

    actualChange: null,
    finalPredictionChange: round(finalPredictionChange, 4),
    finalPredictionLabel: FINAL_LABEL,
    predictedChange: round(finalPredictionChange, 4),

    errorChange: null,
    absoluteError: null,

    predictedDirection: row.predicted_direction || direction(finalPredictionChange),
    actualDirection: null,
    directionHit: null,

    grade: "Bekliyor",

    note: "Final tahmin kilitlendi; sonraki TEFAS gerçekleşmesi bekleniyor.",

    actualPrice: null,
    actualPriceDate: null,

    finalizedAt: row.finalized_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function buildPendingRows(finalRows, performanceRows) {
  const closedKeys = new Set();

  for (const row of performanceRows) {
    closedKeys.add(makeKeyFromPerformance(row));
  }

  const pending = [];

  for (const row of finalRows) {
    const key = makeKeyFromFinal(row);
    if (!closedKeys.has(key)) {
      pending.push(normalizePendingFinalRow(row));
    }
  }

  return pending;
}

function buildLearningMap(learningRows) {
  const map = {};

  for (const code of FUNDS) {
    const row = learningRows.find(function(item) {
      return String(item.fund_code || "").toUpperCase() === code;
    });

    if (!row) {
      map[code] = {
        fundCode: code,
        model: ACTIVE_MODEL,
        sampleSize: 0,
        completedPredictionCount: 0,
        averageError: null,
        averageAbsoluteError: null,
        directionHitRate: null,
        biasLabel: "Veri yok",
        learningStatus: "Henüz öğrenme verisi yok",
        note: "model_learning_stats kaydı bulunamadı."
      };
      continue;
    }

    map[code] = {
      fundCode: code,
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
    };
  }

  return map;
}

function latestDate(rows) {
  const dates = rows
    .map(function(row) {
      return row.predictionDate;
    })
    .filter(Boolean)
    .sort();

  return dates.length ? dates[dates.length - 1] : null;
}

function buildByFund(completedRows, pendingRows, quarantinedRows, learningMap) {
  const out = {};

  for (const code of FUNDS) {
    const rows = completedRows.filter(function(row) {
      return row.fundCode === code;
    });

    const normalRows = rows.filter(function(row) {
      return !row.shockClosed;
    });

    const shockRows = rows.filter(function(row) {
      return row.shockClosed;
    });

    const fundDirection = directionRate(rows);

    out[code] = {
      fundCode: code,

      completedRows: rows.length,
      reliableCompletedRows: rows.length,
      normalClosedRows: normalRows.length,
      shockClosedRows: shockRows.length,

      pendingRows: pendingRows.filter(function(row) {
        return row.fundCode === code;
      }).length,

      quarantinedRows: quarantinedRows.filter(function(row) {
        return row.fundCode === code;
      }).length,

      averageAbsoluteError: round(average(rows, "absoluteError"), 4),
      averageError: round(average(rows, "errorChange"), 4),

      normalAverageAbsoluteError: round(average(normalRows, "absoluteError"), 4),
      shockAverageAbsoluteError: round(average(shockRows, "absoluteError"), 4),

      directionHitCount: fundDirection.hitCount,
      directionTotalCount: fundDirection.totalCount,
      directionHitRate: round(fundDirection.rate, 2),

      learning: learningMap[code] || null
    };
  }

  return out;
}

function buildSummary(completedRows, pendingRows, quarantinedRows, learningMap) {
  const normalRows = completedRows.filter(function(row) {
    return !row.shockClosed;
  });

  const shockRows = completedRows.filter(function(row) {
    return row.shockClosed;
  });

  const allDirection = directionRate(completedRows);
  const lastDate = latestDate(completedRows);

  const latestRows = completedRows.filter(function(row) {
    return row.predictionDate === lastDate;
  });

  const latestDirection = directionRate(latestRows);

  const rawTotal =
    completedRows.length +
    pendingRows.length +
    quarantinedRows.length;

  return {
    totalRows: completedRows.length + pendingRows.length,
    reliableTotalRows: completedRows.length + pendingRows.length,
    rawTotalRows: rawTotal,

    completedRows: completedRows.length,
    reliableCompletedRows: completedRows.length,

    normalClosedRows: normalRows.length,
    shockClosedRows: shockRows.length,

    pendingRows: pendingRows.length,
    quarantinedRows: quarantinedRows.length,

    quarantineRate:
      rawTotal > 0
        ? round((quarantinedRows.length / rawTotal) * 100, 2)
        : null,

    shockRate:
      completedRows.length > 0
        ? round((shockRows.length / completedRows.length) * 100, 2)
        : null,

    averageAbsoluteError: round(average(completedRows, "absoluteError"), 4),
    averageError: round(average(completedRows, "errorChange"), 4),

    normalAverageAbsoluteError: round(average(normalRows, "absoluteError"), 4),
    shockAverageAbsoluteError: round(average(shockRows, "absoluteError"), 4),

    latestCompletedDate: lastDate,
    latestDateAverageAbsoluteError: round(average(latestRows, "absoluteError"), 4),
    latestDateAverageError: round(average(latestRows, "errorChange"), 4),

    directionHitCount: allDirection.hitCount,
    directionTotalCount: allDirection.totalCount,
    directionHitRate: round(allDirection.rate, 2),

    latestDateDirectionHitCount: latestDirection.hitCount,
    latestDateDirectionTotalCount: latestDirection.totalCount,
    latestDateDirectionHitRate: round(latestDirection.rate, 2),

    finalPredictionLabel: FINAL_LABEL,

    fundOrder: FUNDS,
    thfIncluded: true,

    byFund: buildByFund(completedRows, pendingRows, quarantinedRows, learningMap),

    formula:
      "Sapma = prediction_date sonrasındaki ilk TEFAS gerçekleşmesi - T-1 18:00 sonrası kilitlenen nihai tahmin",

    metricPolicy:
      "v9.0.1: status=closed ve status=shock_closed güvenilir performans kabul edilir. status=quarantined genel metriklere alınmaz."
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const performanceRows = await getPerformanceRows();
    const finalRows = await getFinalRows();
    const learningRows = await getLearningRows();

    const reliableRawRows = performanceRows.filter(function(row) {
      return isReliablePerformanceRow(row);
    });

    const quarantinedRawRows = performanceRows.filter(function(row) {
      return !isReliablePerformanceRow(row) || isQuarantineStatus(row.status);
    });

    const completedRows = reliableRawRows
      .map(normalizePerformanceRow)
      .sort(sortRows);

    const quarantinedRows = quarantinedRawRows
      .map(normalizeQuarantineRow)
      .sort(sortRows);

    const pendingRows = buildPendingRows(finalRows, performanceRows)
      .sort(sortRows);

    const normalClosedRows = completedRows.filter(function(row) {
      return !row.shockClosed;
    });

    const shockClosedRows = completedRows.filter(function(row) {
      return row.shockClosed;
    });

    const learningMap = buildLearningMap(learningRows);
    const summary = buildSummary(completedRows, pendingRows, quarantinedRows, learningMap);

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      version: API_VERSION,

      source: "prediction_performance + prediction_finals + model_learning_stats",
      shockAware: true,
      quarantineAware: true,

      model: ACTIVE_MODEL,
      modelVersion: MODEL_VERSION,

      fundOrder: FUNDS,
      thfIncluded: true,

      finalPredictionLabel: FINAL_LABEL,
      finalPredictionSource: "prediction_finals.final_prediction_change",

      selectionRule:
        "Dashboard THF dahil status=closed + status=shock_closed güvenilir performans kayıtlarını döndürür. Karantina kayıtları metriklerden ayrıdır.",

      summary: summary,

      rows: completedRows.concat(pendingRows),
      completedRows: completedRows,
      normalClosedRows: normalClosedRows,
      shockClosedRows: shockClosedRows,
      pendingFinalRows: pendingRows,
      quarantinedRows: quarantinedRows,

      learningStats: learningMap,

      rawCounts: {
        predictionPerformanceRows: performanceRows.length,
        reliablePerformanceRows: reliableRawRows.length,
        normalClosedPerformanceRows: normalClosedRows.length,
        shockClosedPerformanceRows: shockClosedRows.length,
        quarantinedPerformanceRows: quarantinedRows.length,
        predictionFinalRows: finalRows.length,
        modelLearningRows: learningRows.length,

        thfPerformanceRows: performanceRows.filter(function(row) {
          return row.fund_code === "THF";
        }).length,

        thfReliablePerformanceRows: reliableRawRows.filter(function(row) {
          return row.fund_code === "THF";
        }).length,

        thfShockClosedPerformanceRows: shockClosedRows.filter(function(row) {
          return row.fundCode === "THF";
        }).length,

        thfLearningRows: learningRows.filter(function(row) {
          return row.fund_code === "THF";
        }).length
      },

      note:
        "v9.0.1 güvenli sürüm: API çökmesini önlemek için sadeleştirildi. shock_closed kayıtlar güvenilir gerçek hareket olarak kabul edilir."
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: API_VERSION,
      model: ACTIVE_MODEL,
      modelVersion: MODEL_VERSION,
      error: String(error.message || error).slice(0, 1500)
    });
  }
};
