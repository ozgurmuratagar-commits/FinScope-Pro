const TESTS = [
  {
    name: "dagilim_fonkod_only",
    url: "https://www.tefas.gov.tr/api/funds/dagilimSiraliGetirT",
    method: "POST",
    body: fund => ({ fonkod: fund })
  },
  {
    name: "dagilim_fontip_fonkod",
    url: "https://www.tefas.gov.tr/api/funds/dagilimSiraliGetirT",
    method: "POST",
    body: fund => ({ fontip: "YAT", fonkod: fund })
  },
  {
    name: "dagilim_fonKod_upperK",
    url: "https://www.tefas.gov.tr/api/funds/dagilimSiraliGetirT",
    method: "POST",
    body: fund => ({ fonKod: fund })
  },
  {
    name: "dagilim_FonKod_pascal",
    url: "https://www.tefas.gov.tr/api/funds/dagilimSiraliGetirT",
    method: "POST",
    body: fund => ({ FonKod: fund })
  },
  {
    name: "dagilim_kod",
    url: "https://www.tefas.gov.tr/api/funds/dagilimSiraliGetirT",
    method: "POST",
    body: fund => ({ kod: fund })
  },
  {
    name: "dagilim_all_common",
    url: "https://www.tefas.gov.tr/api/funds/dagilimSiraliGetirT",
    method: "POST",
    body: fund => ({
      fontip: "YAT",
      fonkod: fund,
      fonKod: fund,
      FonKod: fund,
      kod: fund
    })
  },
  {
    name: "fund_detail_fonkod",
    url: "https://www.tefas.gov.tr/api/funds/fonDetayBilgiGetir",
    method: "POST",
    body: fund => ({ fonkod: fund })
  },
  {
    name: "fund_detail_T",
    url: "https://www.tefas.gov.tr/api/funds/fonDetayBilgiGetirT",
    method: "POST",
    body: fund => ({ fonkod: fund })
  },
  {
    name: "fund_profile_fonkod",
    url: "https://www.tefas.gov.tr/api/funds/fonProfilBilgiGetir",
    method: "POST",
    body: fund => ({ fonkod: fund })
  },
  {
    name: "fund_profile_T",
    url: "https://www.tefas.gov.tr/api/funds/fonProfilBilgiGetirT",
    method: "POST",
    body: fund => ({ fonkod: fund })
  }
];

function pickRows(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.Data)) return json.Data;
  if (Array.isArray(json?.result)) return json.result;
  if (Array.isArray(json?.Result)) return json.Result;
  if (Array.isArray(json?.resultList)) return json.resultList;
  if (Array.isArray(json?.ResultList)) return json.ResultList;
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.value)) return json.value;

  if (json && typeof json === "object") {
    for (const key of Object.keys(json)) {
      if (Array.isArray(json[key])) return json[key];
    }
  }

  return [];
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const fund = String(req.query.fund || "PBR").toUpperCase();

  const results = [];

  for (const test of TESTS) {
    try {
      const body = test.body(fund);

      const response = await fetch(test.url, {
        method: test.method,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          Accept: "application/json, text/javascript, */*; q=0.01",
          Origin: "https://www.tefas.gov.tr",
          Referer: "https://www.tefas.gov.tr/",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
        },
        body: JSON.stringify(body)
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
        name: test.name,
        http: response.status,
        bodySent: body,
        parseOk,
        jsonKeys: json && typeof json === "object" ? Object.keys(json) : [],
        rowCount: rows.length,
        rowKeys: Object.keys(first),
        sample: first,
        rawSample: text.slice(0, 700)
      });
    } catch (err) {
      results.push({
        name: test.name,
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
