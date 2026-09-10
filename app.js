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

const FRONTEND_VERSION = "Read-Only Frontend v8.9.4";
const DISPLAY_MODEL_NAME = "FinScope Prediction Engine v8.9.4 - Performance UI Sync";
const DISPLAY_MODEL_SHORT = "v8.9.4";

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
      prediction.finalPredictionChange,
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
  const model =
    predictionsJson && predictionsJson.model
      ? String(predictionsJson.model)
      : "";

  if (
    model.includes("v8.9") ||
    model.includes("v8.8") ||
    model.includes("v8.7") ||
    model.includes("v8.6") ||
    model.includes("v8.5") ||
    model.includes("v8.4") ||
    model.includes("v8.3") ||
    model.includes("v8.2")
  ) {
    return model;
  }

  /*
    MODEL_KEY veritabanı uyumluluğu için v7_1_accuracy_layer kalabilir.
    Kullanıcıya gösterilen aktif frontend entegrasyon adı v8.9.4 olmalıdır.
  */
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
      ${escapeHtml(FRONTEND_VERSION)}: Tahmin Özeti PBR / PHE / TLY / THF sırasını kullanır; performans metrikleri artık karantina farkındalıklı okunur ve sayfa açılışında /api/predict çalıştırılmaz.
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
      <b>${escapeHtml(model)}</b> aktif. Bu panel artık sadece kayıtlı tahminleri okur; tahmin motorunu yeniden tetiklemez.
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
      ${escapeHtml(FRONTEND_VERSION)} - Performance UI Sync ile dashboard açılışı veri üretmez; sadece /api/market, /api/funds, /api/predictions ve karantina farkındalıklı /api/performance okur.
    </div>
  `;
}

function performanceGrade(errorAbs) {
  const e = Math.abs(num(errorAbs, 0));
  if (e <= 0.25) return "Çok iyi";
  if (e <= 0.50) return "İyi";
  if (e <= 0.85) return "Makul";
  if (e <= 1.25) return "Zayıf";
  return "Çok zayıf";
}

function isCompletedPerformanceStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "completed" || s === "closed";
}

function isQuarantinedPerformanceStatus(status) {
  return String(status || "").toLowerCase() === "quarantined";
}

function performanceStatusText(status) {
  if (isCompletedPerformanceStatus(status)) return "Tamamlandı";
  if (isQuarantinedPerformanceStatus(status)) return "Karantina";
  return "Bekliyor";
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

function learningStatusFromMetrics(completedRows, avgAbsError, directionHitRate) {
  const completed = Number(completedRows || 0);
  const absError = num(avgAbsError, null);
  const directionRate = num(directionHitRate, null);

  if (completed === 0) return "Henüz kapanmış veri yok";
  if (completed < 5) return "Örnek sayısı düşük";

  if (absError !== null && absError <= 0.35 && directionRate !== null && directionRate >= 70) {
    return "İyi çalışıyor";
  }

  if (absError !== null && absError <= 0.65 && directionRate !== null && directionRate >= 70) {
    return "Öğreniyor / kullanılabilir";
  }

  if (absError !== null && absError <= 0.90 && directionRate !== null && directionRate >= 60) {
    return "Takip ediliyor";
  }

  if (directionRate !== null && directionRate < 50) {
    return "Yön tahmini zayıf";
  }

  if (absError !== null && absError > 1.25) {
    return "Model yaklaşımı gözden geçirilmeli";
  }

  return "Geliştiriliyor";
}

function buildFundLearningPanel(performanceJson, performanceRows) {
  const summary = performanceJson.summary || {};
  const byFund = summary.byFund || performanceJson.byFund || {};
  const learningStats = performanceJson.learningStats || {};

  function trendLabel(completedRows, averageAbsError, averageError) {
    const completed = Number(completedRows || 0);
    const absError = num(averageAbsError, null);
    const avgError = num(averageError, null);
    const prefix = completed < 5 ? "Erken sinyal: " : "";

    if (avgError === null) return `${prefix}veri yok`;

    if (absError !== null && absError >= 0.85 && Math.abs(avgError) <= 0.25) {
      return `${prefix}hata yönü kararsız`;
    }

    if (avgError > 0.15) return `${prefix}tahmin düşük kalıyor`;
    if (avgError < -0.15) return `${prefix}tahmin yüksek kalıyor`;

    return `${prefix}dengeli`;
  }

  function readableStatus(completedRows, averageAbsError, directionHitRate) {
    const completed = Number(completedRows || 0);
    const absError = num(averageAbsError, null);
    const hitRate = num(directionHitRate, null);

    if (completed === 0) return "Kapanmış veri yok";
    if (completed < 5) return "Örnek sayısı düşük — karar için erken";

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

    const stat = byFund[code] || {};
    const learning = stat.learning || learningStats[code] || {};

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

    const trend = trendLabel(completedRows, averageAbsError, averageError);
    const status = readableStatus(completedRows, averageAbsError, directionHitRate);

    const avgErrorClass = directionClass(averageError);
    const offsetClass = directionClass(suggestedOffset);

    return `
      <tr>
        <td><b>${escapeHtml(code)}</b></td>
        <td>${formatNumber(completedRows, 0)}</td>
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
      <b>Fon Bazlı Öğrenme ve Sapma</b><br />
      Bu bölümde her fon ayrı değerlendirilir. Ortalama değerler yalnızca güvenilir closed kayıtlarla hesaplanır; karantina kayıtları ayrı sayılır.
      <br />
      <b>Ortalama Mutlak Sapma</b>: |Gerçekleşen - Nihai Tahmin| ortalamasıdır; tahminin büyüklük hatasını gösterir.
      <br />
      <b>Ortalama Yönlü Hata</b>: Gerçekleşen - Nihai Tahmin ortalamasıdır. Pozitifse tahmin düşük kalmış, negatifse tahmin yüksek kalmıştır.
      <br />
      <b>Tahmin Düzeltmesi</b>: gelecek tahmine eklenmesi veya tahminden düşülmesi önerilen temkinli düzeltmedir.
      <br />
      <b>Güven Etkisi</b>: modelin bu fondaki güven skoruna yapılan artırma/azaltma etkisidir; pozitif güveni artırır, negatif güveni düşürür.
    </div>

    <table class="perf-table">
      <thead>
        <tr>
          <th>Fon</th>
          <th>Güvenilir Kapanan</th>
          <th>Karantina</th>
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

