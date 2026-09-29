#!/usr/bin/env node
'use strict';
const path = require('path');
const readline = require('readline');
const catalog = require('../lib/catalog');
const src = require('../lib/sources');
const { assess, scanSkillDir } = require('../lib/security');
const { recommend, top } = require('../lib/recommend');
const { detectProject, tagsFromText } = require('../lib/detect');
const installer = require('../lib/install');
const { c, levelBadge, exists } = require('../lib/util');

const HELP = `
${c.bold('skill-scout')} – find, vet and install the best Skills & MCP servers for Claude Code and Codex

${c.bold('Usage')}
  skill-scout top [--type mcp|skill] [--live]         Best-rated items overall
  skill-scout recommend [dir] [--describe "text"]     What to install for a project (default: current dir)
  skill-scout search <words> [--live]                 Search catalog + official MCP registry (+ GitHub with --live)
  skill-scout info <id>                               Full details, risks and live security check
  skill-scout check <id | npm:pkg | github:owner/repo[/path] | ./local/dir>
                                                      Security audit (vulnerabilities, user warnings, skill scan)
  skill-scout install <id | github:owner/repo/path>   Install after showing risks and asking you
  skill-scout installed                               What is already installed (Claude Code + Codex)
  skill-scout ui [--port 4477]                        Open the web dashboard
  skill-scout setup                                   Install the "skill-advisor" skill into Claude Code & Codex
  skill-scout scan [--notify]                         Look for NEW skills/MCP servers + new security alerts since last scan
  skill-scout news                                    Show the latest scan report
  skill-scout schedule [--day SUN] [--time 10:00]     Run the scan automatically every week (Windows Task Scheduler)
  skill-scout schedule --status | --remove            Check or remove the weekly scan

${c.bold('Options')}
  --for claude|codex|both   Target agent (default: both)
  --scope user|project      user = all projects (default), project = only this folder
  --live                    Fetch live stars/downloads/advisories (set GITHUB_TOKEN for higher limits)
  --json                    Machine-readable output (used by the advisor skill)
  --dry-run                 Show what would change without changing anything
  --yes                     Don't ask for confirmation (not recommended)
  --set KEY=VALUE           Value for a required argument (e.g. --set ALLOWED_DIR=~/code)
`;

function parseArgs(argv) {
  const opts = { _: [], set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const key = a.slice(2);
    if (['live', 'json', 'dry-run', 'yes', 'force', 'offline', 'no-open', 'scan', 'help', 'notify', 'remove', 'status'].includes(key)) { opts[key] = true; continue; }
    const val = argv[++i];
    if (key === 'set') { const [k, ...v] = (val || '').split('='); opts.set[k] = v.join('='); } else opts[key] = val;
  }
  opts.target = opts.for || 'both';
  opts.scope = opts.scope || 'user';
  if (!['claude', 'codex', 'both'].includes(opts.target)) throw new Error('--for must be claude, codex or both');
  if (!['user', 'project'].includes(opts.scope)) throw new Error('--scope must be user or project');
  return opts;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(`${question} [y/N] `, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())); }));
}

const typeLabel = (t) => ({ mcp: c.blue('MCP   '), skill: c.magenta('SKILL '), plugin: c.cyan('PLUGIN') }[t] || t);
const verdictColor = (v) => (v === 'RECOMMENDED' ? c.green(v) : v === 'AVOID' ? c.red(v) : v === 'USE WITH CARE' ? c.yellow(v) : v);

