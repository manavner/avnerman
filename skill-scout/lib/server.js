'use strict';
// Local web dashboard. Binds to 127.0.0.1 only and protects every API call
// with a random per-run token (blocks other websites from triggering installs).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const catalog = require('./catalog');
const src = require('./sources');
const { assess } = require('./security');
const { recommend, top, verdict } = require('./recommend');
const { detectProject, tagsFromText } = require('./detect');
const installer = require('./install');

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function rowJson(r) {
  return { ...r.item, verdict: r.verdict, score: r.score, why: r.why, assessment: r.assessment };
}

async function handle(req, res, url, token) {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.headers['x-token'] !== token) return send(403, { error: 'bad token' });
  const q = Object.fromEntries(url.searchParams);
  const target = ['claude', 'codex', 'both'].includes(q.for) ? q.for : 'both';
  const live = q.live === '1';
  switch (url.pathname) {
    case '/api/top': return send(200, (await top({ type: q.type || undefined, target, live, limit: 50 })).map(rowJson));
    case '/api/recommend': {
      const dir = path.resolve(q.dir || process.cwd());
      const tags = q.describe ? tagsFromText(q.describe) : new Map();
      if (!q.describe || q.dir) for (const [t, why] of detectProject(dir)) if (!tags.has(t)) tags.set(t, why);
      const rows = await recommend(tags, { target, live, limit: 20 });
      return send(200, { dir, detected: Object.fromEntries(tags), rows: rows.map(rowJson) });
    }
    case '/api/search': {
      const local = catalog.search(q.q || '');
      const [registry, github] = await Promise.all([src.registrySearch(q.q || '', 15), live ? src.githubDiscover(q.type === 'skill' ? 'skill' : 'mcp', q.q || '') : []]);
      return send(200, { catalog: await Promise.all(local.map(async (i) => { const a = await assess(i); return { ...i, assessment: a, verdict: verdict(i, a.level) }; })), registry, github });
    }
    case '/api/info': {
      const item = catalog.get(q.id);
      if (!item) return send(404, { error: 'unknown id' });
      const a = await assess(item, { live: true });
      return send(200, { ...item, assessment: a, verdict: verdict(item, a.level) });
    }
    case '/api/news': return send(200, require('./scan').latestReport());
    case '/api/scan': {
      if (req.method !== 'POST') return send(405, { error: 'POST only' });
      return send(200, await require('./scan').scan());
    }
    case '/api/audit': return send(200, require('./manage').audit(q.dir ? path.resolve(q.dir) : process.cwd()));
    case '/api/quarantine': return send(200, require('./manage').listQuarantine());
    case '/api/remove':
    case '/api/restore': {
      if (req.method !== 'POST') return send(405, { error: 'POST only' });
      const body = JSON.parse(await new Promise((r) => { let d = ''; req.on('data', (x) => (d += x)); req.on('end', () => r(d || '{}')); }));
      const manage = require('./manage');
      try {
        if (body.action === 'untrust') return send(200, { ok: manage.untrust(String(body.key || '')) });
        if (url.pathname === '/api/restore') return send(200, { ok: true, restored: manage.restore(String(body.id || '')) });
        const cwd = body.dir ? path.resolve(body.dir) : process.cwd();
        const it = manage.inventory(cwd).find((x) => x.key === body.key);
        if (!it) return send(404, { error: 'Not installed (anymore?) – refresh the list.' });
        if (body.action === 'trust') return send(200, { ok: true, trusted: manage.trust(it, 'dashboard') });
        return send(200, { ok: true, removed: manage.remove({ ...it, risk: manage.riskOf(it) }, { permanent: !!body.permanent, reason: 'dashboard', cwd }) });
      } catch (e) { return send(400, { error: e.message }); }
    }
    case '/api/installed': return send(200, installer.listInstalled(q.dir ? path.resolve(q.dir) : process.cwd()));
    case '/api/install': {
      if (req.method !== 'POST') return send(405, { error: 'POST only' });
      const body = JSON.parse(await new Promise((r) => { let d = ''; req.on('data', (x) => (d += x)); req.on('end', () => r(d || '{}')); }));
      const item = catalog.get(body.id);
      if (!item) return send(404, { error: 'unknown id' });
      const a = await assess(item, { live: true });
      if (a.level === 'blocked' || item.deprecated) return send(400, { error: 'This item is blocked or deprecated.' });
      const logs = [];
      const opts = {
        target: ['claude', 'codex', 'both'].includes(body.for) ? body.for : 'both', scope: body.scope === 'project' ? 'project' : 'user',
        dryRun: !!body.dryRun, values: body.values || {}, cwd: body.dir ? path.resolve(body.dir) : process.cwd(),
        log: (m) => logs.push(stripAnsi(m)), confirm: async () => !!body.acceptMedium,
      };
      let ok = false;
      try { ok = await installer.install(item, opts); } catch (e) { logs.push('Error: ' + e.message); }
      return send(200, { ok, logs });
    }
    default: return send(404, { error: 'not found' });
  }
}

function start(o = {}) {
  const port = Number(o.port) || 4477;
  const token = crypto.randomBytes(16).toString('hex');
  const page = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  const server = http.createServer(async (req, res) => {
    // Reject DNS-rebinding: only accept requests addressed to localhost.
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host)) { res.writeHead(403); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'" });
      return res.end(page.replace('__TOKEN__', token).replace('__CWD__', JSON.stringify(process.cwd()).slice(1, -1)));
    }
    try { await handle(req, res, url, token); } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  });
  server.listen(port, '127.0.0.1', () => {
    const link = `http://127.0.0.1:${port}/`;
    console.log(`skill-scout dashboard: ${link}  (Ctrl+C to stop)`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    if (!o['no-open']) try { spawn(opener, [link], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser */ }
  });
  return server;
}

module.exports = { start };
