'use strict';
// Inventory, risk audit, removal, quarantine and restore of installed
// skills and MCP servers (Claude Code + Codex, user + project scope).
//
// Removal defaults to QUARANTINE: the skill folder / MCP config is moved to
// ~/.skill-scout/quarantine with a manifest, so `restore` can undo it.
// `--delete` removes permanently.
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const { scanSkillDir } = require('./security');
const { HOME, DATA_DIR, exists } = require('./util');

const CODEX_HOME = () => process.env.CODEX_HOME || path.join(HOME, '.codex');
const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, obj) {
  if (exists(p)) fs.copyFileSync(p, `${p}.bak-skill-scout`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// ------------------------------ config locations ------------------------------
// Windows paths are case-insensitive.
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => norm(a) === norm(b);
// When the working folder IS the home folder, "project" locations are the
// user locations – list them once, as user scope.
const dropProjectDupes = (list, key) => list.filter((x) => x.scope !== 'project' || !list.some((u) => u.scope === 'user' && u.agent === x.agent && samePath(u[key], x[key])));

function skillBases(cwd) {
  return dropProjectDupes([
    { agent: 'claude', scope: 'user', dir: path.join(HOME, '.claude', 'skills') },
    { agent: 'claude', scope: 'project', dir: path.join(cwd, '.claude', 'skills') },
    { agent: 'codex', scope: 'user', dir: path.join(CODEX_HOME(), 'skills') },
    { agent: 'codex', scope: 'project', dir: path.join(cwd, '.agents', 'skills') },
  ], 'dir');
}
const codexConfigs = (cwd) => dropProjectDupes([
  { agent: 'codex', scope: 'user', file: path.join(CODEX_HOME(), 'config.toml') },
  { agent: 'codex', scope: 'project', file: path.join(cwd, '.codex', 'config.toml') },
], 'file');
const claudeUserFile = () => path.join(HOME, '.claude.json');

// ----------------------------------- TOML -----------------------------------
// Minimal handling of [mcp_servers.<name>] tables (and their sub-tables such as
// [mcp_servers.<name>.env]) – enough to list, cut out and re-append a server.
const tomlHeader = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(\.[^\]]*)?\s*\]\s*$/;

function codexServers(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(tomlHeader);
    if (m && !m[3]) names.push(m[1] || m[2]);
  }
  return [...new Set(names)];
}

