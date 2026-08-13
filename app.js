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

const FUND_ORDER = ["PBR", "PHE", "TLY"];

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

function getModelLabel(predictionsJson) {
  return predictionsJson && predictionsJson.model
    ? predictionsJson.model
    : "FinScope Prediction Engine v7.1 - Accuracy Layer";
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

  FUND_ORDER.forEach(function(code) {
    const fund = fundData[code] || {};
    const pred = predictions[code] || {};

    const fundChange = fund.dailyChange ?? fund.daily_change;
    const predChange = pred.predictedChange;
    const cls = directionClass(fundChange);
    const predCls = directionClass(predChange);

    html.push(`
      <div class="card">
        <h3>${escapeHtml(code)}</h3>
        <div class="value">${formatNumber(fund.price, 4)}</div>
        <div class="${cls}">${directionIcon(fundChange)} ${formatPercent(fundChange, 2)}</div>
        <div class="${predCls}">Tahmin: ${directionIcon(predChange)} ${formatPercent(predChange, 2)}</div>
        <div class="small">Kapsam: %${formatNumber(pred.coverage, 2)} • Güven: ${escapeHtml(pred.confidenceText || "—")}</div>
        <div class="small">Yumuşatma etkisi: ${formatPercent(pred.smoothingImpact || 0, 2)}</div>
        <div class="small">Sapma düzeltmesi: ${formatPercent(pred.calibrationOffset || 0, 2)}</div>
        <div class="small">Accuracy damping: ${formatNumber(pred.accuracyDamping || 1, 4)}</div>
        <div class="small">TEFAS v2 • ${escapeHtml(fund.date || fund.priceDate || fund.price_date || "tarih yok")}</div>
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

  FUND_ORDER.forEach(function(code) {
    const p = predictions[code];
    if (!p) return;

    const pred = p.predictedChange;
    const raw = p.rawPredictedChange;
    const unsmoothed = p.unsmoothedChange;
    const smoothingImpact = p.smoothingImpact || 0;
    const offset = p.calibrationOffset || 0;
    const damping = p.accuracyDamping || 1;
    const cls = directionClass(pred);

    const learningStatus =
      (p.accuracyLayer && p.accuracyLayer.status) ||
      (p.calibration && p.calibration.status) ||
      "no_history";

    lines.push(`
      <div class="summary-line">
        <b>${escapeHtml(code)}</b>:
        <span class="${cls}">${directionIcon(pred)} v7.1 Tahmin ${formatPercent(pred, 2)}</span>
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
      Dashboard artık read-only çalışır. Tahmin Özeti, /api/predictions içindeki son kayıtlı tahminlerden okunur; sayfa açılışında /api/predict çalıştırılmaz.
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
    return {
      code,
      pred: num(p.predictedChange, 0),
      smoothingImpact: num(p.smoothingImpact, 0),
      offset: num(p.calibrationOffset, 0),
      damping: num(p.accuracyDamping, 1)
    };
  });

  const best = rows.slice().sort(function(a, b) { return b.pred - a.pred; })[0];
  const worst = rows.slice().sort(function(a, b) { return a.pred - b.pred; })[0];

  const avgSmoothing =
    rows.reduce(function(sum, row) {
      return sum + Math.abs(row.smoothingImpact || 0);
    }, 0) / Math.max(1, rows.length);

  const avgOffset =
    rows.reduce(function(sum, row) {
      return sum + Math.abs(row.offset || 0);
    }, 0) / Math.max(1, rows.length);

  box.innerHTML = `
    <div class="summary-line">
      <b>${escapeHtml(model)}</b> aktif. Bu panel artık sadece kayıtlı tahminleri okur; tahmin motorunu yeniden tetiklemez.
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
      Read-Only Frontend v8.3 ile dashboard açılışı veri üretmez; sadece /api/market, /api/funds, /api/predictions ve /api/performance okur.
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

  if (absError !== null && absError > 0.85) {
    return "Model yaklaşımı gözden geçirilmeli";
  }

  if (directionRate !== null && directionRate < 50) {
    return "Yön tahmini zayıf";
  }

  return "İzlenmeli";
}

function buildFundLearningPanel(performanceJson, performanceRows) {
  const summary = performanceJson.summary || {};
  const byFund = summary.byFund || performanceJson.byFund || {};
  const learningStats = performanceJson.learningStats || {};

  const rows = FUND_ORDER.map(function(code) {
    const fundRows = performanceRows.filter(function(row) {
      return row && row.fundCode === code && row.status === "completed";
    });

    const stat = byFund[code] || {};
    const learning = stat.learning || learningStats[code] || {};

    const completedRows = firstNumber(
      [
        stat.completedRows,
        learning.completedPredictionCount,
        learning.sampleSize
      ],
      fundRows.length
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

    const biasLabel =
      learning.biasLabel ||
      stat.biasLabel ||
      biasLabelFromAverageError(averageError);

    const learningStatus =
      learning.learningStatus ||
      stat.learningStatus ||
      learningStatusFromMetrics(completedRows, averageAbsError, directionHitRate);

    const avgErrorClass = directionClass(averageError);
    const offsetClass = directionClass(suggestedOffset);

    const confidenceText =
      confidenceAdjustment === null
        ? ""
        : `<br /><span class="small">Güven ayarı: ${formatNumber(confidenceAdjustment, 2)}</span>`;

    return `
      <tr>
        <td><b>${escapeHtml(code)}</b></td>
        <td>${formatNumber(completedRows, 0)}</td>
        <td><b>${formatPercent(averageAbsError, 2)}</b></td>
        <td>${formatPercent(directionHitRate, 2)}</td>
        <td class="${avgErrorClass}">${averageError === null ? "—" : formatPercent(averageError, 2)}</td>
        <td>${escapeHtml(biasLabel)}</td>
        <td class="${offsetClass}">
          ${suggestedOffset === null ? "—" : formatPercent(suggestedOffset, 2)}
          ${confidenceText}
        </td>
        <td>${escapeHtml(learningStatus)}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="summary-line">
      <b>Fon Bazlı Öğrenme ve Sapma</b><br />
      Genel ortalama sadece sistemin genel sağlık göstergesidir. Asıl karar metrikleri fon bazında izlenir:
      her fonun ortalama sapması, yön isabeti, bias durumu ve önerilen düzeltmesi ayrı değerlendirilir.
    </div>

    <table class="perf-table">
      <thead>
        <tr>
          <th>Fon</th>
          <th>Kapanan</th>
          <th>Fon Ortalama Sapma</th>
          <th>Yön İsabeti</th>
          <th>Ortalama Hata</th>
          <th>Bias</th>
          <th>Önerilen Düzeltme</th>
          <th>Öğrenme Durumu</th>
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

  const totalRows = summary.totalRows ?? performanceRows.length;
  const pendingRows =
    summary.pendingRows ??
    performanceRows.filter(function(row) {
      return row && row.status !== "completed";
    }).length;

  const completedRows =
    summary.completedRows ??
    performanceRows.filter(function(row) {
      return row && row.status === "completed";
    }).length;

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

        const statusText = status === "completed" ? "Tamamlandı" : "Bekliyor";
        const statusClass = status === "completed" ? "status-completed" : "";
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
        <div class="metric-label">Toplam Kayıt</div>
        <div class="metric-value">${formatNumber(totalRows, 0)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Bekleyen Tahmin</div>
        <div class="metric-value yellow">${formatNumber(pendingRows, 0)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Tamamlanan Tahmin</div>
        <div class="metric-value up">${formatNumber(completedRows, 0)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Genel Ortalama Sapma</div>
        <div class="metric-value">${avgError}</div>
      </div>
    </div>

    <div class="summary-line">
      Genel yön isabet oranı: <b>${directionRate}</b>.
      Genel ortalama sapma, tüm fonların toplam performansını gösterir; fon bazlı karar için aşağıdaki öğrenme tablosu kullanılmalıdır.
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