function printRow(r, i) {
  const pop = [];
  if (r.assessment.popularity.stars) pop.push(`★ ${r.assessment.popularity.stars.toLocaleString()}`);
  if (r.assessment.popularity.weeklyDownloads) pop.push(`⬇ ${r.assessment.popularity.weeklyDownloads.toLocaleString()}/wk`);
  console.log(`${String(i + 1).padStart(2)}. ${typeLabel(r.item.type)} ${c.bold(r.item.name)} ${c.dim('(' + r.item.id + ')')}  ${verdictColor(r.verdict)}`);
  console.log(`      ${r.item.description}`);
  console.log(`      Risk: ${levelBadge(r.assessment.level)}  Trust: ${r.assessment.trust}/100  Rating: ${'★'.repeat(r.item.rating)}${pop.length ? '  ' + pop.join('  ') : ''}  ${c.dim(r.item.publisher)}`);
  if (r.why) console.log(c.dim(`      Why: ${r.why.join(', ')}`));
  const warns = r.assessment.warnings.length + r.assessment.userWarnings.length + r.assessment.vulns.length;
  if (warns) console.log(c.yellow(`      ⚠ ${warns} security warning(s) – run: skill-scout info ${r.item.id}`));
}

const toJson = (rows) => rows.map((r) => ({
  id: r.item.id, type: r.item.type, name: r.item.name, publisher: r.item.publisher, official: r.item.official,
  description: r.item.description, verdict: r.verdict, score: r.score, why: r.why,
  risk: r.assessment.level, trust: r.assessment.trust, popularity: r.assessment.popularity,
  permissions: r.item.security.permissions, risks: r.item.security.risks, mitigations: r.item.security.mitigations,
  warnings: [...r.assessment.warnings, ...r.assessment.userWarnings, ...r.assessment.vulns], reasons: r.assessment.reasons,
  install: `skill-scout install ${r.item.id}`,
}));

// ---------------------------------------------------------------- commands --
async function cmdTop(o) {
  const rows = await top({ type: o.type, target: o.target, live: o.live, limit: Number(o.limit) || 15 });
  if (o.json) return console.log(JSON.stringify(toJson(rows), null, 2));
  console.log(c.bold(`\nTop ${o.type || 'skills & MCP servers'} for ${o.target === 'both' ? 'Claude Code + Codex' : o.target}\n`));
  rows.forEach(printRow);
  if (!o.live) console.log(c.dim('\nTip: add --live for current GitHub stars, npm downloads and advisories.'));
}

async function cmdRecommend(o) {
  const dir = path.resolve(o._[1] || '.');
  const tags = o.describe ? tagsFromText(o.describe) : new Map();
  if (!o.describe || o._[1]) for (const [t, why] of detectProject(dir)) if (!tags.has(t)) tags.set(t, why);
  const rows = await recommend(tags, { target: o.target, live: o.live, limit: Number(o.limit) || 12 });
  if (o.json) return console.log(JSON.stringify({ project: dir, detected: Object.fromEntries(tags), recommendations: toJson(rows) }, null, 2));
  console.log(c.bold(`\nProject: ${o.describe ? '"' + o.describe + '"' : dir}`));
  console.log(`Detected: ${[...tags.keys()].join(', ') || c.dim('nothing specific – showing general picks')}\n`);
  rows.forEach(printRow);
  const installed = installer.listInstalled(dir);
  const have = new Set([...installed.claudeMcp, ...installed.codexMcp, ...installed.claudeSkills, ...installed.codexSkills].map((n) => n.split(' ')[0]));
  const already = rows.filter((r) => have.has(r.item.id)).map((r) => r.item.id);
  if (already.length) console.log(c.green(`\nAlready installed: ${already.join(', ')}`));
  console.log(c.dim('\nInstall one with: skill-scout install <id>   (details first: skill-scout info <id>)'));
}

