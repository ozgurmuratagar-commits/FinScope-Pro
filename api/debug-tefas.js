const CANDIDATES = [
  {
    name: "funds_dagilimSiraliGetirT",
    url: "https://www.tefas.gov.tr/api/funds/dagilimSiraliGetirT",
    body: fund => ({ fonkod: fund })
  },
  {
    name: "funds_fonDetayBilgiGetirT",
    url: "https://www.tefas.gov.tr/api/funds/fonDetayBilgiGetirT",
    body: fund => ({ fonkod: fund })
  },
  {
    name: "funds_fonAnalizGetirT",
    url: "https://www.tefas.gov.tr/api/funds/fonAnalizGetirT",
    body: fund => ({ fonkod: fund })
  },
  {
    name: "db_BindHistoryInfo",
    url: "https://www.tefas.gov.tr/api/DB/BindHistoryInfo",
    body: fund => ({
      fontip: "YAT",
      fonkod: fund,
      bastarih: "01.08.2026",
      bittarih: "07.08.2026"
    })
  }
];

function pickRows(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.result)) return json.result;
  if (Array.isArray(json?.resultList)) return json.resultList;
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.value)) return json.value;
  return [];
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const fund = String(req.query.fund || "PBR").toUpperCase();

  const results = [];

  for (const c of CANDIDATES) {
    try {
      const response = await fetch(c.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json,*/*",
          Origin: "https://www.tefas.gov.tr",
          Referer: "https://www.tefas.gov.tr/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
        },
        body: JSON.stringify(c.body(fund))
      });

      const text = await response.text();

      let json = null;
      let parseOk = true;

      try {
        json = JSON.parse(text);
      } catch (e) {
        parseOk = false;
      }

      const rows = parseOk ? pickRows(json) : [];
      const first = rows[0] || {};

      results.push({
        name: c.name,
        http: response.status,
        parseOk,
        rowCount: rows.length,
        keys: Object.keys(first),
        sample: first,
        textSample: parseOk ? null : text.slice(0, 500)
      });
    } catch (err) {
      results.push({
        name: c.name,
        ok: false,
        error: String(err.message || err)
      });
    }
  }

  res.status(200).json({
    ok: true,
    fund,
    results
  });
};
