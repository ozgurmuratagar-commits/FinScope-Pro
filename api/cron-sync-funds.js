module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const manualOk = req.query && req.query.manual === "finscope";

    const cronSecret = process.env.CRON_SECRET || "";
    const authHeader = req.headers.authorization || "";
    const cronOk = cronSecret && authHeader === `Bearer ${cronSecret}`;

    if (!manualOk && !cronOk) {
      return res.status(401).json({
        ok: false,
        endpoint: "cron-sync-funds",
        error: "Yetkisiz cron istegi.",
        hint: "Vercel Cron icin CRON_SECRET gerekir. Manuel test icin ?manual=finscope kullan."
      });
    }

    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;

    if (!host) {
      return res.status(500).json({
        ok: false,
        endpoint: "cron-sync-funds",
        error: "Host bilgisi bulunamadi."
      });
    }

    const targetUrl = `${protocol}://${host}/api/sync-funds?manual=finscope`;

    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": "FinScope-Cron-Sync/1.0"
      }
    });

    const text = await response.text();

    let result;
    try {
      result = JSON.parse(text);
    } catch {
      result = { raw: text };
    }

    return res.status(response.status).json({
      ok: response.ok,
      endpoint: "cron-sync-funds",
      cronBridge: true,
      target: "/api/sync-funds?manual=finscope",
      status: response.status,
      generatedAt: new Date().toISOString(),
      result
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      endpoint: "cron-sync-funds",
      cronBridge: true,
      error: String(err.message || err)
    });
  }
};
