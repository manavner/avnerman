'use strict';
// Periodic "what's new" scan. Compares against the previous snapshot and reports:
//  - new MCP servers in the official registry that have real traction (GitHub stars)
//  - new / fast-rising skill & MCP repositories on GitHub
//  - NEW security findings for things you already have installed (the important part)
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const src = require('./sources');
const { assess, scanSkillDir } = require('./security');
const { listInstalled, skillDirs } = require('./install');
const { DATA_DIR, LEVEL_ORDER, fetchJson, githubHeaders, setCache } = require('./util');

const SNAP_FILE = path.join(DATA_DIR, 'snapshot.json');
const REPORT_DIR = path.join(DATA_DIR, 'reports');
const DAY = 24 * 3600 * 1000;

function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8')); } catch { return null; }
}

// Registry entries published/updated since `since`, newest versions only.
async function registrySince(since, maxPages = 10) {
  const out = new Map();
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const url = `https://registry.modelcontextprotocol.io/v0/servers?limit=100&updated_since=${encodeURIComponent(since)}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
    const r = await fetchJson(url, { cache: false });
    if (!r || !r.servers) break;
    for (const { server, _meta } of r.servers) {
      const off = (_meta && _meta['io.modelcontextprotocol.registry/official']) || {};
      if (off.isLatest === false) continue;
      const repoUrl = server.repository && server.repository.url;
      const m = repoUrl && repoUrl.match(/github\.com\/([^/]+\/[^/#?]+)/);
      out.set(server.name, {
        name: server.name, title: server.title || server.name, description: server.description || '',
        repo: m ? m[1].replace(/\.git$/, '') : null, published: off.publishedAt,
      });
    }
    cursor = r.metadata && r.metadata.nextCursor;
    if (!cursor) break;
  }
  return [...out.values()];
}

async function githubSearch(q, perPage = 20) {
  const r = await fetchJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`, { headers: githubHeaders(), cache: false });
  return ((r && r.items) || []).map((x) => ({ repo: x.full_name, stars: x.stargazers_count, description: x.description || '', created: (x.created_at || '').slice(0, 10), archived: x.archived }));
}

const TOPICS = { mcp: ['mcp-server', 'model-context-protocol'], skill: ['claude-skills', 'agent-skills', 'claude-code-skills', 'codex-skills', 'claude-code-plugin'] };

async function scan(opts = {}) {
  setCache(false);
  try { return await runScan(opts); } finally { setCache(true); }
}