// Returns { text, block } with every table belonging to `name` removed.
function cutCodexServer(text, name) {
  const lines = text.split(/\r?\n/);
  const keep = [];
  const cut = [];
  let inside = false;
  for (const line of lines) {
    const header = /^\s*\[/.test(line);
    if (header) {
      const m = line.match(tomlHeader);
      inside = !!m && (m[1] || m[2]) === name;
    }
    (inside ? cut : keep).push(line);
  }
  return { text: keep.join('\n').replace(/\n{3,}/g, '\n\n'), block: cut.join('\n').trim() + '\n' };
}

function parseCodexBlock(block) {
  const str = (key) => { const m = block.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm')); return m && m[1]; };
  const argsM = block.match(/^\s*args\s*=\s*\[([^\]]*)\]/m);
  const args = argsM ? [...argsM[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]) : [];
  return { command: str('command'), args, url: str('url') };
}

// --------------------------------- inventory ---------------------------------
function inventory(cwd = process.cwd()) {
  const items = [];
  for (const b of skillBases(cwd)) {
    let names = [];
    try { names = fs.readdirSync(b.dir); } catch { continue; }
    for (const n of names) {
      const dir = path.join(b.dir, n);
      if (exists(path.join(dir, 'SKILL.md'))) items.push({ kind: 'skill', agent: b.agent, scope: b.scope, name: n, path: dir });
    }
  }
  const user = readJson(claudeUserFile());
  const addClaude = (servers, scope, file, projectKey) => {
    for (const [n, cfg] of Object.entries(servers || {})) items.push({ kind: 'mcp', agent: 'claude', scope, name: n, file, projectKey, config: cfg });
  };
  if (user) {
    addClaude(user.mcpServers, 'user', claudeUserFile());
    const projKey = user.projects && Object.keys(user.projects).find((k) => samePath(k, cwd));
    if (projKey) addClaude(user.projects[projKey].mcpServers, 'local', claudeUserFile(), projKey);
  }
  const mcpJson = readJson(path.join(cwd, '.mcp.json'));
  if (mcpJson) addClaude(mcpJson.mcpServers, 'project', path.join(cwd, '.mcp.json'));
  for (const cf of codexConfigs(cwd)) {
    if (!exists(cf.file)) continue;
    const text = fs.readFileSync(cf.file, 'utf8');
    for (const n of codexServers(text)) {
      items.push({ kind: 'mcp', agent: 'codex', scope: cf.scope, name: n, file: cf.file, config: parseCodexBlock(cutCodexServer(text, n).block) });
    }
  }
  return items.map((it) => ({ ...it, key: `${it.agent}:${it.kind}:${it.scope}:${it.name}` }));
}

// ----------------------------------- risk -----------------------------------
// Package an MCP server launches, e.g. `npx -y @scope/pkg@1.2` → npm @scope/pkg.
function mcpPackage(cfg) {
  const cmd = String(cfg.command || '').split(/[\\/]/).pop().replace(/\.(cmd|exe)$/i, '').toLowerCase();
  const args = cfg.args || [];
  const eco = { npx: 'npm', bunx: 'npm', pnpm: 'npm', uvx: 'PyPI', pipx: 'PyPI' }[cmd];
  if (!eco) return null;
  const from = args.indexOf('--from');
  const raw = from >= 0 ? args[from + 1] : args.find((a) => !a.startsWith('-') && a !== 'dlx' && a !== 'run');
  if (!raw || /^(git\+|https?:)/.test(raw)) return raw ? { ecosystem: 'git', name: raw } : null;
  const name = raw.startsWith('@') ? '@' + raw.slice(1).split('@')[0] : raw.split('@')[0].split('==')[0];
  return { ecosystem: eco, name };
}

function catalogMatch(it) {
  const cfg = it.config || {};
  const pkg = mcpPackage(cfg);
  return catalog.all().find((c) => c.type === 'mcp' && (
    c.id === it.name ||
    (cfg.url && c.install.url && cfg.url.replace(/\/+$/, '').split('?')[0] === c.install.url.replace(/\/+$/, '').split('?')[0]) ||
    (pkg && (c.packages || []).some((p) => p.name === pkg.name))
  )) || null;
}

function riskOf(it) {
  if (it.kind === 'skill') {
    const scan = scanSkillDir(it.path);
    const top = scan.summary.filter((g) => g.severity !== 'low').slice(0, 3).map((g) => `${g.msg} (${g.count}x, e.g. ${g.examples[0].file}:${g.examples[0].line})`);
    return { level: scan.level, reasons: top.length ? top : ['No suspicious patterns'], source: 'scan' };
  }
  const cfg = it.config || {};
  const pkg = mcpPackage(cfg);
  if (pkg) {
    const bl = catalog.blocklisted(pkg.ecosystem, pkg.name);
    if (bl) return { level: 'blocked', reasons: [bl.reason], source: 'blocklist' };
  }
  const match = catalogMatch(it);
  if (match) {
    return {
      level: match.deprecated ? 'high' : match.security.level, catalogId: match.id, source: 'catalog',
      // HIGH because of what it can access, not because it is malicious.
      official: !!match.official && !match.deprecated,
      reasons: [...(match.deprecated ? ['Deprecated / archived – no more security fixes'] : []), ...match.security.risks.slice(0, 2)],
    };
  }
  const what = pkg ? `${pkg.ecosystem}:${pkg.name}` : cfg.url || cfg.command || 'unknown';
  const hint = pkg && pkg.ecosystem === 'npm' ? ` – audit with: skill-scout check npm:${pkg.name}` : '';
  return { level: 'unknown', reasons: [`Not in the vetted catalog (${what})${hint}`], source: 'none' };
}

const LEVEL_RANK = { blocked: 4, high: 3, unknown: 2, medium: 1, low: 0 };

function audit(cwd = process.cwd()) {
  return inventory(cwd).map((it) => ({ ...it, risk: riskOf(it) }))
    .sort((a, b) => LEVEL_RANK[b.risk.level] - LEVEL_RANK[a.risk.level] || a.name.localeCompare(b.name));
}

// ------------------------------ remove / restore ------------------------------
function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
    fs.cpSync(from, to, { recursive: true }); // different drive (e.g. D: → C:)
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// Only ever delete a direct child of a known skills folder.
function assertSkillPath(it, cwd) {
  const parent = path.resolve(path.dirname(it.path));
  const ok = skillBases(cwd).some((b) => samePath(b.dir, parent)) && path.basename(it.path) === it.name && !/[\\/]/.test(it.name);
  if (!ok) throw new Error(`Refusing to touch unexpected path ${it.path}`);
}

function removeMcpConfig(it) {
  if (it.agent === 'codex') {
    const text = fs.readFileSync(it.file, 'utf8');
    const { text: rest, block } = cutCodexServer(text, it.name);
    fs.copyFileSync(it.file, `${it.file}.bak-skill-scout`);
    fs.writeFileSync(it.file, rest);
    return { tomlBlock: block };
  }
  const cfg = readJson(it.file);
  const holder = it.scope === 'local' ? cfg.projects[it.projectKey] : cfg;
  const config = holder.mcpServers[it.name];
  delete holder.mcpServers[it.name];
  writeJson(it.file, cfg);
  return { config };
}

function remove(it, { permanent = false, reason = '', cwd = process.cwd() } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const qdir = path.join(QUARANTINE_DIR, `${stamp}_${it.agent}_${it.kind}_${it.name.replace(/[^\w.-]/g, '_')}`);
  const manifest = { id: path.basename(qdir), kind: it.kind, agent: it.agent, scope: it.scope, name: it.name, removedAt: new Date().toISOString(), reason, risk: it.risk && it.risk.level };
  if (it.kind === 'skill') {
    assertSkillPath(it, cwd);
    manifest.originalPath = it.path;
    if (permanent) fs.rmSync(it.path, { recursive: true, force: true });
    else moveDir(it.path, path.join(qdir, 'files'));
  } else {
    Object.assign(manifest, { file: it.file, projectKey: it.projectKey }, removeMcpConfig(it));
  }
  if (permanent) return { permanent: true, ...manifest };
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(path.join(qdir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function listQuarantine() {
  let dirs = [];
  try { dirs = fs.readdirSync(QUARANTINE_DIR); } catch { return []; }
  return dirs.map((d) => readJson(path.join(QUARANTINE_DIR, d, 'manifest.json'))).filter(Boolean).sort((a, b) => b.removedAt.localeCompare(a.removedAt));
}

function restore(id) {
  const qdir = path.join(QUARANTINE_DIR, path.basename(id));
  const m = readJson(path.join(qdir, 'manifest.json'));
  if (!m) throw new Error(`Nothing in quarantine with id "${id}". See: skill-scout quarantine`);
  if (m.kind === 'skill') {
    if (exists(m.originalPath)) throw new Error(`${m.originalPath} already exists – remove it first`);
    moveDir(path.join(qdir, 'files'), m.originalPath);
  } else if (m.agent === 'codex') {
    const text = exists(m.file) ? fs.readFileSync(m.file, 'utf8') : '';
    if (codexServers(text).includes(m.name)) throw new Error(`"${m.name}" is already configured in ${m.file}`);
    fs.mkdirSync(path.dirname(m.file), { recursive: true });
    fs.writeFileSync(m.file, text ? `${text.replace(/\n*$/, '\n')}\n${m.tomlBlock}` : m.tomlBlock);
  } else {
    const cfg = readJson(m.file) || {};
    const holder = m.scope === 'local' ? ((cfg.projects = cfg.projects || {})[m.projectKey] = cfg.projects[m.projectKey] || {}) : cfg;
    holder.mcpServers = holder.mcpServers || {};
    if (holder.mcpServers[m.name]) throw new Error(`"${m.name}" is already configured in ${m.file}`);
    holder.mcpServers[m.name] = m.config;
    writeJson(m.file, cfg);
  }
  fs.rmSync(qdir, { recursive: true, force: true });
  return m;
}

// Find installed items by name (optionally filtered by agent/scope/kind).
function find(name, { agent, scope, kind, cwd = process.cwd() } = {}) {
  return inventory(cwd).filter((it) => it.name === name && (!agent || agent === 'both' || it.agent === agent) && (!scope || it.scope === scope) && (!kind || it.kind === kind));
}

module.exports = { inventory, audit, riskOf, remove, restore, listQuarantine, find, cutCodexServer, codexServers, mcpPackage, LEVEL_RANK, QUARANTINE_DIR };
