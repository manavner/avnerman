// Temporary OAuth callback — exchanges auth code for refresh token
// Visit: /api/oauth-callback?code=... after Google authorization

export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) return res.send("No code provided");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: "https://avnerman.vercel.app/api/oauth-callback",
      grant_type: "authorization_code",
    }),
  });

  const data = await resp.json();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(
    data.refresh_token
      ? `✅ Refresh Token:\n\n${data.refresh_token}`
      : `❌ Error:\n${JSON.stringify(data, null, 2)}`
  );
}
