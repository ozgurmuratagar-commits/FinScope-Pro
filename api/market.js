async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 FinScope/4.0.0', 'Accept': 'application/json,*/*' }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function getFx() {
  const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
  const r = data.rates || {};
  const TRY = Number(r.TRY), EUR = Number(r.EUR), GBP = Number(r.GBP);
  if (!TRY || !EUR || !GBP) throw new Error('FX verisi eksik');
  return { USDTRY: TRY, EURTRY: TRY/EUR, GBPTRY: TRY/GBP, EURUSD: 1/EUR, GBPUSD: 1/GBP };
}

async function getYahoo(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1d&interval=1m';
  const data = await fetchJson(url);
  const meta = data?.chart?.result?.[0]?.meta || {};
  const value = Number(meta.regularMarketPrice || meta.previousClose || meta.chartPreviousClose);
  if (!value) throw new Error('Yahoo veri yok: ' + symbol);
  return value;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const assets = {};
  const set = (key, payload) => { assets[key] = payload; };

  try {
    const fx = await getFx();
    Object.entries(fx).forEach(([key, value]) => set(key, { value, status: 'canlı', source: 'open.er-api.com', change: 0 }));
  } catch (error) {
    ['USDTRY','EURTRY','GBPTRY','EURUSD','GBPUSD'].forEach(key => set(key, { value: null, status: 'veri alınamadı', source: 'open.er-api.com', error: String(error.message || error) }));
  }

  const yahooSymbols = { XAU:'GC=F', XAG:'SI=F', XU100:'XU100.IS', XU050:'XU050.IS', XU030:'XU030.IS', BTC:'BTC-USD', BRENT:'BZ=F' };
  await Promise.all(Object.entries(yahooSymbols).map(async ([key, symbol]) => {
    try { set(key, { value: await getYahoo(symbol), status: 'canlı/gecikmeli', source: 'Yahoo Finance • ' + symbol, change: 0 }); }
    catch (error) { set(key, { value: null, status: 'veri alınamadı', source: 'Yahoo Finance • ' + symbol, error: String(error.message || error) }); }
  }));

  ['PBR','PHE','TLY','TZL','IIF','IRV','UZY'].forEach(code => set(code, { value: null, status: 'TEFAS bağlantısı v4.1', source: 'TEFAS motoru sıradaki sürüm', change: null }));
  res.status(200).json({ version: 'FinScope Professional v4.0.0 Foundation', updatedAt: new Date().toISOString(), assets });
};
