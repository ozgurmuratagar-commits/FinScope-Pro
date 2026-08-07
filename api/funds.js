const FUNDS = ["PBR", "PHE", "TLY"];

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function pickLatestPrices(rows) {
  const out = {};

  for (const row of rows || []) {
    const code = String(row.fund_code || row.code || "").toUpperCase();
    if (!FUNDS.includes(code)) continue;

    if (!out[code]) {
      out[code] = row;
      continue;
    }

    const oldDate = String(out[code].price_date || out[code].date || "");
    const newDate = String(row.price_date || row.date || "");

    if (newDate > oldDate) {
      out[code] = row;
    }
  }

  return out;
}

async function supabaseGet(path, key) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase GET ${path} HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Supabase JSON parse error: ${text.slice(0, 500)}`);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_URL veya Supabase key eksik."
      });
    }

    const priceRows = await supabaseGet(
      "fund_prices?select=*&order=price_date.desc&limit=200",
      supabaseKey
    );

    const holdingRows = await supabaseGet(
      "fund_holdings?select=*&order=fund_code.asc,weight.desc",
      supabaseKey
    );

    const latest = pickLatestPrices(priceRows);

    const holdingsByFund = {};

    for (const h of holdingRows || []) {
      const code = String(h.fund_code || "").toUpperCase();
      if (!FUNDS.includes(code)) continue;

      if (!holdingsByFund[code]) holdingsByFund[code] = [];

      holdingsByFund[code].push({
        assetType: h.asset_type || "",
        symbol: h.symbol || "",
        name: h.name || h.symbol || "",
        weight: num(h.weight),
        reportDate: h.report_date || "",
        source: h.source || ""
      });
    }

    const funds = {};

    for (const code of FUNDS) {
      const p = latest[code] || {};

      funds[code] = {
        price: num(p.price),
        dailyChange: num(p.daily_change),
        date: p.price_date || p.date || "",
        source: p.source || "Supabase",
        portfolioSize: num(p.portfolio_size),
        investorCount: num(p.investor_count),
        holdings: holdingsByFund[code] || []
      };
    }

    res.status(200).json({
      version: "FinScope Supabase Data + Holdings",
      lastUpdated: new Date().toISOString(),
      source: "supabase",
      holdingsStatus: {
        PBR: (holdingsByFund.PBR || []).length,
        PHE: (holdingsByFund.PHE || []).length,
        TLY: (holdingsByFund.TLY || []).length
      },
      funds
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
};
