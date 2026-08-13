const FUNDS = ["PBR", "PHE", "TLY"];

const API_VERSION = "FinScope TEFAS Sync API v3 - Retry";
const TEFAS_ENDPOINT = "https://www.tefas.gov.tr/api/funds/fonFiyatBilgiGetir";

const MAX_FUND_ATTEMPTS = 4;
const ATTEMPT_DELAYS_MS = [0, 900, 1800, 3200];
const TEFAS_TIMEOUT_MS = 6500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;

  const secretKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !secretKey) {
    throw new Error("SUPABASE_URL veya Supabase key eksik.");
  }

  return { supabaseUrl, secretKey };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TEFAS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTefasHistoryOnce(fundCode) {
  const response = await fetchWithTimeout(
    TEFAS_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://www.tefas.gov.tr",
        Referer: `https://www.tefas.gov.tr/tr/fon-detayli-analiz/${fundCode}`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/126.0.0.0 Safari/537.36"
      },
      body: JSON.stringify({
        fonKodu: fundCode,
        dil: "TR",
        periyod: 13
      })
    },
    TEFAS_TIMEOUT_MS
  );

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

  if (payload && payload.errorCode && String(payload.errorCode) !== "0") {
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
    .map(row => ({
      price: toNumber(
        readField(row, ["fiyat", "Fiyat", "FIYAT", "price", "Price"])
      ),
      date: toIsoDate(
        readField(row, ["tarih", "Tarih", "TARIH", "date", "Date"])
      )
    }))
    .filter(row => row.price !== null && row.date !== null)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!normalized.length) {
    throw new Error(
      `TEFAS ${fundCode} yanıtında geçerli fiyat/tarih bulunamadı. ` +
        `İlk kayıt: ${JSON.stringify(rows[0]).slice(0, 500)}`
    );
  }

  return normalized;
}

async function fetchTefasHistoryWithRetry(fundCode) {
  const attempts = [];

  for (let attempt = 1; attempt <= MAX_FUND_ATTEMPTS; attempt++) {
    const delay = ATTEMPT_DELAYS_MS[attempt - 1] || 0;

    if (delay > 0) {
      await sleep(delay);
    }

    const startedAt = Date.now();

    try {
      const history = await fetchTefasHistoryOnce(fundCode);

      attempts.push({
        attempt,
        ok: true,
        durationMs: Date.now() - startedAt,
        rows: history.length,
        latestDate: history[0] ? history[0].date : null
      });

      return {
        history,
        attempts
      };
    } catch (error) {
      attempts.push({
        attempt,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: String(error.message || error)
      });

      if (attempt === MAX_FUND_ATTEMPTS) {
        const lastError = attempts[attempts.length - 1];

        throw Object.assign(
          new Error(lastError.error || `TEFAS ${fundCode} fetch failed`),
          { attempts }
        );
      }
    }
  }

  throw Object.assign(new Error(`TEFAS ${fundCode} fetch failed`), { attempts });
}

async function saveFundRow(supabaseUrl, secretKey, row) {
  const tableUrl = `${supabaseUrl}/rest/v1/fund_prices`;

  const headers = {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  const deleteUrl =
    `${tableUrl}?fund_code=eq.${encodeURIComponent(row.fund_code)}` +
    `&price_date=eq.${encodeURIComponent(row.price_date)}`;

  const deleteResponse = await fetch(deleteUrl, {
    method: "DELETE",
    headers
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
      Prefer: "return=representation"
    },
    body: JSON.stringify(row)
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

async function processFund(fundCode, supabaseUrl, secretKey) {
  const startedAt = Date.now();

  try {
    const tefas = await fetchTefasHistoryWithRetry(fundCode);

    const history = tefas.history;
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
      source: "TEFAS v3 retry"
    };

    const saved = await saveFundRow(supabaseUrl, secretKey, row);

    return {
      fund: fundCode,
      ok: true,
      price: latest.price,
      dailyChange,
      date: latest.date,
      source: row.source,
      attempts: tefas.attempts,
      savedRows: Array.isArray(saved) ? saved.length : 0,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      fund: fundCode,
      ok: false,
      error: String(error.message || error),
      attempts: Array.isArray(error.attempts) ? error.attempts : [],
      durationMs: Date.now() - startedAt
    };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  const querySecret = req.query && req.query.secret;
  const manualKey = req.query && req.query.manual;

  const authorizedByHeader =
    cronSecret && authHeader === `Bearer ${cronSecret}`;

  const authorizedByQuery =
    cronSecret && querySecret === cronSecret;

  const authorizedByManual =
    manualKey === "finscope";

  if (
    cronSecret &&
    !authorizedByHeader &&
    !authorizedByQuery &&
    !authorizedByManual
  ) {
    return res.status(401).json({
      ok: false,
      version: API_VERSION,
      error: "Yetkisiz istek."
    });
  }

  let config;

  try {
    config = getSupabaseConfig();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: API_VERSION,
      error: String(error.message || error)
    });
  }

  const startedAt = Date.now();
  const results = [];

  for (const fundCode of FUNDS) {
    const result = await processFund(
      fundCode,
      config.supabaseUrl,
      config.secretKey
    );

    results.push(result);
  }

  const successCount = results.filter(item => item.ok).length;
  const failedCount = results.length - successCount;
  const latestDates = results
    .filter(item => item.ok && item.date)
    .map(item => item.date)
    .sort();

  const latestDate = latestDates.length ? latestDates[latestDates.length - 1] : null;

  /*
    Cron-job.org tarafında transient hatalar yüzünden job disable olmasın diye
    endpoint çalıştıysa HTTP 200 döndürüyoruz.
    Gerçek başarı/başarısızlık JSON içindeki ok, updated ve results alanlarında.
  */
  return res.status(200).json({
    ok: successCount === FUNDS.length,
    version: API_VERSION,
    updated: successCount,
    failed: failedCount,
    total: FUNDS.length,
    latestDate,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    retryPolicy: {
      maxFundAttempts: MAX_FUND_ATTEMPTS,
      delaysMs: ATTEMPT_DELAYS_MS,
      tefasTimeoutMs: TEFAS_TIMEOUT_MS
    },
    results
  });
};
