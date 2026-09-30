'use strict';
// Installs catalog items into Claude Code and/or Codex.
// Principles: show risks first, ask before changing anything, back up config
// files, and never write secrets to disk – configs reference environment variables.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { HOME, c, exists } = require('./util');
const { scanSkillDir, scanLines } = require('./security');

const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');

function hasCmd(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

function run(cmd, args, dryRun, log) {
  log(c.dim(`$ ${[cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`));
  if (dryRun) return true;
  // On Windows `claude`/`codex` are often .cmd shims that need a shell; cmd.exe
  // doesn't quote for us, so quote arguments with spaces ourselves.
  // Output is captured (not inherited) so the dashboard can show it too.
  const win = process.platform === 'win32';
  const opts = { encoding: 'utf8', windowsHide: true };
  const r = win
    ? spawnSync([cmd, ...args].map((a) => (/[\s&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '), { ...opts, shell: true })
    : spawnSync(cmd, args, opts);
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (out) log(out);
  if (r.error) log(`Error: ${r.error.message}`);
  return r.status === 0;
}

function backup(file) {
  if (exists(file)) fs.copyFileSync(file, `${file}.bak-skill-scout`);
}

// Replace {{VAR}} placeholders in args with user-provided values.
function resolveArgs(inst, values) {
  return (inst.args || []).map((a) => a.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!values[k]) throw new Error(`Missing value for ${k}. Pass --set ${k}=...`);
    return values[k];
  }));
}

// Secrets referenced from config. Optional ones only when the variable is already set.
const secretEnv = (inst) => (inst.env || []).filter((e) => !e.arg && (!e.optional || process.env[e.name]));

// ------------------------------- Claude Code --------------------------------
function claudeMcp(item, { scope, dryRun, values, log, cwd }) {
  const inst = item.install;
  const name = item.id;
  const claudeScope = scope === 'project' ? 'project' : 'user';
  if (hasCmd('claude') || dryRun) {
    // Name (and URL) go first: -e/--header are variadic and would swallow them.
    const args = ['mcp', 'add'];
    if (inst.transport === 'http') {
      args.push(name, inst.url, '-s', claudeScope, '--transport', 'http');
      for (const e of secretEnv(inst)) if (e.header) args.push('--header', `${e.header}: ${e.prefix || ''}\${${e.name}}`);
    } else {
      args.push(name, '-s', claudeScope);
      for (const e of secretEnv(inst)) args.push('-e', `${e.name}=\${${e.name}}`);
      args.push('--', inst.command, ...resolveArgs(inst, values));
    }
    return run('claude', args, dryRun, log);
  }
  if (claudeScope !== 'project') {
    log(c.yellow('`claude` CLI not found. Install Claude Code, or re-run with --scope project to write .mcp.json.'));
    return false;
  }
  const file = path.join(cwd, '.mcp.json');
  const cfg = exists(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  cfg.mcpServers = cfg.mcpServers || {};
  if (inst.transport === 'http') {
    const headers = {};
    for (const e of secretEnv(inst)) if (e.header) headers[e.header] = `${e.prefix || ''}\${${e.name}}`;
    cfg.mcpServers[name] = { type: 'http', url: inst.url, ...(Object.keys(headers).length ? { headers } : {}) };
  } else {
    const env = {};
    for (const e of secretEnv(inst)) env[e.name] = `\${${e.name}}`;
    cfg.mcpServers[name] = { type: 'stdio', command: inst.command, args: resolveArgs(inst, values), ...(Object.keys(env).length ? { env } : {}) };
  }
  backup(file);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  log(c.green(`Wrote ${file}`));
  return true;
}

// ---------------------------------- Codex -----------------------------------
const tomlStr = (s) => JSON.stringify(String(s));

function codexTomlBlock(item, values) {
  const inst = item.install;
  const lines = [`[mcp_servers.${tomlStr(item.id)}]`];
  if (inst.transport === 'http') {
    lines.push(`url = ${tomlStr(inst.url)}`);
    for (const e of secretEnv(inst)) {
      if (!e.header) continue;
      if (e.header === 'Authorization' && (e.prefix || '').startsWith('Bearer')) lines.push(`bearer_token_env_var = ${tomlStr(e.name)}`);
      else lines.push(`env_http_headers = { ${tomlStr(e.header)} = ${tomlStr(e.name)} }`);
    }
  } else {
    lines.push(`command = ${tomlStr(inst.command)}`);
    lines.push(`args = [${resolveArgs(inst, values).map(tomlStr).join(', ')}]`);
    const names = secretEnv(inst).map((e) => tomlStr(e.name));
    if (names.length) lines.push(`env_vars = [${names.join(', ')}]`);
  }
  return lines.join('\n') + '\n';
}

function codexMcp(item, { scope, dryRun, values, log, cwd }) {
  const file = scope === 'project' ? path.join(cwd, '.codex', 'config.toml') : path.join(CODEX_HOME, 'config.toml');
  const block = codexTomlBlock(item, values);
  const current = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  const header = new RegExp(`^\\[mcp_servers\\.("?)${item.id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\1\\]`, 'm');
  if (header.test(current)) { log(c.yellow(`Codex: "${item.id}" already configured in ${file} – skipped.`)); return true; }
  log(c.dim(`Append to ${file}:\n${block}`));
  if (dryRun) return true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, current ? `${current.replace(/\n*$/, '\n')}\n${block}` : block);
  log(c.green(`Updated ${file}`));
  return true;
}

// ---------------------------------- Skills ----------------------------------
function skillDirs(target, scope, cwd) {
  const dirs = [];
  if (target !== 'codex') dirs.push(scope === 'project' ? path.join(cwd, '.claude', 'skills') : path.join(HOME, '.claude', 'skills'));
  if (target !== 'claude') dirs.push(scope === 'project' ? path.join(cwd, '.agents', 'skills') : path.join(CODEX_HOME, 'skills'));
  return dirs;
}

// Download one folder of a GitHub repo with a sparse, shallow git clone.
function fetchRepoPath(repo, subpath, ref, log) {
  if (!hasCmd('git')) throw new Error('git is required to download skills');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scout-'));
  const q = { stdio: 'ignore' };
  const url = `https://github.com/${repo}.git`;
  log(c.dim(`Downloading ${repo}/${subpath || ''} ...`));
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--sparse'];
  if (ref) args.push('--branch', ref);
  if (spawnSync('git', [...args, url, tmp], q).status !== 0) throw new Error(`git clone failed for ${url}`);
  if (subpath && spawnSync('git', ['-C', tmp, 'sparse-checkout', 'set', subpath], q).status !== 0) throw new Error(`path ${subpath} not found`);
  const dir = subpath ? path.join(tmp, subpath) : tmp;
  if (!exists(dir)) throw new Error(`path ${subpath} not found in ${repo}`);
  const commit = spawnSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  return { dir, tmp, commit };
}

function printScan(scan, log) {
  scanLines(scan).forEach((l) => log(l));
}

async function installSkill({ repo, path: subpath, ref }, opts) {
  const { target, scope, dryRun, log, cwd, confirm, force } = opts;
  const { dir, tmp, commit } = fetchRepoPath(repo, subpath, ref, log);
  try {
    const scan = scanSkillDir(dir);
    printScan(scan, log);
    if (scan.level === 'high' && !force) {
      log(c.red('High-risk patterns found. Review the files above; re-run with --force only if you trust them.'));
      return false;
    }
    if (scan.level === 'medium' && !(await confirm('Medium-risk patterns found. Install anyway?'))) return false;
    const name = path.basename(subpath || repo);
    for (const base of skillDirs(target, scope, cwd)) {
      const dest = path.join(base, name);
      log(`${dryRun ? '[dry-run] ' : ''}Copy → ${dest}`);
      if (dryRun) continue;
      fs.mkdirSync(base, { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(dir, dest, { recursive: true });
      fs.writeFileSync(path.join(dest, '.skill-scout.json'), JSON.stringify({ repo, path: subpath, commit, installed: new Date().toISOString(), scanLevel: scan.level }, null, 2));
    }
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Re-read the agents' config after installing and report where the item is.
function verify(item, { target, cwd, log }) {
  const inv = require('./manage').inventory(cwd);
  const kind = item.type === 'mcp' ? 'mcp' : 'skill';
  const names = kind === 'mcp' ? [item.id] : [path.basename((item.install && item.install.path) || item.id)];
  const agents = target === 'both' ? ['claude', 'codex'] : [target];
  let ok = true;
  for (const agent of agents) {
    const hit = inv.find((it) => it.agent === agent && it.kind === kind && names.includes(it.name));
    const label = agent === 'claude' ? 'Claude Code' : 'Codex';
    if (hit) log(c.green(`✓ Verified: ${hit.name} is now in ${label} (${hit.scope})`));
    else { ok = false; log(c.red(`✗ Not found in ${label}'s configuration after installing – see the messages above`)); }
  }
  return ok;
}

// ------------------------------- Entry point --------------------------------
async function install(item, opts) {
  const { target, log } = opts;
  const inst = item.install || {};
  let ok = true;
  if (item.type === 'mcp') {
    if (target !== 'codex') ok = claudeMcp(item, opts) && ok;
    if (target !== 'claude') ok = codexMcp(item, opts) && ok;
    const secrets = secretEnv(inst).filter((e) => !e.optional);
    if (secrets.length) {
      const win = process.platform === 'win32';
      log(c.yellow(`\nThis server needs secrets. They are NOT stored in config files – ${win ? 'save them as Windows environment variables (then open a new terminal):' : 'add them to your shell profile (~/.zshrc or ~/.bashrc):'}`));
      for (const e of secrets) log(`  ${win ? `setx ${e.name} "..."` : `export ${e.name}="..."`}   ${c.dim((win ? 'REM ' : '# ') + e.description)}`);
    }
    if (inst.transport === 'http' && !secrets.length) log(c.dim('Remote server: if it asks you to sign in, use /mcp in Claude Code, or in Codex: codex mcp login ' + item.id));
  } else if (item.type === 'skill') {
    ok = await installSkill(inst, opts);
  }
  if (!opts.dryRun && (item.type === 'mcp' || item.type === 'skill')) ok = verify(item, opts) && ok; else if (item.type === 'plugin') {
    if (target !== 'codex' && inst.claude) {
      log(c.bold('\nClaude Code plugins are installed from inside Claude Code. Run these commands in a Claude Code session:'));
      inst.claude.forEach((cmd) => log('  ' + c.cyan(cmd)));
    }
    if (target !== 'claude') {
      if (inst.codexSkills) {
        log(c.bold('\nInstalling the equivalent skills for Codex:'));
        for (const s of inst.codexSkills) ok = (await installSkill(s, { ...opts, target: 'codex' })) && ok;
      } else if (inst.codex) inst.codex.forEach((cmd) => log('  ' + c.cyan(cmd)));
      else log(c.yellow('No Codex equivalent for this plugin.'));
    }
  }
  return ok;
}

// ----------------------------- What's installed -----------------------------

// Names of installed items, grouped per agent (scope shown when not user-level).
function listInstalled(cwd) {
  const out = { claudeMcp: [], codexMcp: [], claudeSkills: [], codexSkills: [] };
  for (const it of require('./manage').inventory(cwd)) {
    const key = `${it.agent}${it.kind === 'mcp' ? 'Mcp' : 'Skills'}`;
    out[key].push(it.scope === 'user' ? it.name : `${it.name} (${it.scope})`);
  }
  return out;
}

module.exports = { install, installSkill, fetchRepoPath, listInstalled, codexTomlBlock, hasCmd, skillDirs };