async function cmdSearch(o) {
  const q = o._.slice(1).join(' ');
  if (!q) throw new Error('Usage: skill-scout search <words>');
  const local = catalog.search(q);
  const [registry, gh] = await Promise.all([src.registrySearch(q, 15), o.live ? src.githubDiscover(o.type === 'skill' ? 'skill' : 'mcp', q) : []]);
  if (o.json) return console.log(JSON.stringify({ catalog: local.map((i) => i.id), registry, github: gh }, null, 2));
  console.log(c.bold(`\nVetted catalog (${local.length})`));
  local.forEach((i) => console.log(`  ${typeLabel(i.type)} ${c.bold(i.id.padEnd(22))} ${levelBadge(i.security.level).padEnd(8)} ${i.description.slice(0, 80)}`));
  if (registry.length) {
    console.log(c.bold(`\nOfficial MCP Registry (${registry.length}) – ${c.yellow('not vetted, check before installing')}`));
    registry.forEach((s) => console.log(`  ${c.bold(s.id)}  ${c.dim((s.description || '').slice(0, 90))}${s.repo ? c.dim('  github:' + s.repo) : ''}`));
  }
  if (gh.length) {
    console.log(c.bold(`\nGitHub by stars (${gh.length}) – ${c.yellow('not vetted')}`));
    gh.forEach((r) => console.log(`  ★ ${String(r.stars).padStart(6)}  ${c.bold(r.repo)}${r.archived ? c.red(' [archived]') : ''}  ${c.dim((r.description || '').slice(0, 80))}`));
  }
  console.log(c.dim('\nAudit anything with: skill-scout check github:owner/repo  or  npm:package'));
}

function printAssessment(a) {
  console.log(`\nRisk level: ${levelBadge(a.level)}   Trust score: ${a.trust}/100`);
  a.reasons.forEach((r) => console.log(`  • ${r}`));
  if (a.warnings.length) {
    console.log(c.bold(c.yellow('\nKnown security incidents / warnings')));
    a.warnings.forEach((w) => console.log(`  ⚠ ${w.date ? w.date + ' ' : ''}${w.title}${w.status ? c.dim(' [' + w.status + ']') : ''}${w.url ? '\n    ' + c.dim(w.url) : ''}`));
  }
  if (a.advisories.length) {
    console.log(c.bold(c.yellow('\nPublished security advisories')));
    a.advisories.forEach((v) => console.log(`  ⚠ ${v.date} ${v.severity.toUpperCase()} ${v.summary} ${c.dim(v.url)}`));
  }
  if (a.vulns.length) {
    console.log(c.bold(c.red('\nOpen vulnerabilities in latest version (OSV.dev)')));
    a.vulns.forEach((v) => console.log(`  ✖ ${v.id} ${v.summary} ${c.dim(v.url)}`));
  }
  if (a.userWarnings.length) {
    console.log(c.bold('\nUser reports mentioning security (GitHub issues)'));
    a.userWarnings.forEach((w) => console.log(`  ${w.state === 'open' ? c.yellow('open  ') : c.dim('closed')} ${w.date} ${w.title}\n         ${c.dim(w.url)}`));
  }
}

async function cmdInfo(o) {
  const item = catalog.get(o._[1]);
  if (!item) throw new Error(`Unknown id "${o._[1]}". Try: skill-scout search ${o._[1] || ''}`);
  const a = await assess(item, { live: !o.offline });
  if (o.json) return console.log(JSON.stringify({ item, assessment: a }, null, 2));
  const s = item.security;
  console.log(`\n${typeLabel(item.type)} ${c.bold(item.name)}  ${c.dim(item.id)}`);
  console.log(`${item.description}`);
  console.log(`Publisher: ${item.publisher}${item.official ? c.green(' (official)') : c.yellow(' (community)')}${item.repo ? '   https://github.com/' + item.repo : ''}`);
  if (a.popularity.stars) console.log(`Popularity: ★ ${a.popularity.stars.toLocaleString()} stars${a.popularity.weeklyDownloads ? `, ⬇ ${a.popularity.weeklyDownloads.toLocaleString()} npm downloads/week` : ''}`);
  console.log(c.bold('\nWhat it can access'));
  s.permissions.forEach((p) => console.log(`  • ${p}`));
  console.log(c.bold('\nRisks'));
  s.risks.forEach((r) => console.log(`  • ${r}`));
  if (s.mitigations.length) { console.log(c.bold('\nHow to use it safely')); s.mitigations.forEach((m) => console.log(`  ✓ ${m}`)); }
  printAssessment(a);
  console.log(c.dim(`\nInstall: skill-scout install ${item.id} [--for claude|codex] [--scope project]`));
}