function renderPerformance(performanceJson) {
  const box = document.getElementById("performanceBox");

  if (!performanceJson || !performanceJson.ok) {
    box.innerHTML = `<span class="error">Performans verisi alınamadı.</span>`;
    return;
  }

  const summary = performanceJson.summary || {};
  const performanceRows = getLatestPerformanceRows(performanceJson);

  const rawCounts = performanceJson.rawCounts || {};

  const reliableCompletedRows = firstNumber(
    [
      summary.reliableCompletedRows,
      summary.completedRows,
      rawCounts.reliablePerformanceRows
    ],
    performanceRows.filter(function(row) {
      return row && isCompletedPerformanceStatus(row.status) && !isQuarantinedPerformanceStatus(row.status);
    }).length
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
        const statusClass = isCompletedPerformanceStatus(status) ? "status-completed" : "";
        const grade =
          error === null || error === undefined
            ? "Bekliyor"
            : (perf.grade || performanceGrade(error));

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
        <div class="metric-label">Güvenilir Kapanmış Kayıt</div>
        <div class="metric-value up">${formatNumber(reliableCompletedRows, 0)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Karantina</div>
        <div class="metric-value yellow">${formatNumber(quarantinedRows, 0)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Ham Toplam</div>
        <div class="metric-value">${formatNumber(rawTotalRows, 0)}</div>
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
      <b>Karantina farkındalıklı performans:</b>
      Genel ortalama sapma ve yön isabeti yalnızca güvenilir closed kayıtlarla hesaplanır.
      Karantina kayıtları genel ortalamaya dahil edilmez.
      <br />
      Güvenilir toplam: <b>${formatNumber(reliableTotalRows, 0)}</b>
      • Bekleyen tahmin: <b>${formatNumber(pendingRows, 0)}</b>
      • Karantina oranı: <b>${formatPercent(quarantineRate, 2)}</b>.
      ${latestDateAvgError ? `Son tamamlanan gün ortalaması: <b>${latestDateAvgError}</b>.` : ""}
      <br />
      <b>${escapeHtml(finalLabel)}</b>, sadece <b>${escapeHtml(apiVersion)}</b> içindeki finalPredictionChange alanından okunur.
      ${escapeHtml(deviationFormula)}.
    </div>

    ${fundLearningPanel}

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
