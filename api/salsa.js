// Password-protected trigger for the "Top 60 Salsa" GitHub Actions workflow (page: /salsa.html).
// POST { password, action: "run", mode: "update" | "dry-run" } → starts the workflow
// POST { password, action: "status" }                         → latest workflow runs
// Env: SALSA_PASSWORD, and SALSA_GITHUB_TOKEN (fine-grained, Actions: read & write on this repo)
// or GITHUB_TOKEN if that one already has Actions access.

import { createHash, timingSafeEqual } from "node:crypto";

const GITHUB_REPO = "manavner/avnerman";
const WORKFLOW = "top-salsa.yml";
const PASSWORD = process.env.SALSA_PASSWORD;
const TOKEN = process.env.SALSA_GITHUB_TOKEN || process.env.GITHUB_TOKEN;

function passwordOk(given) {
  if (!PASSWORD || typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(PASSWORD).digest();
  return timingSafeEqual(a, b);
}

async function github(path, options = {}) {
  return fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "AvnerSalsa",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { password, action, mode } = req.body || {};

  if (!passwordOk(password)) {
    await new Promise(r => setTimeout(r, 1000)); // slow down guessing
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  if (!TOKEN) return res.status(500).json({ error: "SALSA_GITHUB_TOKEN is not set on Vercel" });

  try {
    if (action === "run") {
      const r = await github("/dispatches", {
        method: "POST",
        body: JSON.stringify({ ref: "main", inputs: { mode: mode === "dry-run" ? "dry-run" : "update" } }),
      });
      if (!r.ok) return res.status(502).json({ error: `GitHub ${r.status}: ${await r.text()}` });
      return res.status(200).json({ ok: true });
    }

    if (action === "status") {
      const r = await github("/runs?per_page=5");
      if (!r.ok) return res.status(502).json({ error: `GitHub ${r.status}: ${await r.text()}` });
      const data = await r.json();
      const runs = (data.workflow_runs || []).map(w => ({
        status: w.status,          // queued | in_progress | completed
        conclusion: w.conclusion,  // success | failure | cancelled | null
        created_at: w.created_at,
        url: w.html_url,
      }));
      return res.status(200).json({ runs });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    console.error("salsa error:", e);
    return res.status(500).json({ error: "שגיאת שרת" });
  }
}
