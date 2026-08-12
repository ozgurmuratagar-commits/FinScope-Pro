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
        error: "Yetkisiz cron istegi.",
        hint: "CRON_SECRET tanimli olmali veya test icin ?manual=finscope kullanilmali."
      });
    }

    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;

    if (!host) {
      return res.status(500).json({
        ok: false,
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

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }

    return res.status(response.status).json({
      ok: response.ok,
      cronBridge: true,
      target: "/api/sync-funds?manual=finscope",
      status: response.status,
      generatedAt: new Date().toISOString(),
      result: payload
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      cronBridge: true,
      error: String(err.message || err)
    });
  }
};