async function cmdCheck(o) {
  const t = o._[1];
  if (!t) throw new Error('Usage: skill-scout check <id | npm:pkg | github:owner/repo[/path] | dir>');
  if (catalog.get(t)) return cmdInfo(o);
  if (t.startsWith('npm:')) {
    const name = t.slice(4);
    const bl = catalog.blocklisted('npm', name);
    if (bl) console.log(c.red(c.bold(`\n✖ BLOCKLISTED: ${bl.reason}`)));
    const [info, dl] = await Promise.all([src.npmInfo(name), src.npmWeeklyDownloads(name)]);
    if (!info) return console.log(c.yellow('Could not reach npm (offline?) or package does not exist.'));
    const vulns = (await src.osvVulns('npm', name, info.latest)) || [];
    console.log(`\n${c.bold(name)}@${info.latest}  ⬇ ${dl ?? '?'} /week  maintainers: ${info.maintainers}  first published: ${(info.created || '').slice(0, 10)}`);
    if (info.deprecated) console.log(c.red(`  Deprecated: ${info.deprecated}`));
    if (info.installScripts.length) console.log(c.yellow(`  Runs install scripts: ${info.installScripts.join('; ')}`));
    if (dl !== null && dl < 100) console.log(c.yellow('  Very few downloads – little community vetting.'));
    catalog.globalWarningsFor('npm', name).forEach((w) => console.log(c.yellow(`  ⚠ ${w.title}`)));
    vulns.forEach((v) => console.log(`  ${v.malicious ? c.red('MALICIOUS') : c.yellow('VULN')} ${v.id} ${v.summary}`));
    if (!vulns.length && !bl) console.log(c.green('  No known vulnerabilities in the latest version (OSV.dev).'));
    return;
  }
  if (t.startsWith('github:') || t.startsWith('https://github.com/')) {
    const parts = t.replace(/^github:|^https:\/\/github.com\//, '').replace(/\/tree\/[^/]+/, '').split('/');
    const repo = parts.slice(0, 2).join('/');
    const sub = parts.slice(2).join('/');
    const [gh, userWarnings, advisories] = await Promise.all([src.githubRepo(repo), src.githubUserWarnings(repo), src.githubAdvisories(repo)]);
    if (gh) console.log(`\n${c.bold(repo)}  ★ ${gh.stars}  license: ${gh.license || c.yellow('none')}  last push: ${(gh.pushedAt || '').slice(0, 10)}${gh.archived ? c.red('  ARCHIVED') : ''}  owner: ${gh.owner} (${gh.ownerType})`);
    else console.log(c.yellow('Could not reach the GitHub API (offline or rate-limited; set GITHUB_TOKEN).'));
    printAssessment({ level: 'n/a', trust: '–', reasons: [], warnings: [], advisories, vulns: [], userWarnings });
    if (sub || o.scan) {
      const { dir, tmp } = installer.fetchRepoPath(repo, sub, null, console.log);
      try { printScan(scanSkillDir(dir)); } finally { require('fs').rmSync(tmp, { recursive: true, force: true }); }
    }
    return;
  }
  if (exists(t)) return printScan(scanSkillDir(path.resolve(t)));
  throw new Error(`Don't know how to check "${t}"`);
}

function printScan(scan) {
  console.log(`\nSkill scan: ${scan.files} files → risk ${levelBadge(scan.level)}`);
  if (!scan.findings.length) console.log(c.green('  No suspicious patterns found.'));
  scan.findings.forEach((f) => console.log(`  ${f.severity === 'high' ? c.red('HIGH') : f.severity === 'medium' ? c.yellow('MED ') : c.dim('LOW ')} ${f.file}:${f.line}  ${f.msg}${f.text ? c.dim('  → ' + f.text) : ''}`));
  console.log(c.dim('  (Pattern scanning catches common tricks, not everything – read SKILL.md before trusting a skill.)'));
}

async function cmdInstall(o) {
  const id = o._[1];
  if (!id) throw new Error('Usage: skill-scout install <id | github:owner/repo/path>');
  const opts = {
    target: o.target, scope: o.scope, dryRun: o['dry-run'], values: o.set, cwd: process.cwd(), force: o.force,
    log: console.log, confirm: o.yes ? async () => true : ask,
  };
  if (id.startsWith('github:')) {
    const parts = id.slice(7).split('/');
    console.log(c.yellow('Installing an unvetted skill from GitHub – it will be scanned first.'));
    const ok = await installer.installSkill({ repo: parts.slice(0, 2).join('/'), path: parts.slice(2).join('/') }, opts);
    return finish(ok, opts);
  }
  const item = catalog.get(id);
  if (!item) throw new Error(`Unknown id "${id}"`);
  const a = await assess(item, { live: !o.offline });
  console.log(`\n${typeLabel(item.type)} ${c.bold(item.name)} → ${o.target === 'both' ? 'Claude Code + Codex' : o.target} (${o.scope} scope)`);
  printAssessment(a);
  console.log(c.bold('\nRisks'));
  item.security.risks.forEach((r) => console.log(`  • ${r}`));
  item.security.mitigations.forEach((m) => console.log(c.green(`  ✓ ${m}`)));
  if (a.level === 'blocked') { console.log(c.red('\n✖ Installation refused: this item is blocked.')); process.exitCode = 1; return; }
  if (item.deprecated && !o.force) { console.log(c.red('\n✖ Deprecated. Use --force if you really need it.')); process.exitCode = 1; return; }
  if (!o['dry-run'] && !(await opts.confirm(`\nInstall ${item.name}?`))) return console.log('Cancelled.');
  finish(await installer.install(item, opts), opts);
}

function finish(ok, opts) {
  console.log(ok ? c.green(`\n✓ Done${opts.dryRun ? ' (dry run – nothing changed)' : ''}. Restart Claude Code / Codex to load it.`) : c.red('\n✖ Not installed.'));
  if (!ok) process.exitCode = 1;
}

function cmdInstalled(o) {
  const r = installer.listInstalled(process.cwd());
  if (o.json) return console.log(JSON.stringify(r, null, 2));
  const show = (title, list) => console.log(`${c.bold(title)}: ${list.length ? list.join(', ') : c.dim('none')}`);
  show('Claude Code MCP servers', r.claudeMcp); show('Claude Code skills', r.claudeSkills);
  show('Codex MCP servers', r.codexMcp); show('Codex skills', r.codexSkills);
  console.log(c.dim('(Claude Code plugins: run /plugin inside Claude Code)'));
}

async function cmdSetup(o) {
  const fs = require('fs');
  const from = path.join(__dirname, '..', 'advisor-skill', 'skill-advisor');
  for (const base of installer.skillDirs(o.target, o.scope, process.cwd())) {
    const dest = path.join(base, 'skill-advisor');
    console.log(`${o['dry-run'] ? '[dry-run] ' : ''}Installing advisor skill → ${dest}`);
    if (o['dry-run']) continue;
    fs.mkdirSync(base, { recursive: true });
    fs.cpSync(from, dest, { recursive: true });
  }
  console.log(c.green('\n✓ Now, in any project, ask Claude Code or Codex: "which skills and MCP servers should I install for this project?"'));
}

async function cmdScan(o) {
  const { scan, summaryLine, REPORT_DIR } = require('../lib/scan');
  const r = await scan({ minStars: Number(o['min-stars']) || 20, log: (m) => console.log(c.dim(m)) });
  const md = path.join(REPORT_DIR, `${r.date.slice(0, 10)}.md`);
  if (o.json) return console.log(JSON.stringify(r, null, 2));
  printReport(r);
  console.log(c.dim(`\nReport saved: ${md}`));
  if (o.notify) {
    const alerts = r.security.length + r.skillChanges.length;
    const shown = require('../lib/schedule').notify(alerts ? 'Skill Scout: security alert' : 'Skill Scout weekly scan', summaryLine(r), md);
    // No toast support? Open the report so security alerts are never missed.
    if (!shown && alerts && process.platform === 'win32') require('child_process').spawn('notepad', [md], { detached: true, stdio: 'ignore' }).unref();
  }
}

function printReport(r) {
  console.log(c.bold(`\nSkill Scout report ${r.date.slice(0, 10)}`) + c.dim(` (changes since ${r.since.slice(0, 10)}${r.firstRun ? ', first scan' : ''})`));
  console.log(c.bold(c.yellow('\n⚠ Security of what you have installed')));
  if (!r.security.length && !r.skillChanges.length) console.log(c.green('  No new warnings.'));
  r.security.forEach((s) => { console.log(`  ${c.bold(s.name)} (${levelBadge(s.level)})`); s.items.forEach((i) => console.log(`    • ${i.kind}: ${i.title}\n      ${c.dim(i.url)}`)); });
  r.skillChanges.forEach((s) => console.log(`  Skill ${s.dir}: ${s.changed ? c.yellow('files changed, ') : ''}risk ${levelBadge(s.level)}`));
  console.log(c.bold('\n🆕 New in the official MCP registry (with GitHub traction)'));
  if (!r.newRegistry.length) console.log(c.dim('  Nothing notable.'));
  r.newRegistry.forEach((s) => console.log(`  ★ ${String(s.stars).padStart(5)}  ${c.bold(s.title)}  ${c.dim(s.description.slice(0, 70))}  github:${s.repo}`));
  console.log(c.bold('\n🌱 New repositories on GitHub'));
  if (!r.newRepos.length) console.log(c.dim('  Nothing notable.'));
  r.newRepos.forEach((x) => console.log(`  ★ ${String(x.stars).padStart(5)}  [${x.kind}] ${c.bold(x.repo)}  ${c.dim(x.description.slice(0, 70))}`));
  console.log(c.bold('\n📈 Rising fast'));
  if (!r.rising.length) console.log(c.dim(r.firstRun ? '  Available from the next scan.' : '  Nothing notable.'));
  r.rising.forEach((x) => console.log(`  +${x.gained} ★  [${x.kind}] ${c.bold(x.repo)} (now ${x.stars})`));
  r.errors.forEach((e) => console.log(c.yellow(`\nNote: ${e}`)));
  console.log(c.dim('\nNew items are NOT vetted – audit first: skill-scout check github:owner/repo'));
}

function cmdNews(o) {
  const r = require('../lib/scan').latestReport();
  if (!r) return console.log('No scan yet. Run: skill-scout scan');
  if (o.json) return console.log(JSON.stringify(r, null, 2));
  printReport(r);
}

function cmdSchedule(o) {
  const sch = require('../lib/schedule');
  if (o.remove) return sch.remove();
  if (o.status) return sch.status();
  if (!sch.install(o)) { process.exitCode = 1; return; }
  if (!o['dry-run']) console.log(c.green('✓ Weekly scan scheduled. You will get a Windows notification with the results.\n  Tip: run `skill-scout scan` once now to create the baseline.'));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0];
  const table = { top: cmdTop, recommend: cmdRecommend, rec: cmdRecommend, search: cmdSearch, info: cmdInfo, check: cmdCheck, install: cmdInstall, installed: cmdInstalled, setup: cmdSetup, scan: cmdScan, news: cmdNews, schedule: cmdSchedule, ui: (x) => require('../lib/server').start(x) };
  if (!cmd || cmd === 'help' || o.help) return console.log(HELP);
  if (!table[cmd]) throw new Error(`Unknown command "${cmd}". Run: skill-scout help`);
  await table[cmd](o);
}

main().catch((e) => { console.error(c.red(`Error: ${e.message}`)); process.exitCode = 1; });
