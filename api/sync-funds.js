const FUNDS = ["PBR", "PHE", "TLY"];
const TEFAS_ENDPOINT = "https://www.tefas.gov.tr/api/DB/BindHistoryInfo";

function pad(value) {
  return String(value).padStart(2, "0");
}

function toTefasDate(date) {
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
}

function parseTefasDate(value) {
  if (!value) return null;

  if (typeof value === "string") {
    const dotMatch = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (dotMatch) {
      return `${dotMatch[3]}-${dotMatch[2]}-${dotMatch[1]}`;
    }

    const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }

    const msMatch = value.match(/\/Date\((\d+)\)\//);
    if (msMatch) {
      return new Date(Number(msMatch[1])).toISOString().slice(0, 10);
    }
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

async function fetchTefasHistory(fundCode) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 14);

  const body = new URLSearchParams({
    fontip: "YAT",
    bastarih: toTefasDate(start),
    bittarih: toTefasDate(end),
    fonkod: fundCode,
  });

  const response = await fetch(TEFAS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "User-Agent": "Mozilla/5.0 FinScope-Data-Collector/1.0",
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.tefas.gov.tr/TarihselVeriler.aspx",
    },
    body: body.toString(),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`TEFAS ${fundCode} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`TEFAS ${fundCode} JSON dönmedi: ${text.slice(0, 300)}`);
  }

  const rows = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`TEFAS ${fundCode} için veri dönmedi.`);
  }

  return rows
    .map((row) => ({
      code: String(row.FONKODU || row.fonkodu || row.FONKOD || fundCode).toUpperCase(),
      price: toNumber(row.FIYAT ?? row.fiyat ?? row.PRICE),
      date: parseTefasDate(row.TARIH ?? row.tarih ?? row.DATE),
      portfolioSize: toNumber(row.PORTFOYBUYUKLUK ?? row.PORTFOY_BUYUKLUK ?? row.portfoybuyukluk),
      investorCount: toNumber(row.KISISAYISI ?? row.KISI_SAYISI ?? row.kisisayisi),
    }))
    .filter((row) => row.code === fundCode && row.price !== null && row.date)
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function replaceFundRow(supabaseUrl, secretKey, row) {
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
      (await deleteResponse.text()).slice(0, 300)
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
      `Supabase INSERT ${row.fund_code} HTTP ${insertResponse.status}: ${insertText.slice(0, 300)}`
    );
  }

  return insertText ? JSON.parse(insertText) : [];
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
const cronSecret = process.env.CRON_SECRET;
const authHeader = req.headers.authorization;

// GEÇİCİ TEST
// if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
//   return res.status(401).json({
//     ok: false,
//     error: "Yetkisiz istek.",
//   });
// }
  

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
        portfolio_size: latest.portfolioSize,
        investor_count: latest.investorCount,
        source: "TEFAS",
      };

      await replaceFundRow(supabaseUrl, secretKey, row);

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
