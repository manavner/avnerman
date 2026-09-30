'use strict';
// Audit / remove / quarantine / restore against a fake home folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-manage-'));
const proj = path.join(home, 'proj');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILL_SCOUT_HOME = path.join(home, '.skill-scout');
delete process.env.CODEX_HOME;

const fixtures = path.join(__dirname, 'fixtures');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
fs.mkdirSync(path.join(home, '.codex', 'skills'), { recursive: true });
fs.cpSync(path.join(fixtures, 'evil-skill'), path.join(home, '.claude', 'skills', 'evil-skill'), { recursive: true });
fs.cpSync(path.join(fixtures, 'good-skill'), path.join(home, '.codex', 'skills', 'good-skill'), { recursive: true });
const claudeJson = path.join(home, '.claude.json');
fs.writeFileSync(claudeJson, JSON.stringify({
  numStartups: 7,
  mcpServers: { postmark: { command: 'npx', args: ['-y', 'postmark-mcp@1.0.16'] }, docs: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
  projects: { [proj]: { mcpServers: { mystery: { command: 'npx', args: ['-y', '@someone/mystery-mcp'] } } } },
}));
fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { pw: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } }));
const codexToml = path.join(home, '.codex', 'config.toml');
const originalToml = 'model = "gpt-5"\n\n[mcp_servers.pg]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-postgres", "x"]\n\n[mcp_servers.pg.env]\nA = "1"\n\n[mcp_servers."gh"]\nurl = "https://api.githubcopilot.com/mcp/"\n\n[profiles.fast]\nmodel = "o4"\n';
fs.writeFileSync(codexToml, originalToml);

const manage = require('../lib/manage');
const byName = (rows, n) => rows.find((r) => r.name === n);

test('audit finds every skill and MCP server with the right risk', () => {
  const rows = manage.audit(proj);
  assert.deepStrictEqual(rows.map((r) => r.name).sort(), ['docs', 'evil-skill', 'gh', 'good-skill', 'mystery', 'pg', 'postmark', 'pw']);
  assert.strictEqual(byName(rows, 'postmark').risk.level, 'blocked');
  assert.strictEqual(byName(rows, 'evil-skill').risk.level, 'high');
  assert.strictEqual(byName(rows, 'pg').risk.level, 'high', 'deprecated postgres server');
  assert.strictEqual(byName(rows, 'gh').risk.level, 'high');
  assert.strictEqual(byName(rows, 'gh').risk.official, true);
  assert.strictEqual(byName(rows, 'mystery').risk.level, 'unknown');
  assert.strictEqual(byName(rows, 'mystery').scope, 'local');
  assert.strictEqual(byName(rows, 'docs').risk.catalogId, 'context7', 'matched by URL, not name');
  assert.strictEqual(byName(rows, 'pw').risk.catalogId, 'playwright', 'matched by npm package');
  assert.strictEqual(rows[0].risk.level, 'blocked', 'riskiest first');
});

test('running from the home folder does not list everything twice', () => {
  const rows = manage.inventory(home);
  const keys = rows.map((r) => `${r.agent}:${r.kind}:${r.name}`);
  assert.strictEqual(new Set(keys).size, keys.length, `duplicates: ${keys.join(', ')}`);
  assert.strictEqual(rows.find((r) => r.name === 'evil-skill').scope, 'user');
  assert.strictEqual(rows.find((r) => r.name === 'pg').scope, 'user');
});

test('quarantine + restore a Claude MCP server keeps the rest of ~/.claude.json', () => {
  const [it] = manage.find('postmark', { cwd: proj });
  const m = manage.remove(it, { cwd: proj });
  let cfg = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  assert.ok(!cfg.mcpServers.postmark);
  assert.strictEqual(cfg.numStartups, 7);
  assert.ok(manage.listQuarantine().some((q) => q.id === m.id));
  manage.restore(m.id);
  cfg = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  assert.deepStrictEqual(cfg.mcpServers.postmark.args, ['-y', 'postmark-mcp@1.0.16']);
  assert.strictEqual(manage.listQuarantine().length, 0);
});

test('local-scope and project-scope Claude servers are removed from the right file', () => {
  manage.remove(manage.find('mystery', { cwd: proj })[0], { cwd: proj });
  manage.remove(manage.find('pw', { cwd: proj })[0], { cwd: proj });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[proj].mcpServers, {});
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8')).mcpServers, {});
  for (const q of manage.listQuarantine()) manage.restore(q.id);
  assert.ok(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[proj].mcpServers.mystery);
  assert.ok(JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8')).mcpServers.pw);
});

test('Codex server is cut with its sub-tables and restored; other settings untouched', () => {
  const m = manage.remove(manage.find('pg', { agent: 'codex', cwd: proj })[0], { cwd: proj });
  const after = fs.readFileSync(codexToml, 'utf8');
  assert.ok(!after.includes('mcp_servers.pg'));
  assert.ok(after.includes('[mcp_servers."gh"]') && after.includes('[profiles.fast]') && after.includes('model = "gpt-5"'));
  manage.restore(m.id);
  const restored = fs.readFileSync(codexToml, 'utf8');
  assert.ok(restored.includes('[mcp_servers.pg]') && restored.includes('[mcp_servers.pg.env]'));
  assert.deepStrictEqual(manage.codexServers(restored).sort(), ['gh', 'pg']);
});

