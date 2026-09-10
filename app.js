const MARKET_ORDER = [
  "USDTRY", "EURTRY", "GBPTRY",
  "EURUSD", "GBPUSD", "DXY",
  "XAU", "XAG",
  "XU100", "XU050", "XU030",
  "BTCUSD", "BRENT"
];

const MARKET_LABELS = {
  USDTRY: "USD / TRY",
  EURTRY: "EUR / TRY",
  GBPTRY: "GBP / TRY",
  EURUSD: "EUR / USD",
  GBPUSD: "GBP / USD",
  DXY: "Dolar Endeksi",
  XAU: "Altın Ons",
  XAG: "Gümüş Ons",
  XU100: "BIST 100",
  XU050: "BIST 50",
  XU030: "BIST 30",
  BTCUSD: "Bitcoin",
  BRENT: "Brent Petrol"
};

const FUND_ORDER = ["PBR", "PHE", "TLY", "THF"];
const FUND_CARD_ORDER = FUND_ORDER.slice();

const FRONTEND_VERSION = "Shock UI Sync Frontend v9.0";
const DISPLAY_MODEL_NAME = "FinScope Prediction Engine v9.0 - Shock UI Sync";
const DISPLAY_MODEL_SHORT = "v9.0";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function firstNumber(values, fallback = null) {
  for (const value of values) {
    const n = num(value, null);
    if (n !== null) return n;
  }

  return fallback;
}

