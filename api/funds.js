module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      version: "FinScope Supabase",
      source: "supabase",
      error: "SUPABASE_URL veya SUPABASE_ANON_KEY eksik.",
      funds: {}
    });
  }

  try {
    const endpoint =
      `${supabaseUrl}/rest/v1/fund_prices` +
      `?select=fund_code,price,daily_change,price_date,source` +
      `&fund_code=in.(PBR,PHE,TLY)` +
      `&order=price_date.desc`;

    const response = await fetch(endpoint, {
     headers: {
  apikey: supabaseKey,
  Accept: "application/json"
}
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Supabase HTTP ${response.status}: ${text}`);
    }

    const rows = JSON.parse(text);
    const funds = {};

    // Her fonun tarih sırasına göre gelen ilk, yani en güncel kaydını alır.
    for (const row of rows) {
      const code = String(row.fund_code || "").toUpperCase();

      if (!["PBR", "PHE", "TLY"].includes(code) || funds[code]) {
        continue;
      }

      funds[code] = {
        price: row.price,
        dailyChange: row.daily_change,
        date: row.price_date,
        source: row.source || "Supabase",
        holdings: []
      };
    }

    return res.status(200).json({
      version: "FinScope Supabase Data",
      lastUpdated: new Date().toISOString(),
      source: "supabase",
      funds
    });
  } catch (error) {
    return res.status(500).json({
      version: "FinScope Supabase Data",
      source: "supabase",
      error: String(error.message || error),
      funds: {}
    });
  }
};