test('skill quarantine moves the folder away and back', () => {
  const dir = path.join(home, '.claude', 'skills', 'evil-skill');
  const m = manage.remove(manage.find('evil-skill', { cwd: proj })[0], { cwd: proj });
  assert.ok(!fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(manage.QUARANTINE_DIR, m.id, 'files', 'SKILL.md')));
  manage.restore(m.id);
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
});

test('permanent delete removes the skill and leaves no quarantine entry', () => {
  manage.remove(manage.find('good-skill', { cwd: proj })[0], { permanent: true, cwd: proj });
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'skills', 'good-skill')));
  assert.strictEqual(manage.listQuarantine().length, 0);
});

test('refuses to delete anything outside the skills folders', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-outside-'));
  fs.writeFileSync(path.join(outside, 'SKILL.md'), 'x');
  assert.throws(() => manage.remove({ kind: 'skill', agent: 'claude', scope: 'user', name: path.basename(outside), path: outside }, { permanent: true, cwd: proj }), /Refusing/);
  assert.ok(fs.existsSync(outside));
});

test('package detection for npx / uvx launch commands', () => {
  assert.deepStrictEqual(manage.mcpPackage({ command: 'npx', args: ['-y', '@scope/pkg@1.2.3'] }), { ecosystem: 'npm', name: '@scope/pkg' });
  assert.deepStrictEqual(manage.mcpPackage({ command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', 'firecrawl-mcp'] }), { ecosystem: 'npm', name: 'firecrawl-mcp' });
  assert.deepStrictEqual(manage.mcpPackage({ command: 'uvx', args: ['mcp-server-git'] }), { ecosystem: 'PyPI', name: 'mcp-server-git' });
  assert.strictEqual(manage.mcpPackage({ command: 'uvx', args: ['--from', 'git+https://github.com/x/y', 'y'] }).ecosystem, 'git');
  assert.strictEqual(manage.mcpPackage({ command: 'node', args: ['server.js'] }), null);
});

test('node_repl is recognised as part of Codex, not UNKNOWN', () => {
  fs.appendFileSync(codexToml, '\n[mcp_servers.node_repl]\ncommand = \'C:\\Program Files\\Codex\\node.exe\'\nargs = ["repl.js"]\n\n[mcp_servers.node_repl.env]\nX = "1"\n');
  const r = byName(manage.audit(proj), 'node_repl');
  assert.strictEqual(r.risk.level, 'low');
  assert.strictEqual(r.risk.source, 'builtin');
  assert.strictEqual(r.config.command, 'C:\\Program Files\\Codex\\node.exe', 'single-quoted TOML strings are parsed');
});

test('trusting a HIGH skill silences it until its files change', () => {
  const [it] = manage.find('evil-skill', { cwd: proj });
  manage.trust(it, 'reviewed');
  let rows = manage.audit(proj);
  let r = byName(rows, 'evil-skill');
  assert.ok(r.risk.trusted);
  assert.strictEqual(r.risk.level, 'high', 'the real level is kept');
  assert.strictEqual(manage.needsAttention(r.risk), false);
  assert.strictEqual(rows[rows.length - 1].name, 'evil-skill', 'trusted items sort last');
  fs.appendFileSync(path.join(it.path, 'SKILL.md'), '\nsneaky new line\n');
  r = byName(manage.audit(proj), 'evil-skill');
  assert.ok(!r.risk.trusted);
  assert.ok(r.risk.trustBroken);
  assert.match(r.risk.reasons[0], /CHANGED since you trusted it/);
  assert.strictEqual(manage.needsAttention(r.risk), true);
});

test('trusting an MCP server is tied to its config', () => {
  manage.trust(manage.find('gh', { agent: 'codex', cwd: proj })[0]);
  assert.ok(byName(manage.audit(proj), 'gh').risk.trusted);
  fs.writeFileSync(codexToml, fs.readFileSync(codexToml, 'utf8').replace('https://api.githubcopilot.com/mcp/', 'https://evil.example/mcp'));
  assert.ok(byName(manage.audit(proj), 'gh').risk.trustBroken);
});

test('quarantine keeps trust, permanent delete and untrust drop it', () => {
  const [pw] = manage.find('pw', { cwd: proj });
  manage.trust(pw);
  const m = manage.remove(pw, { cwd: proj });
  assert.ok(manage.listTrusted().some((t) => t.name === 'pw'));
  manage.restore(m.id);
  assert.ok(byName(manage.audit(proj), 'pw').risk.trusted, 'restored item is still trusted');
  manage.remove(manage.find('pw', { cwd: proj })[0], { permanent: true, cwd: proj });
  assert.ok(!manage.listTrusted().some((t) => t.name === 'pw'));
  const [ev] = manage.find('evil-skill', { cwd: proj });
  assert.strictEqual(manage.untrust(ev.key), true);
  assert.ok(!manage.listTrusted().some((t) => t.name === 'evil-skill'));
});