async function runScan({ minStars = 20, log = () => {} } = {}) {
  const prev = loadSnapshot();
  const now = new Date();
  const since = new Date(prev ? prev.date : now.getTime() - 7 * DAY).toISOString();
  const sinceDay = since.slice(0, 10);
  const report = { date: now.toISOString(), since, firstRun: !prev, newRegistry: [], newRepos: [], rising: [], security: [], skillChanges: [], errors: [] };
  // Start from the previous snapshot so an offline source doesn't erase its baseline.
  const snap = { date: now.toISOString(), registryNames: prev ? [...prev.registryNames] : [], stars: { ...(prev && prev.stars) }, findings: { ...(prev && prev.findings) }, skills: {} };
  const known = new Set(snap.registryNames);
  const catalogRepos = new Set(catalog.all().map((i) => i.repo).filter(Boolean));

  // 1. Official MCP registry – only items with a GitHub repo that people actually star.
  log('Checking the official MCP registry...');
  const reg = await registrySince(since);
  if (!reg.length) report.errors.push('MCP registry unreachable or no updates');
  const candidates = reg.filter((s) => !known.has(s.name) && s.repo && !catalogRepos.has(s.repo)).slice(0, 40);
  for (const s of candidates) {
    const gh = await src.githubRepo(s.repo);
    if (gh && gh.stars >= minStars && !gh.archived) report.newRegistry.push({ ...s, stars: gh.stars });
  }
  report.newRegistry.sort((a, b) => b.stars - a.stars).splice(15);
  report.registryTotal = reg.length;
  for (const s of reg) if (!known.has(s.name)) snap.registryNames.push(s.name);

  // 2. GitHub: brand-new repos since last scan, and rising stars among popular ones.
  log('Checking GitHub for new and rising skills / MCP servers...');
  for (const [kind, topics] of Object.entries(TOPICS)) {
    for (const t of topics) {
      for (const r of await githubSearch(`topic:${t} created:>=${sinceDay} stars:>=${Math.max(5, Math.floor(minStars / 2))}`, 10)) {
        if (!report.newRepos.some((x) => x.repo === r.repo)) report.newRepos.push({ ...r, kind });
      }
      for (const r of await githubSearch(`topic:${t} stars:>=200`, 50)) {
        snap.stars[r.repo] = r.stars;
        const before = prev && prev.stars[r.repo];
        if (before && r.stars - before >= Math.max(50, before * 0.1)) report.rising.push({ ...r, kind, gained: r.stars - before });
      }
    }
  }
  report.newRepos.sort((a, b) => b.stars - a.stars).splice(15);
  const seenRising = new Set();
  report.rising = report.rising.filter((r) => !seenRising.has(r.repo) && seenRising.add(r.repo)).sort((a, b) => b.gained - a.gained).slice(0, 10);
  if (!report.newRepos.length && !Object.keys(snap.stars).length) report.errors.push('GitHub API unreachable or rate-limited (set GITHUB_TOKEN)');

  // 3. Security: new warnings for installed catalog items.
  log('Re-checking the security of what you have installed...');
  const inst = listInstalled(process.cwd());
  const names = new Set([...inst.claudeMcp, ...inst.codexMcp, ...inst.claudeSkills, ...inst.codexSkills].map((n) => n.split(' ')[0]));
  for (const item of catalog.all().filter((i) => names.has(i.id))) {
    const a = await assess(item, { live: true });
    const keys = [...a.vulns.map((v) => v.id), ...a.advisories.map((v) => v.id), ...a.userWarnings.map((w) => w.url)];
    snap.findings[item.id] = keys;
    const old = new Set((prev && prev.findings[item.id]) || []);
    const fresh = [
      ...a.vulns.filter((v) => !old.has(v.id)).map((v) => ({ kind: v.malicious ? 'MALICIOUS' : 'vulnerability', title: `${v.id} ${v.summary}`, url: v.url })),
      ...a.advisories.filter((v) => !old.has(v.id)).map((v) => ({ kind: `advisory (${v.severity})`, title: v.summary, url: v.url })),
      ...a.userWarnings.filter((w) => !old.has(w.url)).map((w) => ({ kind: 'user report', title: w.title, url: w.url })),
    ];
    if (a.level === 'blocked' || fresh.length) report.security.push({ id: item.id, name: item.name, level: a.level, items: fresh });
  }

  // 4. Installed skills: re-scan locally. Alert the first time a skill is HIGH,
  //    when its files change, or when its risk goes up – not every week.
  for (const base of skillDirs('both', 'user', process.cwd())) {
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch { continue; }
    for (const d of dirs) {
      const dir = path.join(base, d);
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
      const res = scanSkillDir(dir);
      snap.skills[dir] = { hash: res.hash, level: res.level };
      const before = prev && prev.skills && prev.skills[dir];
      const changed = !!before && before.hash !== res.hash;
      const escalated = !!before && LEVEL_ORDER[res.level] > LEVEL_ORDER[before.level];
      if (changed || escalated || (!before && res.level === 'high')) {
        const top = res.summary.filter((g) => g.severity === 'high').slice(0, 4)
          .map((g) => `${g.msg} (${g.count}x, e.g. ${g.examples[0].file}:${g.examples[0].line})`);
        report.skillChanges.push({ dir, level: res.level, changed, top });
      }
    }
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(SNAP_FILE, JSON.stringify(snap));
  const stamp = now.toISOString().slice(0, 10);
  fs.writeFileSync(path.join(REPORT_DIR, `${stamp}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(REPORT_DIR, `${stamp}.md`), toMarkdown(report));
  return report;
}

function toMarkdown(r) {
  const L = [`# Skill Scout – weekly report ${r.date.slice(0, 10)}`, '', `Changes since ${r.since.slice(0, 10)}${r.firstRun ? ' (first scan – baseline created)' : ''}.`, ''];
  L.push('## ⚠️ Security of what you have installed', '');
  if (!r.security.length && !r.skillChanges.length) L.push('No new warnings. ✅');
  for (const s of r.security) {
    L.push(`### ${s.name} (${s.id}) – risk ${s.level.toUpperCase()}`);
    s.items.forEach((i) => L.push(`- **${i.kind}**: ${i.title} – ${i.url}`));
  }
  for (const s of r.skillChanges) {
    L.push(`- Skill \`${s.dir}\`: ${s.changed ? 'files CHANGED since last scan, ' : ''}risk ${s.level.toUpperCase()} – details: \`skill-scout check "${s.dir}"\``);
    (s.top || []).forEach((t) => L.push(`  - ${t}`));
  }
  L.push('', '## 🆕 New in the official MCP registry (with GitHub traction)', '');
  if (!r.newRegistry.length) L.push('Nothing notable.');
  r.newRegistry.forEach((s) => L.push(`- **${s.title}** ★${s.stars} – ${s.description} (github:${s.repo})`));
  L.push('', '## 🌱 New repositories on GitHub', '');
  if (!r.newRepos.length) L.push('Nothing notable.');
  r.newRepos.forEach((x) => L.push(`- [${x.kind}] **${x.repo}** ★${x.stars} (created ${x.created}) – ${x.description}`));
  L.push('', '## 📈 Rising fast', '');
  if (!r.rising.length) L.push(r.firstRun ? 'Available from the next scan.' : 'Nothing notable.');
  r.rising.forEach((x) => L.push(`- [${x.kind}] **${x.repo}** ★${x.stars} (+${x.gained})`));
  if (r.errors.length) L.push('', '## Notes', '', ...r.errors.map((e) => `- ${e}`));
  L.push('', '> New items are NOT vetted. Audit before installing: `skill-scout check github:owner/repo`');
  return L.join('\n') + '\n';
}

function latestReport() {
  try {
    const f = fs.readdirSync(REPORT_DIR).filter((n) => n.endsWith('.json')).sort().pop();
    return f ? JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), 'utf8')) : null;
  } catch { return null; }
}

function summaryLine(r) {
  const sec = r.security.reduce((n, s) => n + s.items.length, 0) + r.skillChanges.length;
  return `${sec ? `⚠ ${sec} security alert(s). ` : ''}${r.newRegistry.length + r.newRepos.length} new, ${r.rising.length} rising.`;
}

module.exports = { scan, latestReport, toMarkdown, summaryLine, REPORT_DIR };
