module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const required = {
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY
  };

  const ok =
    required.SUPABASE_URL &&
    required.SUPABASE_ANON_KEY &&
    required.SUPABASE_SERVICE_ROLE_KEY;

  res.status(ok ? 200 : 500).json({
    ok,
    service: "FinScope Professional",
    version: "v7.0 health check",
    environment: process.env.VERCEL_ENV || "unknown",
    required,
    time: new Date().toISOString()
  });
};
