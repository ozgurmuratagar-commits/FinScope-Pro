const TEFAS_ENDPOINT =
  "https://www.tefas.gov.tr/api/DB/BindHistoryInfo";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const fund = String(req.query.fund || "PBR").toUpperCase();

    const response = await fetch(TEFAS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://www.tefas.gov.tr",
        Referer:
          "https://www.tefas.gov.tr/TarihselVeriler.aspx",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
      },
      body: JSON.stringify({
        fontip: "YAT",
        fonkod: fund,
        bastarih: "01.08.2026",
        bittarih: "07.08.2026"
      })
    });

    const text = await response.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        fund,
        error: "TEFAS JSON parse edilemedi",
        sample: text.slice(0, 1000)
      });
    }

    const rows =
      Array.isArray(json)
        ? json
        : Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.result)
        ? json.result
        : Array.isArray(json?.resultList)
        ? json.resultList
        : [];

    const first = rows[0] || {};

    res.status(200).json({
      ok: true,
      fund,
      rowCount: rows.length,
      keys: Object.keys(first),
      sample: first
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
};