function formatNumber(value, digits = 4) {
  const n = num(value);
  if (n === null) return "—";

  return n.toLocaleString("tr-TR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

function formatPercent(value, digits = 2) {
  const n = num(value);
  if (n === null) return "—";

  return n.toLocaleString("tr-TR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }) + "%";
}

function directionClass(value) {
  const n = num(value, 0);
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function directionIcon(value) {
  const n = num(value, 0);
  if (n > 0) return "▲";
  if (n < 0) return "▼";
  return "•";
}

function sourceText(source) {
  if (!source) return "veri kaynağı bekleniyor";
  return String(source);
}

async function fetchJson(url) {
  const response = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(url + " HTTP " + response.status);
  }

  return await response.json();
}

function getMarketAssets(marketJson) {
  return marketJson && marketJson.assets ? marketJson.assets : {};
}

function getFunds(fundsJson) {
  return fundsJson && fundsJson.funds ? fundsJson.funds : {};
}

function getPredictions(predictionsJson) {
  return predictionsJson && predictionsJson.predictions ? predictionsJson.predictions : {};
}

function getPredictionChange(prediction) {
  if (!prediction) return null;

  return firstNumber(
    [
      prediction.predictedChange,
      prediction.predicted_change,
      prediction.currentPredictionChange,
      prediction.current_prediction_change,
      prediction.finalPredictionChange,
      prediction.final_prediction_change,
      prediction.calibratedChange,
      prediction.calibrated_change
    ],
    null
  );
}

function hasUsablePrediction(prediction) {
  return getPredictionChange(prediction) !== null;
}

function getModelLabel(predictionsJson) {
  const candidates = [
    predictionsJson && predictionsJson.modelVersion,
    predictionsJson && predictionsJson.modelName,
    predictionsJson && predictionsJson.version,
    predictionsJson && predictionsJson.model
  ]
    .filter(Boolean)
    .map(function(value) {
      return String(value);
    });

  for (const text of candidates) {
    if (text.includes("FinScope Prediction Engine")) return text;
    if (text.includes("v9.")) return text;
    if (text.includes("v8.")) return text;
  }

  return DISPLAY_MODEL_NAME;
}

function renderMarketCards(marketJson, fundsJson, predictionsJson) {
  const cards = document.getElementById("cards");

  const marketAssets = getMarketAssets(marketJson);
  const fundData = getFunds(fundsJson);
  const predictions = getPredictions(predictionsJson);

  const html = [];

  MARKET_ORDER.forEach(function(key) {
    const asset = marketAssets[key];
    if (!asset) return;

    const value = asset.value ?? asset.price;
    const change = asset.change ?? asset.dailyChange;
    const cls = directionClass(change);
    const icon = directionIcon(change);

    let suffix = "";
    if (["USDTRY", "EURTRY", "GBPTRY"].includes(key)) suffix = " ₺";
    if (["XAU", "XAG", "BTCUSD", "BRENT"].includes(key)) suffix = " $";

    html.push(`
      <div class="card">
        <h3>${escapeHtml(MARKET_LABELS[key] || key)}</h3>
        <div class="value">${formatNumber(value, 4)}${suffix}</div>
        <div class="${cls}">${icon} ${formatPercent(change, 2)}</div>
        <div class="small">canlı/gecikmeli</div>
        <div class="small">${escapeHtml(sourceText(asset.source))}</div>
      </div>
    `);
  });

  FUND_CARD_ORDER.forEach(function(code) {
    const fund = fundData[code] || {};
    const pred = predictions[code] || {};

    const fundChange = fund.dailyChange ?? fund.daily_change;
    const predChange = getPredictionChange(pred);
    const cls = directionClass(fundChange);
    const predCls = directionClass(predChange);

    const holdingsReady =
      fund.holdingsReady === true ||
      Number(fund.holdingsCount || 0) > 0 ||
      (Array.isArray(fund.holdings) && fund.holdings.length > 0);

    const hasPrediction =
      predChange !== null &&
      predChange !== undefined &&
      Number.isFinite(Number(String(predChange).replace(",", ".")));

    const predictionHtml = hasPrediction
      ? `
        <div class="${predCls}">Tahmin: ${directionIcon(predChange)} ${formatPercent(predChange, 2)}</div>
        <div class="small">Kapsam: %${formatNumber(pred.coverage, 2)} • Güven: ${escapeHtml(pred.confidenceText || "—")}</div>
        <div class="small">Yumuşatma etkisi: ${formatPercent(pred.smoothingImpact || 0, 2)}</div>
        <div class="small">Sapma düzeltmesi: ${formatPercent(pred.calibrationOffset || 0, 2)}</div>
        <div class="small">Accuracy damping: ${formatNumber(pred.accuracyDamping || 1, 4)}</div>
      `
      : `
        <div class="yellow">Tahmin: Kayıtlı tahmin bekleniyor</div>
        <div class="small">${escapeHtml(code)} fiyatı alındı; tahmin için /api/predictions içinde kayıtlı tahmin ve fund_holdings portföy ağırlığı gerekir.</div>
        <div class="small">Holdings: ${formatNumber(fund.holdingsCount || 0, 0)} • Hazır: ${holdingsReady ? "Evet" : "Hayır"}</div>
      `;

    html.push(`
      <div class="card">
        <h3>${escapeHtml(code)}</h3>
        <div class="value">${formatNumber(fund.price, 4)}</div>
        <div class="${cls}">${directionIcon(fundChange)} ${formatPercent(fundChange, 2)}</div>
        ${predictionHtml}
        <div class="small">TEFAS v4 • ${escapeHtml(fund.date || fund.priceDate || fund.price_date || "tarih yok")}</div>
      </div>
    `);
  });

  cards.innerHTML = html.join("");
  document.getElementById("cardCount").textContent = "Kart: " + html.length;
}

function renderPredictionSummary(predictionsJson) {
  const box = document.getElementById("predictionSummary");
  const predictions = getPredictions(predictionsJson);

  if (!Object.keys(predictions).length) {
    box.innerHTML = `<span class="error">Tahmin verisi alınamadı.</span>`;
    return;
  }

  const lines = [];

  lines.push(`
    <div class="summary-line">
      <b>Aktif Fon Kapsamı:</b> ${FUND_ORDER.map(escapeHtml).join(" / ")}
    </div>
  `);

  FUND_ORDER.forEach(function(code) {
    const p = predictions[code];

    if (!hasUsablePrediction(p)) {
      lines.push(`
        <div class="summary-line yellow">
          <b>${escapeHtml(code)}</b>:
          Kayıtlı tahmin bekleniyor. Fon kartı fiyat gösterse bile Tahmin Özeti için /api/predictions içinde ${escapeHtml(code)} kaydı gerekir.
        </div>
      `);
      return;
    }

    const pred = getPredictionChange(p);
    const raw = firstNumber([p.rawPredictedChange, p.raw_predicted_change], null);
    const unsmoothed = firstNumber([p.unsmoothedChange, p.unsmoothed_change], null);
    const smoothingImpact = firstNumber([p.smoothingImpact, p.smoothing_impact], 0);
    const offset = firstNumber([p.calibrationOffset, p.calibration_offset], 0);
    const damping = firstNumber([p.accuracyDamping, p.accuracy_damping], 1);
    const cls = directionClass(pred);

    const learningStatus =
      (p.accuracyLayer && p.accuracyLayer.status) ||
      (p.calibration && p.calibration.status) ||
      p.status ||
      "no_history";

    lines.push(`
      <div class="summary-line">
        <b>${escapeHtml(code)}</b>:
        <span class="${cls}">${directionIcon(pred)} ${DISPLAY_MODEL_SHORT} Tahmin ${formatPercent(pred, 2)}</span>
        <br />
        Yumuşatılmamış: ${formatPercent(unsmoothed, 2)}
        • TEFAS yumuşatma sonrası: ${formatPercent(raw, 2)}
        • Yumuşatma etkisi: ${formatPercent(smoothingImpact, 2)}
        <br />
        Sapma düzeltmesi: ${formatPercent(offset, 2)}
        • Accuracy damping: ${formatNumber(damping, 4)}
        • Güven: ${escapeHtml(p.confidenceText || "—")}
        • Kapsam: %${formatNumber(p.coverage, 2)}
        • Öğrenme: ${escapeHtml(learningStatus)}
      </div>
    `);
  });

  lines.push(`
    <div class="summary-line yellow">
      ${escapeHtml(FRONTEND_VERSION)}: Tahmin Özeti PBR / PHE / TLY / THF sırasını kullanır. Performans tarafında normal kapanış ve şok kapanış ayrımı okunur; sayfa açılışında /api/predict çalıştırılmaz.
    </div>
  `);

  box.innerHTML = lines.join("");
}

function renderAiAnalyst(predictionsJson) {
  const box = document.getElementById("aiAnalyst");
  const predictions = getPredictions(predictionsJson);

  if (!Object.keys(predictions).length) {
    box.innerHTML = `<span class="error">AI Analist için tahmin verisi alınamadı.</span>`;
    return;
  }

  const model = getModelLabel(predictionsJson);

  const rows = FUND_ORDER.map(function(code) {
    const p = predictions[code] || {};
    const pred = getPredictionChange(p);

    return {
      code,
      hasPrediction: pred !== null,
      pred: pred,
      smoothingImpact: num(p.smoothingImpact, 0),
      offset: num(p.calibrationOffset, 0),
      damping: num(p.accuracyDamping, 1)
    };
  });

  const availableRows = rows.filter(function(row) {
    return row.hasPrediction;
  });

  if (!availableRows.length) {
    box.innerHTML = `<span class="error">AI Analist için kullanılabilir kayıtlı tahmin yok.</span>`;
    return;
  }

  const best = availableRows.slice().sort(function(a, b) { return b.pred - a.pred; })[0];
  const worst = availableRows.slice().sort(function(a, b) { return a.pred - b.pred; })[0];

  const missingCodes = rows
    .filter(function(row) { return !row.hasPrediction; })
    .map(function(row) { return row.code; });

  const avgSmoothing =
    availableRows.reduce(function(sum, row) {
      return sum + Math.abs(row.smoothingImpact || 0);
    }, 0) / Math.max(1, availableRows.length);

  const avgOffset =
    availableRows.reduce(function(sum, row) {
      return sum + Math.abs(row.offset || 0);
    }, 0) / Math.max(1, availableRows.length);

  box.innerHTML = `
    <div class="summary-line">
      <b>${escapeHtml(model)}</b> aktif. Bu panel sadece kayıtlı tahminleri okur; tahmin motorunu yeniden tetiklemez.
    </div>
    <div class="summary-line">
      Analiz kapsamı: <b>${FUND_ORDER.map(escapeHtml).join(" / ")}</b>.
      Kayıtlı tahmin bulunan fonlar: <b>${availableRows.map(function(row) { return escapeHtml(row.code); }).join(" / ")}</b>.
      ${missingCodes.length ? `<br /><span class="yellow">Tahmini beklenen fonlar: ${missingCodes.map(escapeHtml).join(" / ")}</span>` : ""}
    </div>
    <div class="summary-line">
      En pozitif beklenti: <b>${escapeHtml(best.code)}</b> ${formatPercent(best.pred, 2)}.
      En zayıf beklenti: <b>${escapeHtml(worst.code)}</b> ${formatPercent(worst.pred, 2)}.
    </div>
    <div class="summary-line">
      Ortalama yumuşatma etkisi: <b>${formatPercent(avgSmoothing, 2)}</b>.
      Ortalama sapma düzeltmesi: <b>${formatPercent(avgOffset, 2)}</b>.
    </div>
    <div class="summary-line">
      ${escapeHtml(FRONTEND_VERSION)}: AI paneli THF dahil aktif fon listesini okur. Şok kapanışlar performans tarafında ayrı izlenir.
    </div>
  `;
}

function performanceGrade(errorAbs, shockClosed) {
  if (shockClosed) return "Şok";

  const e = Math.abs(num(errorAbs, 0));
  if (e <= 0.25) return "Çok iyi";
  if (e <= 0.50) return "İyi";
  if (e <= 0.85) return "Makul";
  if (e <= 1.25) return "Zayıf";
  return "Çok zayıf";
}

function isNormalClosedPerformanceStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "completed" || s === "closed";
}

function isShockClosedPerformanceStatus(status) {
  return String(status || "").toLowerCase() === "shock_closed";
}

function isCompletedPerformanceStatus(status) {
  return isNormalClosedPerformanceStatus(status) || isShockClosedPerformanceStatus(status);
}

function isQuarantinedPerformanceStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "quarantined" || s === "karantina";
}

function performanceStatusText(status) {
  if (isShockClosedPerformanceStatus(status)) return "Şok Kapanış";
  if (isNormalClosedPerformanceStatus(status)) return "Normal Kapanış";
  if (isQuarantinedPerformanceStatus(status)) return "Karantina / Audit";

  const s = String(status || "").toLowerCase();
  if (s === "waiting_actual") return "Gerçekleşme Bekliyor";

  return "Bekliyor";
}

function performanceStatusClass(status) {
  if (isShockClosedPerformanceStatus(status)) return "status-completed";
  if (isNormalClosedPerformanceStatus(status)) return "status-completed";
  if (isQuarantinedPerformanceStatus(status)) return "";
  return "";
}

function fundOrderIndex(code) {
  const index = FUND_ORDER.indexOf(code);
  return index === -1 ? 999 : index;
}

function sortPerformanceRows(a, b) {
  const dateCompare = String(b.predictionDate || "").localeCompare(
    String(a.predictionDate || "")
  );

  if (dateCompare !== 0) return dateCompare;

  return fundOrderIndex(a.fundCode) - fundOrderIndex(b.fundCode);
}

function getLatestPerformanceRows(performanceJson) {
  const rows =
    performanceJson && Array.isArray(performanceJson.rows)
      ? performanceJson.rows
      : [];

  return rows.slice().sort(sortPerformanceRows);
}

function resolveFinalPrediction(perf) {
  if (!perf) return null;

  if (perf.finalPredictionChange !== null && perf.finalPredictionChange !== undefined) {
    return num(perf.finalPredictionChange, null);
  }

  if (perf.calibratedChange !== null && perf.calibratedChange !== undefined) {
    return num(perf.calibratedChange, null);
  }

  return null;
}

function average(values) {
  const clean = values
    .map(function(value) {
      return num(value, null);
    })
    .filter(function(value) {
      return value !== null;
    });

  if (!clean.length) return null;

  return clean.reduce(function(sum, value) {
    return sum + value;
  }, 0) / clean.length;
}

function derivedDirectionRate(rows) {
  const usable = rows.filter(function(row) {
    return row && row.directionHit !== null && row.directionHit !== undefined;
  });

  if (!usable.length) return null;

  const hits = usable.filter(function(row) {
    return row.directionHit === true || row.directionHit === "true";
  }).length;

  return (hits / usable.length) * 100;
}

function biasLabelFromAverageError(avgError) {
  const e = num(avgError, null);

  if (e === null) return "Veri yok";
  if (e > 0.15) return "Tahmin düşük kalıyor";
  if (e < -0.15) return "Tahmin yüksek kalıyor";
  return "Dengeli";
}

function buildFundLearningPanel(performanceJson, performanceRows) {
  const summary = performanceJson.summary || {};
  const byFund = summary.byFund || performanceJson.byFund || {};
  const learningStats = performanceJson.learningStats || {};

  function trendLabel(completedRows, averageAbsError, averageError, shockRows) {
    const completed = Number(completedRows || 0);
    const shock = Number(shockRows || 0);
    const absError = num(averageAbsError, null);
    const avgError = num(averageError, null);
    const prefix = completed < 5 ? "Erken sinyal: " : "";

    if (avgError === null) return `${prefix}veri yok`;

    if (shock >= 3 && absError !== null && absError >= 2.5) {
      return `${prefix}şok hareket etkisi yüksek`;
    }

    if (absError !== null && absError >= 0.85 && Math.abs(avgError) <= 0.25) {
      return `${prefix}hata yönü kararsız`;
    }

    if (avgError > 0.15) return `${prefix}tahmin düşük kalıyor`;
    if (avgError < -0.15) return `${prefix}tahmin yüksek kalıyor`;

    return `${prefix}dengeli`;
  }

  function readableStatus(completedRows, averageAbsError, directionHitRate, shockRows) {
    const completed = Number(completedRows || 0);
    const shock = Number(shockRows || 0);
    const absError = num(averageAbsError, null);
    const hitRate = num(directionHitRate, null);

    if (completed === 0) return "Kapanmış veri yok";
    if (completed < 5) return "Örnek sayısı düşük — karar için erken";

    if (shock >= 3 && absError !== null && absError > 1.25) {
      return "Şok dönemi — nedensel motor gerekli";
    }

    if (absError !== null && absError <= 0.35 && hitRate !== null && hitRate >= 70) {
      return "İyi çalışıyor";
    }

    if (absError !== null && absError <= 0.65 && hitRate !== null && hitRate >= 70) {
      return "Öğreniyor / kullanılabilir";
    }

    if (absError !== null && absError <= 0.90 && hitRate !== null && hitRate >= 60) {
      return "Takip ediliyor";
    }

    if (hitRate !== null && hitRate < 50) {
      return "Yön tahmini zayıf";
    }

    if (absError !== null && absError > 1.25) {
      return "Model yaklaşımı gözden geçirilmeli";
    }

    return "Geliştiriliyor";
  }

  function offsetLabel(value) {
    const offset = num(value, null);
    if (offset === null) return "—";

    if (Math.abs(offset) < 0.005) {
      return `Düzeltme gerekmiyor (${formatPercent(offset, 2)})`;
    }

    if (offset > 0) {
      return `Tahmine ekle: ${formatPercent(offset, 2)} puan`;
    }

    return `Tahminden düş: ${formatPercent(Math.abs(offset), 2)} puan`;
  }

  function confidenceLabel(value) {
    const adjustment = num(value, null);
    if (adjustment === null) return "—";

    if (adjustment > 3) return `Güven artırıldı (+${formatNumber(adjustment, 0)})`;
    if (adjustment > 0) return `Güven hafif artırıldı (+${formatNumber(adjustment, 0)})`;
    if (adjustment < -3) return `Güven düşürüldü (${formatNumber(adjustment, 0)})`;
    if (adjustment < 0) return `Güven hafif düşürüldü (${formatNumber(adjustment, 0)})`;

    return "Güven nötr (0)";
  }

  const rows = FUND_ORDER.map(function(code) {
    const fundRows = performanceRows.filter(function(row) {
      return row && row.fundCode === code && isCompletedPerformanceStatus(row.status);
    });

    const normalRows = fundRows.filter(function(row) {
      return isNormalClosedPerformanceStatus(row.status);
    });

    const shockRows = fundRows.filter(function(row) {
      return isShockClosedPerformanceStatus(row.status) || row.shockClosed === true;
    });

    const stat = byFund[code] || {};
    const learning = stat.learning || learningStats[code] || {};

    const normalClosedRows = firstNumber(
      [
        stat.normalClosedRows,
        learning.normalClosedRows
      ],
      normalRows.length
    );

    const shockClosedRows = firstNumber(
      [
        stat.shockClosedRows,
        learning.shockClosedRows
      ],
      shockRows.length
    );

    const completedRows = firstNumber(
      [
        stat.reliableCompletedRows,
        stat.completedRows,
        learning.completedPredictionCount,
        learning.sampleSize
      ],
      fundRows.length
    );

    const quarantinedRows = firstNumber(
      [
        stat.quarantinedRows,
        stat.quarantineRows,
        learning.quarantinedRows
      ],
      0
    );

    const averageAbsError = firstNumber(
      [
        stat.averageAbsoluteError,
        learning.averageAbsoluteError,
        average(fundRows.map(function(row) { return row.absoluteError; }))
      ],
      null
    );

    const averageError = firstNumber(
      [
        stat.averageError,
        learning.averageError,
        average(fundRows.map(function(row) { return row.errorChange; }))
      ],
      null
    );

    const directionHitRate = firstNumber(
      [
        stat.directionHitRate,
        learning.directionHitRate,
        derivedDirectionRate(fundRows)
      ],
      null
    );

    const suggestedOffset = firstNumber(
      [
        learning.suggestedOffset,
        stat.suggestedOffset
      ],
      null
    );

    const confidenceAdjustment = firstNumber(
      [
        learning.confidenceAdjustment,
        stat.confidenceAdjustment
      ],
      null
    );

    const trend = trendLabel(completedRows, averageAbsError, averageError, shockClosedRows);
    const status = readableStatus(completedRows, averageAbsError, directionHitRate, shockClosedRows);

    const avgErrorClass = directionClass(averageError);
    const offsetClass = directionClass(suggestedOffset);

    return `
      <tr>
        <td><b>${escapeHtml(code)}</b></td>
        <td>${formatNumber(normalClosedRows, 0)}</td>
        <td class="yellow">${formatNumber(shockClosedRows, 0)}</td>
        <td><b>${formatNumber(completedRows, 0)}</b></td>
        <td>${formatNumber(quarantinedRows, 0)}</td>
        <td><b>${formatPercent(averageAbsError, 2)}</b></td>
        <td class="${avgErrorClass}">
          ${averageError === null ? "—" : formatPercent(averageError, 2)}
        </td>
        <td>${escapeHtml(trend)}</td>
        <td>${formatPercent(directionHitRate, 2)}</td>
        <td class="${offsetClass}">
          ${escapeHtml(offsetLabel(suggestedOffset))}
        </td>
        <td>${escapeHtml(confidenceLabel(confidenceAdjustment))}</td>
        <td>${escapeHtml(status)}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="summary-line">
      <b>Fon Bazlı Öğrenme, Sapma ve Şok Ayrımı</b><br />
      Bu bölümde her fon ayrı değerlendirilir. <b>Normal Kapanış</b> olağan güvenilir kapanmış performanstır.
      <b>Şok Kapanış</b> ise PBR/PHE gibi büyük ama fiyat zinciriyle tutarlı gerçek hareketleri gösterir.
      Karantina / Audit kayıtları genel başarı ortalamasına alınmaz.
      <br />
      <b>Ortalama Mutlak Sapma</b>: |Gerçekleşen - Nihai Tahmin| ortalamasıdır.
      <br />
      <b>Ortalama Yönlü Hata</b>: Gerçekleşen - Nihai Tahmin ortalamasıdır. Pozitifse tahmin düşük kalmış, negatifse tahmin yüksek kalmıştır.
      <br />
      <b>Tahmin Düzeltmesi</b>: gelecek tahmine eklenmesi veya tahminden düşülmesi önerilen temkinli düzeltmedir.
    </div>

    <table class="perf-table">
      <thead>
        <tr>
          <th>Fon</th>
          <th>Normal Kapanış</th>
          <th>Şok Kapanış</th>
          <th>Güvenilir Toplam</th>
          <th>Karantina / Audit</th>
          <th>Ortalama Mutlak Sapma</th>
          <th>Ortalama Yönlü Hata</th>
          <th>Tahmin Eğilimi</th>
          <th>Yön İsabeti</th>
          <th>Tahmin Düzeltmesi</th>
          <th>Güven Etkisi</th>
          <th>Veri Durumu</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function buildShockMovementPanel(performanceRows) {
  const shockRows = performanceRows
    .filter(function(row) {
      return row && (row.shockClosed === true || isShockClosedPerformanceStatus(row.status));
    })
    .sort(sortPerformanceRows);

  if (!shockRows.length) {
    return `
      <div class="summary-line">
        <b>Şok Hareket İzleme:</b> Şu anda shock_closed kayıt bulunmuyor.
      </div>
    `;
  }

  const rows = shockRows.slice(0, 16).map(function(row) {
    const finalPrediction = resolveFinalPrediction(row);
    const actual = num(row.actualChange, null);
    const error = num(row.errorChange, null);

    return `
      <tr>
        <td><b>${escapeHtml(row.fundCode || "—")}</b></td>
        <td>${escapeHtml(row.predictionDate || "—")}</td>
        <td>${actual === null ? "—" : formatPercent(actual, 2)}</td>
        <td>${finalPrediction === null ? "—" : formatPercent(finalPrediction, 2)}</td>
        <td>${error === null ? "—" : formatPercent(error, 2)}</td>
        <td>${escapeHtml(row.actualPriceDate || "—")}</td>
        <td>${escapeHtml(row.grade || "Şok")}</td>
      </tr>
    `;
  }).join("");

  const pbrPheShockCount = shockRows.filter(function(row) {
    return row.fundCode === "PBR" || row.fundCode === "PHE";
  }).length;

  return `
    <div class="summary-line">
      <b>Şok Hareket İzleme</b><br />
      Bu tablo büyük ama gerçek fiyat zinciriyle tutarlı hareketleri gösterir.
      Bu kayıtlar veri hatası sayılmaz; özellikle PBR/PHE tarafında nedensel tahmin motoru için sinyal kabul edilir.
      <br />
      Toplam şok kayıt: <b>${formatNumber(shockRows.length, 0)}</b>
      • PBR/PHE şok kayıt: <b>${formatNumber(pbrPheShockCount, 0)}</b>.
    </div>

    <table class="perf-table">
      <thead>
        <tr>
          <th>Fon</th>
          <th>Tahmin Tarihi</th>
          <th>Gerçekleşen</th>
          <th>Nihai Tahmin</th>
          <th>Sapma</th>
          <th>Gerçekleşme Tarihi</th>
          <th>Etiket</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function renderPerformance(performanceJson) {
  const box = document.getElementById("performanceBox");

  if (!performanceJson || !performanceJson.ok) {
    box.innerHTML = `<span class="error">Performans verisi alınamadı.</span>`;
    return;
  }

  const summary = performanceJson.summary || {};
  const performanceRows = getLatestPerformanceRows(performanceJson);

  const rawCounts = performanceJson.rawCounts || {};

  const normalClosedRows = firstNumber(
    [
      summary.normalClosedRows,
      rawCounts.normalClosedPerformanceRows
    ],
    performanceRows.filter(function(row) {
      return row && isNormalClosedPerformanceStatus(row.status);
    }).length
  );

  const shockClosedRows = firstNumber(
    [
      summary.shockClosedRows,
      rawCounts.shockClosedPerformanceRows
    ],
    performanceRows.filter(function(row) {
      return row && (row.shockClosed === true || isShockClosedPerformanceStatus(row.status));
    }).length
  );

  const reliableCompletedRows = firstNumber(
    [
      summary.reliableCompletedRows,
      summary.completedRows,
      rawCounts.reliablePerformanceRows
    ],
    normalClosedRows + shockClosedRows
  );

  const quarantinedRows = firstNumber(
    [
      summary.quarantinedRows,
      rawCounts.quarantinedPerformanceRows
    ],
    0
  );

  const pendingRows = firstNumber(
    [
      summary.pendingRows,
      rawCounts.pendingFinalRows
    ],
    performanceRows.filter(function(row) {
      return row && !isCompletedPerformanceStatus(row.status) && !isQuarantinedPerformanceStatus(row.status);
    }).length
  );

  const rawTotalRows = firstNumber(
    [
      summary.rawTotalRows,
      summary.totalRawRows,
      rawCounts.predictionPerformanceRows
    ],
    reliableCompletedRows + quarantinedRows + pendingRows
  );

  const reliableTotalRows = firstNumber(
    [
      summary.reliableTotalRows,
      summary.totalRows
    ],
    reliableCompletedRows + pendingRows
  );

  const quarantineRate = firstNumber(
    [summary.quarantineRate],
    rawTotalRows ? (quarantinedRows / rawTotalRows) * 100 : null
  );

  const shockRate = firstNumber(
    [summary.shockRate],
    reliableCompletedRows ? (shockClosedRows / reliableCompletedRows) * 100 : null
  );

  const avgError =
    summary.averageAbsoluteError === null || summary.averageAbsoluteError === undefined
      ? "Bekliyor"
      : formatPercent(summary.averageAbsoluteError, 2);

  const latestDateAvgError =
    summary.latestDateAverageAbsoluteError === null ||
    summary.latestDateAverageAbsoluteError === undefined
      ? null
      : formatPercent(summary.latestDateAverageAbsoluteError, 2);

  const directionRate =
    summary.directionHitRate === null || summary.directionHitRate === undefined
      ? "Bekliyor"
      : formatPercent(summary.directionHitRate, 2);

  const finalLabel =
    performanceJson.finalPredictionLabel ||
    summary.finalPredictionLabel ||
    "T-1 18:00 Nihai Tahmin";

  const deviationFormula =
    summary.formula ||
    summary.deviationFormula ||
    "Sapma = gerçekleşen TEFAS değişimi - T-1 18:00 sonrası kilitlenen nihai tahmin";

  const apiVersion = performanceJson.version || "Performance API";
  const fundLearningPanel = buildFundLearningPanel(performanceJson, performanceRows);
  const shockMovementPanel = buildShockMovementPanel(performanceRows);

  const tableRows = performanceRows.length
    ? performanceRows.map(function(perf) {
        const status = perf.status || "pending";

        const finalPrediction = resolveFinalPrediction(perf);
        const actual = num(perf.actualChange, null);

        const apiError = num(perf.errorChange, null);
        const calculatedError =
          actual !== null &&
          actual !== undefined &&
          finalPrediction !== null &&
          finalPrediction !== undefined
            ? actual - finalPrediction
            : null;

        const error = apiError !== null ? apiError : calculatedError;

        const statusText = performanceStatusText(status);
        const statusClass = performanceStatusClass(status);
        const shockClosed = perf.shockClosed === true || isShockClosedPerformanceStatus(status);

        const grade =
          error === null || error === undefined
            ? "Bekliyor"
            : (perf.grade || performanceGrade(error, shockClosed));

        return `
          <tr>
            <td><b>${escapeHtml(perf.fundCode || "—")}</b></td>
            <td>${escapeHtml(perf.predictionDate || performanceJson.predictionDate || "—")}</td>
            <td>${actual === null || actual === undefined ? "Bekliyor" : formatPercent(actual, 2)}</td>
            <td class="${directionClass(finalPrediction)}">${finalPrediction === null || finalPrediction === undefined ? "—" : formatPercent(finalPrediction, 2)}</td>
            <td>${error === null || error === undefined ? "Bekliyor" : formatPercent(error, 2)}</td>
            <td>${escapeHtml(grade)}</td>
            <td><span class="status-pill ${statusClass}">${statusText}</span></td>
          </tr>
        `;
      }).join("")
    : `
      <tr>
        <td colspan="7">Performans kaydı yok.</td>
      </tr>
    `;

  box.innerHTML = `
    <div class="performance-grid">
      <div class="metric">
        <div class="metric-label">Normal Kapanış</div>
        <div class="metric-value up">${formatNumber(normalClosedRows, 0)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Şok Kapanış</div>
        <div class="metric-value yellow">${formatNumber(shockClosedRows, 0)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Güvenilir Toplam</div>
        <div class="metric-value up">${formatNumber(reliableCompletedRows, 0)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Karantina / Audit</div>
        <div class="metric-value yellow">${formatNumber(quarantinedRows, 0)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Genel Ortalama Sapma</div>
        <div class="metric-value">${avgError}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Yön İsabeti</div>
        <div class="metric-value up">${directionRate}</div>
      </div>
    </div>

    <div class="summary-line">
      <b>Shock UI Sync:</b>
      Dashboard artık <b>normal kapanış</b> ile <b>şok kapanış</b> kayıtlarını ayrı gösterir.
      PBR/PHE gibi büyük ama TEFAS fiyat zinciriyle tutarlı hareketler veri hatası olarak okunmaz; <b>shock_closed</b> kapsamında izlenir.
      <br />
      Güvenilir toplam: <b>${formatNumber(reliableTotalRows, 0)}</b>
      • Bekleyen tahmin: <b>${formatNumber(pendingRows, 0)}</b>
      • Karantina oranı: <b>${formatPercent(quarantineRate, 2)}</b>
      • Şok oranı: <b>${formatPercent(shockRate, 2)}</b>.
      ${latestDateAvgError ? `Son tamamlanan gün ortalaması: <b>${latestDateAvgError}</b>.` : ""}
      <br />
      <b>${escapeHtml(finalLabel)}</b>, sadece <b>${escapeHtml(apiVersion)}</b> içindeki finalPredictionChange alanından okunur.
      ${escapeHtml(deviationFormula)}.
    </div>

    ${fundLearningPanel}

    ${shockMovementPanel}

    <div class="summary-line">
      <b>Kapanmış Tahmin Performans Kayıtları</b>
    </div>

    <table class="perf-table">
      <thead>
        <tr>
          <th>Fon</th>
          <th>Tahmin Tarihi</th>
          <th>Gerçekleşen</th>
          <th>${escapeHtml(finalLabel)}</th>
          <th>Sapma</th>
          <th>Not</th>
          <th>Durum</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  `;
}

async function loadAll() {
  const lastUpdate = document.getElementById("lastUpdate");
  const cards = document.getElementById("cards");
  const ai = document.getElementById("aiAnalyst");
  const summary = document.getElementById("predictionSummary");
  const performance = document.getElementById("performanceBox");

  lastUpdate.textContent = "Yükleniyor...";
  cards.innerHTML = "";
  ai.innerHTML = "Tahmin motoru yükleniyor...";
  summary.innerHTML = "Tahmin verisi yükleniyor...";
  performance.innerHTML = "Performans verisi yükleniyor...";

  try {
    const marketPromise = fetchJson("/api/market");
    const fundsPromise = fetchJson("/api/funds");
    const predictionsPromise = fetchJson("/api/predictions");
    const performancePromise = fetchJson("/api/performance");

    const results = await Promise.allSettled([
      marketPromise,
      fundsPromise,
      predictionsPromise,
      performancePromise
    ]);

    const marketJson =
      results[0].status === "fulfilled"
        ? results[0].value
        : { assets: {} };

    const fundsJson =
      results[1].status === "fulfilled"
        ? results[1].value
        : { funds: {} };

    const predictionsJson =
      results[2].status === "fulfilled"
        ? results[2].value
        : { predictions: {} };

    const performanceJson =
      results[3].status === "fulfilled"
        ? results[3].value
        : { ok: false };

    renderMarketCards(marketJson, fundsJson, predictionsJson);
    renderPredictionSummary(predictionsJson);
    renderAiAnalyst(predictionsJson);
    renderPerformance(performanceJson);

    const now = new Date();
    lastUpdate.textContent = "Son güncelleme: " + now.toLocaleString("tr-TR");
  } catch (err) {
    cards.innerHTML = `
      <div class="card wide">
        <div class="error">Dashboard yüklenemedi: ${escapeHtml(err.message || err)}</div>
      </div>
    `;
    ai.innerHTML = `<span class="error">AI Analist yüklenemedi.</span>`;
    summary.innerHTML = `<span class="error">Tahmin özeti yüklenemedi.</span>`;
    performance.innerHTML = `<span class="error">Performans verisi yüklenemedi.</span>`;
    lastUpdate.textContent = "Hata oluştu";
  }
}

window.loadAll = loadAll;

loadAll();
setInterval(loadAll, 60000);
