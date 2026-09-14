// api/predict.js
// FinScope Predict API v10.1 - Embedded Causal NAV Report
// Yeni API dosyasi eklemez. Causal NAV raporu mevcut /api/predict icinde report=1 ile calisir.

const API_VERSION = 'FinScope Predict API v10.1 - Embedded Causal NAV Report';
const MODEL_KEY = 'v7_1_accuracy_layer';
const MODEL_NAME = 'FinScope Prediction Engine v10.1 - Causal NAV Prediction Engine';
const FUND_ORDER = ['PBR', 'PHE', 'TLY', 'THF'];

const CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0'
};

function json(res, status, data) {
  res.statusCode = status;
  Object.entries(CACHE_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function getConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key };
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function isAuthorized(req, query) {
  const manual = String(query.manual || '').toLowerCase() === 'finscope';
  const auth = req.headers.authorization || '';
  const cronSecret = process.env.CRON_SECRET;
  const cron = Boolean(cronSecret && auth === `Bearer ${cronSecret}`);
  return manual || cron;
}

function parseQuery(req) {
  const u = new URL(req.url, getBaseUrl(req));
  return Object.fromEntries(u.searchParams.entries());
}

function trToday() {
  const now = new Date();
  const tr = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return tr.toISOString().slice(0, 10);
}

function toNum(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  let s = String(value).trim();
  if (!s) return fallback;
  s = s.replace(/%/g, '').replace(/\s+/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = toNum(value);
  if (n === null) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function clamp(value, min, max) {
  const n = toNum(value, 0);
  return Math.max(min, Math.min(max, n));
}

function direction(value) {
  const n = toNum(value, 0);
  if (n > 0.03) return 'up';
  if (n < -0.03) return 'down';
  return 'flat';
}

function pick(row, keys, fallback = null) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return fallback;
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

async function supabaseFetch(path, options = {}) {
  const { url, key } = getConfig();
  if (!url || !key) throw new Error('Supabase environment variables missing');
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/${path}`;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const r = await fetch(endpoint, { ...options, headers });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!r.ok) {
    const err = new Error(`Supabase ${options.method || 'GET'} ${path} HTTP ${r.status}: ${text}`);
    err.status = r.status;
    err.data = data;
    err.body = text;
    throw err;
  }
  return data;
}

async function getFundPrices() {
  const select = 'fund_code,price_date,price,daily_change,created_at';
  const path = `fund_prices?select=${select}&fund_code=in.(${FUND_ORDER.join(',')})&order=fund_code.asc,price_date.desc&limit=500`;
  try {
    return await supabaseFetch(path);
  } catch (error) {
    return [];
  }
}

async function getFundHoldings() {
  const path = `fund_holdings?select=*&fund_code=in.(${FUND_ORDER.join(',')})&limit=5000`;
  try {
    return await supabaseFetch(path);
  } catch (error) {
    return [];
  }
}

async function getLearningStats() {
  try {
    return await supabaseFetch(`model_learning_stats?select=*&model=eq.${MODEL_KEY}&limit=100`);
  } catch (error) {
    return [];
  }
}

function latestPricesByFund(priceRows) {
  const grouped = {};
  for (const code of FUND_ORDER) grouped[code] = [];
  for (const row of priceRows || []) {
    const code = String(row.fund_code || row.fundCode || '').toUpperCase();
    if (!grouped[code]) grouped[code] = [];
    grouped[code].push(row);
  }
  for (const code of Object.keys(grouped)) {
    grouped[code].sort((a, b) => String(b.price_date || '').localeCompare(String(a.price_date || '')));
  }
  return grouped;
}

function getLatestHoldingDate(rows) {
  const dates = rows
    .map(r => pick(r, ['report_date', 'reportDate', 'holding_date', 'holdingDate', 'price_date', 'date', 'created_at']))
    .filter(Boolean)
    .map(String)
    .sort();
  return dates.length ? dates[dates.length - 1].slice(0, 10) : null;
}

function rawWeight(row) {
  return toNum(pick(row, [
    'effective_weight',
    'effectiveWeight',
    'weight_percent',
    'weightPercent',
    'portfolio_weight',
    'portfolioWeight',
    'ratio',
    'percent',
    'weight',
    'oran',
    'pay'
  ]), 0);
}

function cleanSymbol(value) {
  if (!value) return null;
  let s = String(value).trim().toUpperCase();
  s = s.replace(/^BIST[:\s-]*/i, '');
  s = s.replace(/^IST[:\s-]*/i, '');
  s = s.replace(/\.E$/i, '');
  s = s.replace(/[^A-Z0-9._-]/g, '');
  if (!s || s === '-' || s === 'NULL') return null;
  return s;
}

function detectAssetType(row, symbol) {
  const t = String(pick(row, ['asset_type', 'assetType', 'type', 'category', 'varlik_turu', 'tur'], '')).toLowerCase();
  const name = String(pick(row, ['name', 'asset_name', 'assetName', 'title', 'unvan'], '')).toLowerCase();
  if (t.includes('stock') || t.includes('hisse') || t.includes('equity')) return 'stock';
  if (t.includes('fund') || t.includes('fon')) return 'fund';
  if (t.includes('bond') || t.includes('tahvil') || t.includes('bono') || t.includes('repo')) return 'fixed_income';
  if (t.includes('cash') || t.includes('nakit') || t.includes('para')) return 'cash';
  if (name.includes('tahvil') || name.includes('bono') || name.includes('repo')) return 'fixed_income';
  if (name.includes('nakit') || name.includes('mevduat')) return 'cash';
  const s = cleanSymbol(symbol);
  if (s && /^[A-Z]{3,6}$/.test(s) && !['TRY', 'USD', 'EUR', 'GBP', 'ALTIN', 'GOLD'].includes(s)) return 'stock';
  return 'other';
}

function yahooSymbolFor(row) {
  const raw = cleanSymbol(pick(row, ['symbol', 'ticker', 'code', 'asset_code', 'assetCode', 'normalized_symbol', 'normalizedSymbol']));
  if (!raw) return null;
  const assetType = detectAssetType(row, raw);
  if (assetType !== 'stock') return null;
  if (raw.includes('.')) return raw;
  return `${raw}.IS`;
}

function normalizeHoldings(allRows, fundCode) {
  const fundRows = (allRows || []).filter(r => String(r.fund_code || r.fundCode || '').toUpperCase() === fundCode);
  if (!fundRows.length) return { reportDate: null, rows: [], warnings: ['holding_not_found'] };

  const latestDate = getLatestHoldingDate(fundRows);
  let scoped = fundRows;
  if (latestDate) {
    scoped = fundRows.filter(r => {
      const d = pick(r, ['report_date', 'reportDate', 'holding_date', 'holdingDate', 'price_date', 'date', 'created_at']);
      return d && String(d).slice(0, 10) === latestDate;
    });
    if (!scoped.length) scoped = fundRows;
  }

  const rawRows = scoped.map(row => {
    const originalSymbol = cleanSymbol(pick(row, ['symbol', 'ticker', 'code', 'asset_code', 'assetCode', 'normalized_symbol', 'normalizedSymbol']));
    const name = pick(row, ['name', 'asset_name', 'assetName', 'title', 'unvan'], originalSymbol || 'Bilinmeyen');
    const rw = rawWeight(row);
    const assetType = detectAssetType(row, originalSymbol);
    const yahooSymbol = yahooSymbolFor(row);
    return { original: row, fundCode, originalSymbol, yahooSymbol, name, assetType, rawWeight: rw };
  }).filter(x => x.rawWeight > 0);

  const rawTotal = rawRows.reduce((sum, r) => sum + r.rawWeight, 0);
  const scale = rawTotal > 0 && rawTotal <= 1.5 ? 100 : 1;
  const percentRows = rawRows.map(r => ({ ...r, weightPercent: r.rawWeight * scale }));
  const totalPercent = percentRows.reduce((sum, r) => sum + r.weightPercent, 0);
  const normalizedRows = percentRows.map(r => ({
    ...r,
    effectiveWeight: totalPercent > 0 ? (r.weightPercent / totalPercent) * 100 : 0
  }));

  return {
    reportDate: latestDate,
    rows: normalizedRows,
    warnings: totalPercent ? [] : ['holding_weight_missing']
  };
}

async function fetchYahooChange(symbol) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 FinScope/10.1',
        Accept: 'application/json'
      }
    });
    if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
    const data = await r.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
    const closes = (quote && quote.close ? quote.close : []).filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0);
    if (closes.length < 2) throw new Error('not_enough_prices');
    const price = closes[closes.length - 1];
    const previous = closes[closes.length - 2];
    const change = ((price - previous) / previous) * 100;
    return {
      symbol,
      ok: true,
      price: round(price, 4),
      previous: round(previous, 4),
      marketChange: round(change, 4),
      pricingSource: 'Yahoo Finance chart'
    };
  } catch (error) {
    return {
      symbol,
      ok: false,
      price: null,
      previous: null,
      marketChange: null,
      pricingSource: 'unpriced',
      error: error && error.message ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function buildQuoteMap(holdingsByFund) {
  const symbols = unique(
    Object.values(holdingsByFund)
      .flatMap(v => v.rows || [])
      .map(r => r.yahooSymbol)
  );
  const quotes = await mapLimit(symbols, 6, fetchYahooChange);
  const map = {};
  for (const q of quotes) map[q.symbol] = q;
  return map;
}

function learningForFund(statsRows, fundCode) {
  const row = (statsRows || []).find(r => String(r.fund_code || r.fundCode || '').toUpperCase() === fundCode) || null;
  if (!row) return { row: null, offset: 0, confidenceAdjustment: 0, status: 'no_learning' };
  const rawOffset = toNum(pick(row, ['suggested_offset', 'suggestedOffset', 'average_error', 'averageError'], 0), 0);
  const offset = Math.abs(rawOffset) <= 3 ? rawOffset : 0;
  const adj = toNum(pick(row, ['confidence_adjustment', 'confidenceAdjustment'], 0), 0);
  return {
    row,
    offset: round(offset, 4),
    confidenceAdjustment: round(adj, 4),
    status: pick(row, ['learning_status', 'learningStatus', 'bias_label', 'biasLabel'], 'learning')
  };
}

function getConfidence(coverage, pricedRows, totalRows, learning) {
  const cov = toNum(coverage, 0);
  const breadth = totalRows > 0 ? (pricedRows / totalRows) * 100 : 0;
  const base = cov * 0.65 + breadth * 0.25 + 10;
  const adjusted = base + toNum(learning.confidenceAdjustment, 0);
  return Math.round(clamp(adjusted, 25, 95));
}

function getPredictionGrade(absError) {
  const e = Math.abs(toNum(absError, 999));
  if (e <= 0.25) return 'Çok iyi';
  if (e <= 0.75) return 'İyi';
  if (e <= 1.25) return 'Zayıf';
  if (e <= 2.5) return 'Çok zayıf';
  return 'Şok';
}

function analyzeFund(fundCode, holdingsInfo, quoteMap, priceRowsByFund, statsRows) {
  const rows = holdingsInfo.rows || [];
  const latestPriceRows = priceRowsByFund[fundCode] || [];
  const latestPrice = latestPriceRows[0] || null;
  const learning = learningForFund(statsRows, fundCode);

  const detailed = rows.map(row => {
    const quote = row.yahooSymbol ? quoteMap[row.yahooSymbol] : null;
    const priced = Boolean(quote && quote.ok && quote.marketChange !== null);
    const marketChange = priced ? quote.marketChange : 0;
    const contribution = priced ? (row.effectiveWeight / 100) * marketChange : 0;
    return {
      fundCode,
      assetType: row.assetType,
      symbol: row.originalSymbol,
      yahooSymbol: row.yahooSymbol,
      name: row.name,
      weight: round(row.effectiveWeight, 4),
      marketChange: priced ? round(marketChange, 4) : null,
      contribution: priced ? round(contribution, 4) : 0,
      directPricing: priced,
      price: quote && quote.ok ? quote.price : null,
      previous: quote && quote.ok ? quote.previous : null,
      pricingSource: quote ? quote.pricingSource : 'not_stock_or_unresolved',
      issue: priced ? null : (quote && quote.error ? quote.error : 'not_priced')
    };
  });

  const priced = detailed.filter(r => r.directPricing);
  const unpriced = detailed.filter(r => !r.directPricing);
  const pricedWeight = priced.reduce((s, r) => s + toNum(r.weight, 0), 0);
  const stockWeight = detailed.filter(r => r.assetType === 'stock').reduce((s, r) => s + toNum(r.weight, 0), 0);
  const rawPrediction = detailed.reduce((s, r) => s + toNum(r.contribution, 0), 0);
  const calibrationOffset = toNum(learning.offset, 0);
  const finalPrediction = rawPrediction + calibrationOffset;
  const coverage = clamp(pricedWeight, 0, 100);
  const residualWeight = clamp(100 - coverage, 0, 100);
  const confidence = getConfidence(coverage, priced.length, detailed.length, learning);

  const sortedByContribution = [...detailed].filter(r => r.directPricing).sort((a, b) => toNum(b.contribution, 0) - toNum(a.contribution, 0));
  const topPositive = sortedByContribution.filter(r => toNum(r.contribution, 0) > 0).slice(0, 8);
  const topNegative = sortedByContribution.filter(r => toNum(r.contribution, 0) < 0).sort((a, b) => toNum(a.contribution, 0) - toNum(b.contribution, 0)).slice(0, 8);

  const latestActualChange = latestPrice ? toNum(latestPrice.daily_change, null) : null;
  const shockSignals = topNegative.filter(r => Math.abs(toNum(r.contribution, 0)) >= 0.5).length;

  const quality = [];
  if (!rows.length) quality.push('holding_missing');
  if (coverage < 40) quality.push('low_pricing_coverage');
  if (stockWeight > coverage + 15) quality.push('stock_pricing_gap');
  if (shockSignals > 0) quality.push('negative_stock_contribution_detected');

  return {
    fundCode,
    predictionDate: trToday(),
    latestFundPriceDate: latestPrice ? latestPrice.price_date : null,
    latestFundPrice: latestPrice ? round(latestPrice.price, 4) : null,
    latestFundDailyChange: latestActualChange,
    holdingsReportDate: holdingsInfo.reportDate,
    totalHoldingRows: detailed.length,
    pricedRows: priced.length,
    unpricedRows: unpriced.length,
    stockWeight: round(stockWeight, 2),
    pricedWeight: round(pricedWeight, 2),
    coverage: round(coverage, 2),
    residualWeight: round(residualWeight, 2),
    rawPredictedChange: round(rawPrediction, 4),
    calibrationOffset: round(calibrationOffset, 4),
    predictedChange: round(finalPrediction, 4),
    calibratedChange: round(finalPrediction, 4),
    direction: direction(finalPrediction),
    confidence,
    confidenceText: confidence >= 80 ? 'Yüksek' : confidence >= 60 ? 'Orta' : 'Düşük',
    learningStatus: learning.status,
    quality,
    shockSignals,
    topPositiveContributors: topPositive,
    topNegativeContributors: topNegative,
    unresolvedRows: unpriced.slice(0, 40),
    details: detailed
  };
}

function predictionText(p) {
  const sign = toNum(p.predictedChange, 0) >= 0 ? '+' : '';
  const coverageText = `${round(p.coverage, 1)}%`;
  const neg = p.topNegativeContributors && p.topNegativeContributors[0];
  const pos = p.topPositiveContributors && p.topPositiveContributors[0];
  const lead = neg ? `${neg.symbol || neg.yahooSymbol}: ${round(neg.contribution, 2)} puan` : pos ? `${pos.symbol || pos.yahooSymbol}: +${round(pos.contribution, 2)} puan` : 'belirgin fiyatlanan katkı yok';
  return `${p.fundCode}: ${sign}${round(p.predictedChange, 2)}% | kapsama ${coverageText} | ana katkı: ${lead}`;
}

async function buildCausalReport() {
  const [priceRows, holdingRows, statsRows] = await Promise.all([
    getFundPrices(),
    getFundHoldings(),
    getLearningStats()
  ]);

  const priceRowsByFund = latestPricesByFund(priceRows);
  const holdingsByFund = {};
  for (const code of FUND_ORDER) holdingsByFund[code] = normalizeHoldings(holdingRows, code);

  const quoteMap = await buildQuoteMap(holdingsByFund);
  const byFundArray = FUND_ORDER.map(code => analyzeFund(code, holdingsByFund[code], quoteMap, priceRowsByFund, statsRows));
  const byFund = Object.fromEntries(byFundArray.map(x => [x.fundCode, x]));

  const totalRows = byFundArray.reduce((s, f) => s + f.totalHoldingRows, 0);
  const pricedRows = byFundArray.reduce((s, f) => s + f.pricedRows, 0);
  const avgCoverage = byFundArray.length ? byFundArray.reduce((s, f) => s + toNum(f.coverage, 0), 0) / byFundArray.length : 0;
  const lowCoverageFunds = byFundArray.filter(f => toNum(f.coverage, 0) < 40).map(f => f.fundCode);
  const shockFunds = byFundArray.filter(f => f.shockSignals > 0 || Math.abs(toNum(f.predictedChange, 0)) >= 2.5).map(f => f.fundCode);

  return {
    priceRows,
    holdingRows,
    statsRows,
    quoteMap,
    byFund,
    byFundArray,
    summary: {
      funds: FUND_ORDER,
      totalHoldingRows: totalRows,
      pricedHoldingRows: pricedRows,
      averageCoverage: round(avgCoverage, 2),
      lowCoverageFunds,
      shockSignalFunds: shockFunds,
      pricingSymbols: Object.keys(quoteMap).length,
      pricedSymbols: Object.values(quoteMap).filter(q => q.ok).length
    }
  };
}

function makePredictionPayload(predictions) {
  const now = new Date().toISOString();
  return predictions.map(p => ({
    fund_code: p.fundCode,
    prediction_date: p.predictionDate,
    model: MODEL_KEY,
    model_key: MODEL_KEY,
    model_version: MODEL_NAME,
    predicted_change: p.predictedChange,
    raw_predicted_change: p.rawPredictedChange,
    calibrated_change: p.calibratedChange,
    direction: p.direction,
    confidence: p.confidence,
    coverage: p.coverage,
    residual_weight: p.residualWeight,
    sample_size: p.pricedRows,
    calibration_offset: p.calibrationOffset,
    actual_change: null,
    error_change: null,
    note: `v10.1: Causal NAV. Fon içerikleri, fiyatlanabilen hisse ağırlıkları ve güncel piyasa hareketleriyle üretildi. Kapsama: ${p.coverage}%.`,
    created_at: now,
    updated_at: now
  }));
}

function normalizeSameKeys(rows) {
  const keys = unique(rows.flatMap(r => Object.keys(r))).sort();
  return rows.map(row => {
    const out = {};
    for (const k of keys) out[k] = row[k] === undefined ? null : row[k];
    return out;
  });
}

async function upsertPredictionHistory(payload) {
  if (!payload.length) return { saved: 0, rows: [], warning: 'empty_payload' };
  let rows = normalizeSameKeys(payload);
  const removedColumns = [];

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const saved = await supabaseFetch('prediction_history?on_conflict=fund_code,prediction_date,model', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows)
      });
      return { saved: Array.isArray(saved) ? saved.length : rows.length, rows: saved || [], removedColumns };
    } catch (error) {
      const body = String(error.body || error.message || '');
      const match = body.match(/Could not find the '([^']+)' column/i) || body.match(/column "([^"]+)"/i);
      if (match && match[1]) {
        const missing = match[1];
        removedColumns.push(missing);
        rows = rows.map(row => {
          const next = { ...row };
          delete next[missing];
          return next;
        });
        rows = normalizeSameKeys(rows);
        continue;
      }
      return {
        saved: 0,
        rows: [],
        removedColumns,
        error: body.slice(0, 1200)
      };
    }
  }

  return { saved: 0, rows: [], removedColumns, error: 'too_many_schema_retries' };
}

function compactPrediction(p) {
  return {
    fundCode: p.fundCode,
    predictionDate: p.predictionDate,
    latestFundPriceDate: p.latestFundPriceDate,
    latestFundPrice: p.latestFundPrice,
    latestFundDailyChange: p.latestFundDailyChange,
    predictedChange: p.predictedChange,
    rawPredictedChange: p.rawPredictedChange,
    calibratedChange: p.calibratedChange,
    direction: p.direction,
    confidence: p.confidence,
    confidenceText: p.confidenceText,
    coverage: p.coverage,
    residualWeight: p.residualWeight,
    pricedRows: p.pricedRows,
    totalHoldingRows: p.totalHoldingRows,
    holdingsReportDate: p.holdingsReportDate,
    quality: p.quality,
    learningStatus: p.learningStatus,
    topPositiveContributors: p.topPositiveContributors,
    topNegativeContributors: p.topNegativeContributors,
    unresolvedRows: p.unresolvedRows
  };
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  const query = parseQuery(req);
  const reportMode = String(query.report || '').toLowerCase() === '1' || String(query.mode || '').toLowerCase() === 'report';
  const authorized = isAuthorized(req, query);

  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return json(res, 405, { ok: false, version: API_VERSION, error: 'method_not_allowed' });
    }

    const report = await buildCausalReport();
    const predictions = report.byFundArray;

    if (reportMode) {
      return json(res, 200, {
        ok: true,
        version: API_VERSION,
        generatedAt: new Date().toISOString(),
        mode: 'embedded_causal_nav_report',
        endpoint: '/api/predict?manual=finscope&report=1',
        model: MODEL_KEY,
        modelVersion: MODEL_NAME,
        principle: 'Fon tahmini, portföydeki fiyatlanabilen her varlığın ağırlığı ile piyasa değişiminin çarpımlarının toplamından hesaplanır.',
        summary: report.summary,
        byFund: Object.fromEntries(predictions.map(p => [p.fundCode, compactPrediction(p)])),
        diagnostics: {
          quoteSymbols: Object.keys(report.quoteMap),
          pricedSymbols: Object.values(report.quoteMap).filter(q => q.ok).map(q => q.symbol),
          failedSymbols: Object.values(report.quoteMap).filter(q => !q.ok).map(q => ({ symbol: q.symbol, error: q.error }))
        },
        note: 'Bu mod tahmin yazmaz. Sadece predict.js içine gömülü Causal NAV kapsama ve katkı raporunu döndürür.'
      });
    }

    const shouldWrite = authorized || String(query.write || '').toLowerCase() === '1';
    const saveResult = shouldWrite ? await upsertPredictionHistory(makePredictionPayload(predictions)) : { saved: 0, rows: [], skipped: 'not_authorized_read_only' };

    return json(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      version: API_VERSION,
      model: MODEL_KEY,
      modelKey: MODEL_KEY,
      modelVersion: MODEL_NAME,
      source: 'fund_holdings + market pricing + fund_prices + model_learning_stats',
      causalNavEngine: {
        enabled: true,
        reportUrl: '/api/predict?manual=finscope&report=1',
        principle: 'Fon içeriği ağırlığı x güncel piyasa değişimi',
        averageCoverage: report.summary.averageCoverage,
        lowCoverageFunds: report.summary.lowCoverageFunds,
        shockSignalFunds: report.summary.shockSignalFunds
      },
      predictions: Object.fromEntries(predictions.map(p => [p.fundCode, compactPrediction(p)])),
      predictionTexts: predictions.map(predictionText),
      saveResult,
      timingMs: Date.now() - startedAt,
      disclaimer: 'Bu tahminler model bazlıdır; kesinlik içermez ve yatırım tavsiyesi değildir.'
    });
  } catch (error) {
    return json(res, 200, {
      ok: false,
      generatedAt: new Date().toISOString(),
      version: API_VERSION,
      model: MODEL_KEY,
      error: error && error.message ? error.message : String(error),
      hint: 'api/predict.js v10.1 hata verdi. Yeni endpoint eklenmediği için Vercel function limitini artırmaz.'
    });
  }
};
