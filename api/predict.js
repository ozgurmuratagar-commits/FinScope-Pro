const FUNDS = ["PBR", "PHE", "TLY", "THF"];
const MODEL = "v7_1_accuracy_layer";
const VERSION = "FinScope Predict API v10.7 - Direct Market Price Bridge";
const MODEL_VERSION = "FinScope Prediction Engine v10.7 - Direct Market Price Bridge";
const SOURCE = "causal_nav_direct_chart_v10_7";
const OFFICIAL_DATES = { PBR: "2026-07-31", PHE: "2026-08-07", TLY: "2026-08-07", THF: "2026-08-07" };

const MIN_RELIABLE_STOCK_COVERAGE = 60;
const FULL_STOCK_COVERAGE = 85;
const PRICE_TIMEOUT_MS = 4000;
const PRICE_CONCURRENCY = 12;

const num = (v, d = null) => {
  if (v === null || v === undefined || v === "") return d;
  const x = Number(String(v).replace(",", "."));
  return Number.isFinite(x) ? x : d;
};
const rnd = (v, d = 4) => {
  const x = num(v);
  if (x === null) return null;
  const p = 10 ** d;
  return Math.round((x + Number.EPSILON) * p) / p;
};
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const avg = (a) => { const x = a.filter(Number.isFinite); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0; };
const median = (a) => {
  const x = a.filter(Number.isFinite).sort((m, n) => m - n);
  if (!x.length) return 0;
  const i = Math.floor(x.length / 2);
  return x.length % 2 ? x[i] : (x[i - 1] + x[i]) / 2;
};
const first = (r, keys, d = null) => {
  for (const k of keys) if (r?.[k] !== undefined && r[k] !== null && r[k] !== "") return r[k];
  return d;
};
const code = (v) => String(v || "").trim().toUpperCase();
const sym = (v) => String(v || "").trim().toUpperCase()
  .replace(/İ/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G")
  .replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C")
  .replace(/[^A-Z0-9.\-]/g, "");

function todayTR() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
function nextWeekday(s) {
  const [y, m, d] = s.split("-").map(Number);
  const z = new Date(Date.UTC(y, m - 1, d, 12));
  do z.setUTCDate(z.getUTCDate() + 1); while ([0, 6].includes(z.getUTCDay()));
  return z.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  if (!a || !b) return null;
  const x = new Date(`${a}T00:00:00Z`), y = new Date(`${b}T00:00:00Z`);
  return Number.isFinite(x.getTime()) && Number.isFinite(y.getTime()) ? Math.round((y - x) / 86400000) : null;
}

function isStock(type, symbol, name) {
  const t = `${type || ""}`.toLowerCase();
  const nm = `${name || ""}`.toLowerCase();
  if (/(stock|hisse|equity|share)/.test(t)) return true;
  if (/(fund|fon|cash|nakit|repo|bond|fixed|borc|borç|lease|kira|deposit|mevduat|money|other)/.test(t)) return false;
  if (/(pusula|repo|kira sert)/.test(nm)) return false;
  return /^[A-Z0-9]{3,6}$/.test(sym(symbol));
}
function yahooSymbol(row) {
  const y = sym(first(row, ["yahoo_symbol", "yahooSymbol", "price_symbol", "market_symbol"]));
  if (y) return y;
  const s = sym(first(row, ["symbol", "ticker", "stock_code", "asset_code", "code"]));
  if (!s) return null;
  if (s.includes(".")) return s;
  return /^[A-Z0-9]{3,6}$/.test(s) ? `${s}.IS` : null;
}
function holding(row) {
  const fundCode = code(first(row, ["fund_code", "fundCode", "fund", "fundcode"]));
  const symbol = sym(first(row, ["symbol", "ticker", "stock_code", "asset_code", "code"]));
  const name = String(first(row, ["name", "asset_name", "security_name", "title"], symbol || "")).trim();
  const assetType = String(first(row, ["asset_type", "assetType", "type", "category", "asset_class"], "")).trim();
  const stock = isStock(assetType, symbol, name);
  return {
    fundCode, symbol, name, assetType, stock,
    yahooSymbol: stock ? yahooSymbol(row) : null,
    weight: Math.max(0, num(first(row, ["weight", "portfolio_weight", "percentage", "percent", "rate", "oran"]), 0)),
    reportDate: String(first(row, ["report_date", "reportDate", "holdings_date", "portfolio_date", "disclosure_date", "as_of_date", "date"], "")).slice(0, 10) || null,
  };
}

function sbConfig() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL veya Supabase anahtari eksik");
  return { url, key };
}
async function sb(path, options = {}) {
  const { url, key } = sbConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${path} HTTP ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

async function fetchJSON(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), PRICE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
      },
    });
    if (!r.ok) throw new Error(`HTTP_${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
function lastTwo(values, ts) {
  const a = [];
  for (let i = 0; i < Math.min(values.length, ts.length); i++) {
    const v = num(values[i]), t = num(ts[i]);
    if (v !== null && v > 0 && t !== null) a.push({ v, t });
  }
  return a.length >= 2 ? [a[a.length - 2], a[a.length - 1]] : null;
}
async function priceYahoo(symbol) {
  let lastErr = null;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const u = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d&includePrePost=false&events=div%2Csplits&includeAdjustedClose=true`;
      const j = await fetchJSON(u);
      const x = j?.chart?.result?.[0];
      if (!x) throw new Error(j?.chart?.error?.description || "empty_chart");
      const ts = x.timestamp || [];
      const adj = x?.indicators?.adjclose?.[0]?.adjclose || [];
      const raw = x?.indicators?.quote?.[0]?.close || [];
      const pair = lastTwo(adj, ts) || lastTwo(raw, ts);
      if (!pair) throw new Error("insufficient_chart_points");
      const [p, q] = pair;
      const change = ((q.v / p.v) - 1) * 100;
      if (!Number.isFinite(change)) throw new Error("invalid_change");
      return {
        ok: true, symbol,
        price: num(x.meta?.regularMarketPrice, q.v), previous: p.v,
        marketChange: rnd(change, 4),
        priceDate: new Date(q.t * 1000).toISOString().slice(0, 10),
        pricingSource: `Yahoo chart ${host}`,
      };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, symbol, marketChange: null, error: String(lastErr?.message || lastErr || "not_priced") };
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  async function run() {
    while (true) {
      const k = i++; if (k >= items.length) return;
      try { out[k] = await fn(items[k]); }
      catch (e) { out[k] = { ok: false, error: String(e?.message || e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function loadHoldings() {
  const raw = await sb("fund_holdings?select=*&limit=5000");
  const rows = (Array.isArray(raw) ? raw : []).map(holding).filter((r) => FUNDS.includes(r.fundCode) && r.weight > 0);
  const byFund = {}, info = {};
  for (const f of FUNDS) {
    const all = rows.filter((r) => r.fundCode === f);
    const dated = all.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.reportDate || ""));
    const anchored = dated.filter((r) => r.reportDate === OFFICIAL_DATES[f]);
    let chosen, selectedDate, rule;
    if (anchored.length) { chosen = anchored; selectedDate = OFFICIAL_DATES[f]; rule = "official_report_date_anchor"; }
    else if (dated.length) {
      selectedDate = dated.map((r) => r.reportDate).sort().at(-1);
      chosen = dated.filter((r) => r.reportDate === selectedDate); rule = "latest_available_report_date";
    } else { chosen = all; selectedDate = OFFICIAL_DATES[f] || null; rule = "undated_fallback"; }
    byFund[f] = chosen;
    info[f] = { officialReportDate: OFFICIAL_DATES[f], selectedReportDate: selectedDate, selectionRule: rule, rows: chosen.length };
  }
  return { byFund, info };
}
async function loadFundPrices() {
  const raw = await sb(`fund_prices?select=*&fund_code=in.(${FUNDS.join(",")})&order=price_date.desc&limit=400`);
  const byFund = {};
  for (const f of FUNDS) byFund[f] = (Array.isArray(raw) ? raw : []).filter((r) => code(r.fund_code) === f);
  return byFund;
}
async function loadPerformance() {
  try {
    const raw = await sb(`prediction_performance?select=*&model=eq.${MODEL}&fund_code=in.(${FUNDS.join(",")})&status=in.(closed,shock_closed)&order=prediction_date.desc&limit=160`);
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function fundStats(rows) {
  const r = (rows || []).slice(0, 15), changes = r.map((x) => num(x.daily_change)).filter(Number.isFinite);
  return {
    latestFundPrice: num(r[0]?.price), latestFundPriceDate: r[0]?.price_date || null,
    latestFundActualChange: num(r[0]?.daily_change), recentAverageFundChange: rnd(avg(changes), 4),
  };
}
function learning(rows, f) {
  const r = rows.filter((x) => code(x.fund_code) === f)
    .filter((x) => Number.isFinite(num(x.final_prediction_change)) && Number.isFinite(num(x.actual_change))).slice(0, 15);
  if (!r.length) return { sampleSize: 0, beta: 1, offset: 0, averageError: null, averageAbsoluteError: null, directionHitRate: null, status: "no_history" };
  const p = r.map((x) => num(x.final_prediction_change)), a = r.map((x) => num(x.actual_change));
  const err = a.map((v, i) => v - p[i]), abs = err.map(Math.abs);
  const ratios = a.map((v, i) => Math.abs(p[i]) >= 0.2 && Math.sign(v) === Math.sign(p[i]) ? Math.abs(v / p[i]) : null)
    .filter((v) => Number.isFinite(v) && v > 0 && v < 5);
  const beta = ratios.length >= 4 ? clamp(1 + (median(ratios) - 1) * 0.25, 0.8, 1.2) : 1;
  const hits = a.map((v, i) => Math.abs(v) >= 0.05 && Math.abs(p[i]) >= 0.05 ? (Math.sign(v) === Math.sign(p[i]) ? 1 : 0) : null).filter((v) => v !== null);
  return {
    sampleSize: r.length, beta: rnd(beta, 4), offset: rnd(clamp(median(err) * 0.12, -0.65, 0.65), 4),
    averageError: rnd(avg(err), 4), averageAbsoluteError: rnd(avg(abs), 4),
    directionHitRate: hits.length ? rnd(avg(hits) * 100, 2) : null, status: r.length >= 10 ? "active_15_day" : "warming_up",
  };
}
function nonStockProxy(type, name) {
  const t = `${type || ""} ${name || ""}`.toLowerCase();
  if (/(repo|money|para piyasa)/.test(t)) return 0.10;
  if (/(fixed|bond|borc|borç|lease|kira)/.test(t)) return 0.04;
  return 0;
}
function confidence(totalCoverage, stockCoverage, unresolvedWeight, freshDays) {
  let s = 10 + Math.min(55, totalCoverage * 0.55) + Math.min(25, stockCoverage * 0.25) - Math.min(25, unresolvedWeight * 0.35);
  if (Number.isFinite(freshDays) && freshDays > 45) s -= Math.min(20, (freshDays - 45) * 0.25);
  return clamp(s, 5, 95);
}
function confText(s) { return s >= 80 ? "Yüksek" : s >= 65 ? "İyi" : s >= 45 ? "Orta" : "Düşük"; }
function authorized(req) {
  if (String(req.query?.manual || "") === "finscope") return true;
  return Boolean(process.env.CRON_SECRET && String(req.headers?.authorization || "") === `Bearer ${process.env.CRON_SECRET}`);
}

async function savePredictions(predictions) {
  const now = new Date().toISOString();
  const payload = predictions.map((p) => ({
    fund_code: p.fundCode, prediction_date: p.predictionDate, model: MODEL,
    predicted_change: rnd(p.finalPredictionChange, 4), actual_change: null, error_change: null,
    confidence: rnd(p.confidence, 2), coverage: rnd(p.coverage, 2), residual_weight: rnd(p.unresolvedWeight, 2),
    source: SOURCE, created_at: now, updated_at: now, raw_predicted_change: rnd(p.rawPredictedChange, 4),
    calibrated_change: rnd(p.finalPredictionChange, 4), calibration_offset: rnd(p.calibrationOffset, 4),
    actual_price_date: null, sample_size: p.sampleSize || 0, model_version: MODEL_VERSION,
  }));
  const rows = await sb("prediction_history?on_conflict=fund_code,prediction_date,model", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(payload),
  });
  return { ok: true, saved: Array.isArray(rows) ? rows.length : payload.length, rows: rows || [] };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  try {
    if (!authorized(req)) return res.status(401).json({ ok: false, version: VERSION, error: "Yetkisiz istek. Manuel test icin ?manual=finscope kullanin." });

    const report = String(req.query?.report || "") === "1";
    const today = todayTR(), predictionDate = nextWeekday(today);
    const [{ byFund, info }, pricesByFund, perf] = await Promise.all([loadHoldings(), loadFundPrices(), loadPerformance()]);

    const symbols = [...new Set(FUNDS.flatMap((f) => (byFund[f] || []).filter((r) => r.stock && r.yahooSymbol).map((r) => r.yahooSymbol)))];
    const pxRows = await mapLimit(symbols, PRICE_CONCURRENCY, priceYahoo);
    const px = new Map(symbols.map((s, i) => [s, pxRows[i]]));
    const predictions = [];

    for (const f of FUNDS) {
      const rows = byFund[f] || [], learn = learning(perf, f), fs = fundStats(pricesByFund[f] || []);
      const stockRows = rows.filter((r) => r.stock), otherRows = rows.filter((r) => !r.stock);
      const totalWeight = rows.reduce((s, r) => s + r.weight, 0), stockWeight = stockRows.reduce((s, r) => s + r.weight, 0);
      const nonStockWeight = otherRows.reduce((s, r) => s + r.weight, 0);
      let pricedWeight = 0, stockObserved = 0; const pricedRows = [], unresolvedRows = [];

      for (const r of stockRows) {
        const q = r.yahooSymbol ? px.get(r.yahooSymbol) : null;
        if (q?.ok && Number.isFinite(num(q.marketChange))) {
          const contribution = (r.weight / 100) * q.marketChange;
          pricedWeight += r.weight; stockObserved += contribution;
          pricedRows.push({ symbol: r.symbol, yahooSymbol: r.yahooSymbol, name: r.name, weight: rnd(r.weight), marketChange: q.marketChange, contribution: rnd(contribution), price: rnd(q.price, 6), previous: rnd(q.previous, 6), priceDate: q.priceDate, pricingSource: q.pricingSource });
        } else unresolvedRows.push({ symbol: r.symbol, yahooSymbol: r.yahooSymbol, name: r.name, weight: rnd(r.weight), issue: r.yahooSymbol ? (q?.error || "not_priced") : "missing_yahoo_symbol" });
      }

      const stockCoverage = stockWeight > 0 ? pricedWeight / stockWeight * 100 : 100;
      const coverage = totalWeight > 0 ? pricedWeight / totalWeight * 100 : 0;
      const unresolvedWeight = Math.max(0, stockWeight - pricedWeight);
      let stockContribution = stockObserved, coverageExpansion = 1;
      if (stockCoverage >= 70 && pricedWeight > 0 && stockWeight > pricedWeight) {
        coverageExpansion = stockWeight / pricedWeight; stockContribution *= coverageExpansion;
      }
      const otherDetails = otherRows.map((r) => {
        const proxy = nonStockProxy(r.assetType, r.name), contribution = r.weight / 100 * proxy;
        return { symbol: r.symbol, name: r.name, assetType: r.assetType, weight: rnd(r.weight), proxyChange: rnd(proxy), contribution: rnd(contribution) };
      });
      const nonStockContribution = otherDetails.reduce((s, r) => s + (r.contribution || 0), 0);
      const raw = stockContribution + nonStockContribution;
      let final = raw * learn.beta + learn.offset;
      const reliable = !(stockWeight >= 20 && stockCoverage < MIN_RELIABLE_STOCK_COVERAGE);
      if (!reliable) final = clamp(final, -1.25, 1.25);
      const rawCap = Math.max(2.5, Math.abs(raw) * 1.35 + 1.25);
      final = clamp(final, -Math.min(35, rawCap), Math.min(35, rawCap));

      const freshDays = daysBetween(info[f]?.selectedReportDate, today);
      let conf = confidence(coverage, stockCoverage, unresolvedWeight, freshDays);
      if (!reliable) conf = Math.min(conf, 35);
      const histBand = Number.isFinite(learn.averageAbsoluteError) ? Math.min(3.5, learn.averageAbsoluteError * 0.35) : 0.75;
      const band = clamp(0.45 + (100 - coverage) * 0.02 + histBand, 0.5, 5);
      const issues = [];
      if (freshDays !== null && freshDays > 45) issues.push("holdings_watch");
      if (stockCoverage < FULL_STOCK_COVERAGE) issues.push("partial_stock_price_coverage");
      if (stockCoverage < MIN_RELIABLE_STOCK_COVERAGE) issues.push("low_stock_price_coverage");
      if (unresolvedRows.length) issues.push("unpriced_holdings");

      predictions.push({
        fundCode: f, code: f, fund: f, predictionDate, model: MODEL, modelKey: MODEL, modelVersion: MODEL_VERSION,
        source: SOURCE, engine: "direct_market_price_bridge",
        officialHoldingsReportDate: OFFICIAL_DATES[f], holdingsReportDate: info[f]?.selectedReportDate || null,
        holdingsSelectionRule: info[f]?.selectionRule || null, holdingsFreshnessDays: freshDays,
        totalHoldingsRows: rows.length, totalWeight: rnd(totalWeight), stockWeight: rnd(stockWeight), nonStockWeight: rnd(nonStockWeight),
        pricedWeight: rnd(pricedWeight), coverage: rnd(coverage, 2), stockCoverage: rnd(stockCoverage, 2), unresolvedWeight: rnd(unresolvedWeight),
        coverageExpansion: rnd(coverageExpansion), stockContributionObserved: rnd(stockObserved), stockContribution: rnd(stockContribution), nonStockContribution: rnd(nonStockContribution),
        rawPredictedChange: rnd(raw), predictedChange: rnd(final), calibratedChange: rnd(final), finalPredictionChange: rnd(final), currentPredictionChange: rnd(final),
        predictionDirection: final > 0.05 ? "up" : final < -0.05 ? "down" : "flat", predictionValid: reliable,
        reliabilityGate: reliable ? "open" : "low_coverage_hold", rangeLow: rnd(final - band), rangeHigh: rnd(final + band), expectedErrorBand: rnd(band),
        confidence: rnd(conf, 2), confidenceText: confText(conf), latestFundPrice: fs.latestFundPrice, latestFundPriceDate: fs.latestFundPriceDate,
        latestFundActualChange: fs.latestFundActualChange, recentAverageFundChange: fs.recentAverageFundChange,
        beta: learn.beta, calibrationOffset: learn.offset, learningSampleSize: learn.sampleSize, sampleSize: learn.sampleSize,
        learningStatus: learn.status, performanceAverageError: learn.averageError, performanceAverageAbsoluteError: learn.averageAbsoluteError,
        performanceDirectionHitRate: learn.directionHitRate, issues,
        pricingDiagnostics: { requestedStockRows: stockRows.length, pricedStockRows: pricedRows.length, unresolvedStockRows: unresolvedRows.length, pricedStockWeight: rnd(pricedWeight), stockWeight: rnd(stockWeight), stockCoverage: rnd(stockCoverage, 2), totalFundCoverage: rnd(coverage, 2), method: "Yahoo chart v8 direct per symbol; adjusted close preferred; query1->query2 fallback" },
        topPositiveContributors: [...pricedRows].filter((r) => r.contribution > 0).sort((a, b) => b.contribution - a.contribution).slice(0, 8),
        topNegativeContributors: [...pricedRows].filter((r) => r.contribution < 0).sort((a, b) => a.contribution - b.contribution).slice(0, 8),
        pricedRows: report ? pricedRows : undefined, unresolvedRows: report ? unresolvedRows : unresolvedRows.slice(0, 10), nonStockTopRows: report ? otherDetails : otherDetails.slice(0, 10),
      });
    }

    const saveResult = await savePredictions(predictions);
    return res.status(200).json({
      ok: true, generatedAt: new Date().toISOString(), version: VERSION, mode: "direct_market_price_bridge", endpoint: "/api/predict",
      model: MODEL, modelKey: MODEL, modelVersion: MODEL_VERSION, fundOrder: FUNDS, officialHoldingsReportDates: OFFICIAL_DATES, targetDate: predictionDate,
      pricingRule: "Katki = portfoy agirligi/100 x Yahoo chart gunluk fiyat degisimi. Adjusted close tercih edilir; gecmis performans sadece sinirli kalibrasyondur.",
      reliabilityRule: `Stock coverage %${MIN_RELIABLE_STOCK_COVERAGE} altindaysa agresif tahmin engellenir.`,
      summary: {
        totalFunds: predictions.length, saved: saveResult.saved, predictionDate, pricingSymbolsRequested: symbols.length,
        pricingSymbolsOK: [...px.values()].filter((x) => x?.ok).length, pricingSymbolsFailed: [...px.values()].filter((x) => !x?.ok).length,
        averageCoverage: rnd(avg(predictions.map((p) => p.coverage)), 2), averageStockCoverage: rnd(avg(predictions.map((p) => p.stockCoverage)), 2),
        averageConfidence: rnd(avg(predictions.map((p) => p.confidence)), 2), reliableFunds: predictions.filter((p) => p.predictionValid).map((p) => p.fundCode), heldFunds: predictions.filter((p) => !p.predictionValid).map((p) => p.fundCode),
      },
      predictions, saveResult: report ? saveResult : { ok: true, saved: saveResult.saved },
      disclaimer: "Bu tahminler model bazlidir, kesinlik icermez ve yatirim tavsiyesi degildir.",
    });
  } catch (e) {
    console.error("predict v10.7 error", e);
    return res.status(500).json({ ok: false, generatedAt: new Date().toISOString(), version: VERSION, model: MODEL, modelVersion: MODEL_VERSION, error: String(e?.message || e) });
  }
};
