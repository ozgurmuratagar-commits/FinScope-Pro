const FUNDS = ["PBR", "PHE", "TLY"];
const TEFAS_BASE = "https://www.tefas.gov.tr";
const TEFAS_HISTORY_PAGE = `${TEFAS_BASE}/TarihselVeriler.aspx`;
const TEFAS_HISTORY_ENDPOINT = `${TEFAS_BASE}/api/DB/BindHistoryInfo`;

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseTefasDate(value) {
  if (value === null || value === undefined || value === "") return null;

  const text = String(value);

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dotted = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;

  const msDate = text.match(/\/Date\((\d+)\)\//);
  if (msDate) return new Date(Number(msDate[1])).toISOString().slice(0, 10);

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  let text = String(value).trim();

  // 1.234,56 -> 1234.56
  if (text.includes(",") && text.includes(".")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else {
    text = text.replace(",", ".");
  }

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function extractCookie(response) {
  if (typeof response.headers.getSetCookie === "function") {
    const cookies = response.headers.getSetCookie();
    if (Array.isArray(cookies) && cookies.length) {
      return cookies.map((item) => item.split(";")[0]).join("; ");
    }
  }

  const header = response.headers.get("set-cookie");
  if (!header) return "";

  return header
    .split(/,(?=[^;,]+=)/)
    .map((item) => item.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function createTefasSession() {
  const response = await fetch(TEFAS_HISTORY_PAGE, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`TEFAS oturum sayfası HTTP ${response.status}`);
  }

  // Gövdeyi tüketmek bağlantı/cookie akışının tamamlanmasını sağlar.
  await response.text();
  return extractCookie(response);
}

async function fetchTefasHistory(fundCode) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 14);

  const cookie = await createTefasSession();

  // BindHistoryInfo tarihleri YYYY-MM-DD bekler.
  const body = new URLSearchParams({
    fontip: "YAT",
    bastarih: toIsoDate(start),
    bittarih: toIsoDate(end),
    fonkod: fundCode,
  });

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6",
    Origin: TEFAS_BASE,
    Referer: TEFAS_HISTORY_PAGE,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
  };

  if (cookie) headers.Cookie = cookie;

  const response = await fetch(TEFAS_HISTORY_ENDPOINT, {
    method: "POST",
    headers,
    body: body.toString(),
    redirect: "follow",
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

  const rawRows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data)
      ? payload.data
      : [];

  if (!rawRows.length) {
    throw new Error(`TEFAS ${fundCode} için veri dönmedi.`);
  }

  const rows = rawRows
    .map((row) => ({
      code: String(
        row.FONKODU ?? row.fonkodu ?? row.FONKOD ?? row.fonkod ?? fundCode
      ).toUpperCase(),
      price: toNumber(row.FIYAT ?? row.fiyat ?? row.PRICE ?? row.price),
      date: parseTefasDate(row.TARIH ?? row.tarih ?? row.DATE ?? row.date),
      portfolioSize: toNumber(
        row.PORTFOYBUYUKLUK ??
        row.PORTFOY_BUYUKLUK ??
        row.portfoybuyukluk ??
        row.PORTFÖYBÜYÜKLÜĞÜ
      ),
      investorCount: toNumber(
        row.KISISAYISI ??
        row.KISI_SAYISI ??
        row.kisisayisi ??
        row.YATIRIMCISAYISI
      ),
    }))
    .filter(
      (row) =>
        row.code === fundCode &&
        row.price !== null &&
        row.date !== null
    )
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!rows.length) {
    throw new Error(
      `TEFAS ${fundCode} yanıtı geldi fakat geçerli fiyat/tarih bulunamadı.`
    );
  }

  return rows;
}

async function replaceFundRow(supabaseUrl, secretKey, row) {
  const tableUrl = `${supabaseUrl}/rest/v1/fund_prices`;

  const headers = {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
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

  // Güvenlik yeniden etkin.
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
