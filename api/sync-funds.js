const FUNDS = ["PBR", "PHE", "TLY"];
const TEFAS_ENDPOINT = "https://www.tefas.gov.tr/api/funds/fonFiyatBilgiGetir";

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  let text = String(value).trim();

  if (text.includes(",") && text.includes(".")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else {
    text = text.replace(",", ".");
  }

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function toIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;

  const text = String(value).trim();

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dotted = text.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;

  const msDate = text.match(/\/Date\((\d+)\)\//);
  if (msDate) {
    return new Date(Number(msDate[1])).toISOString().slice(0, 10);
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function readField(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) {
      return row[name];
    }
  }
  return null;
}

async function fetchTefasHistory(fundCode) {
  const response = await fetch(TEFAS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: "https://www.tefas.gov.tr",
      Referer: `https://www.tefas.gov.tr/tr/fon-detayli-analiz/${fundCode}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/126.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      fonKodu: fundCode,
      dil: "TR",
      periyod: 13,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `TEFAS ${fundCode} HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `TEFAS ${fundCode} JSON dönmedi: ${text.slice(0, 500)}`
    );
  }

  if (
    payload &&
    payload.errorCode &&
    String(payload.errorCode) !== "0"
  ) {
    throw new Error(
      `TEFAS ${fundCode}: ${payload.errorMessage || payload.errorCode}`
    );
  }

  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.resultList)
      ? payload.resultList
      : Array.isArray(payload.data)
        ? payload.data
        : [];

  if (!rows.length) {
    throw new Error(
      `TEFAS ${fundCode} için fiyat verisi dönmedi. Yanıt: ${text.slice(0, 500)}`
    );
  }

  const normalized = rows
    .map((row) => ({
      price: toNumber(
        readField(row, ["fiyat", "Fiyat", "FIYAT", "price", "Price"])
      ),
      date: toIsoDate(
        readField(row, ["tarih", "Tarih", "TARIH", "date", "Date"])
      ),
    }))
    .filter((row) => row.price !== null && row.date !== null)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!normalized.length) {
    throw new Error(
      `TEFAS ${fundCode} yanıtında geçerli fiyat/tarih bulunamadı. ` +
      `İlk kayıt: ${JSON.stringify(rows[0]).slice(0, 500)}`
    );
  }

  return normalized;
}

async function saveFundRow(supabaseUrl, secretKey, row) {
  const tableUrl = `${supabaseUrl}/rest/v1/fund_prices`;

  const headers = {
    apikey: secretKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const deleteUrl =
    `${tableUrl}?fund_code=eq.${encodeURIComponent(row.fund_code)}` +
    `&price_date=eq.${encodeURIComponent(row.price_date)}`;

  const deleteResponse = await fetch(deleteUrl, {
    method: "DELETE",
    headers,
  });

  if (!deleteResponse.ok) {
    throw new Error(
      `Supabase DELETE ${row.fund_code} HTTP ${deleteResponse.status}: ` +
      (await deleteResponse.text()).slice(0, 500)
    );
  }

  const insertResponse = await fetch(tableUrl, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });

  const insertText = await insertResponse.text();

  if (!insertResponse.ok) {
    throw new Error(
      `Supabase INSERT ${row.fund_code} HTTP ${insertResponse.status}: ` +
      insertText.slice(0, 500)
    );
  }

  return insertText ? JSON.parse(insertText) : [];
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({
      ok: false,
      error: "Yetkisiz istek.",
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !secretKey) {
    return res.status(500).json({
      ok: false,
      error: "SUPABASE_URL veya SUPABASE_SECRET_KEY eksik.",
    });
  }

  const results = [];

  for (const fundCode of FUNDS) {
    try {
      const history = await fetchTefasHistory(fundCode);
      const latest = history[0];
      const previous = history[1] || null;

      const dailyChange =
        previous && previous.price
          ? ((latest.price - previous.price) / previous.price) * 100
          : null;

      const row = {
        fund_code: fundCode,
        price: latest.price,
        daily_change: dailyChange,
        price_date: latest.date,
        portfolio_size: null,
        investor_count: null,
        source: "TEFAS v2",
      };

      await saveFundRow(supabaseUrl, secretKey, row);

      results.push({
        fund: fundCode,
        ok: true,
        price: latest.price,
        dailyChange,
        date: latest.date,
      });
    } catch (error) {
      results.push({
        fund: fundCode,
        ok: false,
        error: String(error.message || error),
      });
    }
  }

  const successCount = results.filter((item) => item.ok).length;

  return res.status(successCount > 0 ? 200 : 502).json({
    ok: successCount === FUNDS.length,
    updated: successCount,
    total: FUNDS.length,
    timestamp: new Date().toISOString(),
    results,
  });
};
