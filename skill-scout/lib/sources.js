'use strict';
// Live data sources: GitHub, npm, OSV.dev and the official MCP Registry.
// Every function degrades gracefully (returns null / []) when offline or rate limited.
const { fetchJson, githubHeaders } = require('./util');

const GH = 'https://api.github.com';

async function githubRepo(repo) {
  if (!repo) return null;
  const r = await fetchJson(`${GH}/repos/${repo}`, { headers: githubHeaders() });
  if (!r) return null;
  return {
    stars: r.stargazers_count, forks: r.forks_count, openIssues: r.open_issues_count,
    pushedAt: r.pushed_at, archived: r.archived, license: r.license && r.license.spdx_id,
    owner: r.owner && r.owner.login, ownerType: r.owner && r.owner.type, url: r.html_url,
  };
}

const WARNING_TERMS = '(security OR vulnerability OR malicious OR exfiltration OR "prompt injection" OR CVE OR leak OR backdoor)';

// Issues opened by users that mention security problems = "user warnings".
async function githubUserWarnings(repo, limit = 5) {
  if (!repo) return [];
  const q = encodeURIComponent(`repo:${repo} is:issue ${WARNING_TERMS}`);
  const r = await fetchJson(`${GH}/search/issues?q=${q}&sort=created&order=desc&per_page=${limit}`, { headers: githubHeaders() });
  if (!r || !r.items) return [];
  return r.items.map((i) => ({
    title: i.title, url: i.html_url, state: i.state, date: (i.created_at || '').slice(0, 10),
    comments: i.comments, reactions: i.reactions ? i.reactions.total_count : 0,
  }));
}

async function githubAdvisories(repo) {
  if (!repo) return [];
  const r = await fetchJson(`${GH}/repos/${repo}/security-advisories?state=published&per_page=10`, { headers: githubHeaders() });
  if (!Array.isArray(r)) return [];
  return r.map((a) => ({ id: a.ghsa_id, cve: a.cve_id, severity: a.severity, summary: a.summary, url: a.html_url, date: (a.published_at || '').slice(0, 10) }));
}

async function npmInfo(name) {
  const doc = await fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2F')}`);
  if (!doc || !doc['dist-tags']) return null;
  const latest = doc['dist-tags'].latest;
  const v = (doc.versions && doc.versions[latest]) || {};
  const scripts = v.scripts || {};
  const installScripts = ['preinstall', 'install', 'postinstall'].filter((s) => scripts[s]).map((s) => `${s}: ${scripts[s]}`);
  return {
    latest, deprecated: v.deprecated || null, installScripts,
    maintainers: (doc.maintainers || []).length,
    created: doc.time && doc.time.created, modified: doc.time && doc.time[latest],
    repository: v.repository && (v.repository.url || v.repository),
  };
}

async function npmWeeklyDownloads(name) {
  const r = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${name}`);
  return r && typeof r.downloads === 'number' ? r.downloads : null;
}

async function pypiInfo(name) {
  const r = await fetchJson(`https://pypi.org/pypi/${name}/json`);
  if (!r || !r.info) return null;
  return { latest: r.info.version, yanked: !!r.info.yanked };
}

// Known vulnerabilities affecting the given version (or all versions if none given).
async function osvVulns(ecosystem, name, version) {
  const body = JSON.stringify(version ? { package: { name, ecosystem }, version } : { package: { name, ecosystem } });
  const r = await fetchJson('https://api.osv.dev/v1/query', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  if (!r) return null;
  return (r.vulns || []).map((v) => ({
    id: v.id, aliases: v.aliases || [], summary: v.summary || (v.details || '').slice(0, 140),
    malicious: v.id.startsWith('MAL-'), url: `https://osv.dev/vulnerability/${v.id}`,
  }));
}

// Official MCP registry (registry.modelcontextprotocol.io) – good for discovery, not for popularity.
async function registrySearch(query, limit = 20) {
  const r = await fetchJson(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(query)}&limit=${limit}`);
  if (!r || !r.servers) return [];
  const seen = new Map();
  for (const { server, _meta } of r.servers) {
    const official = _meta && _meta['io.modelcontextprotocol.registry/official'];
    if (official && official.isLatest === false) continue;
    seen.set(server.name, {
      source: 'mcp-registry', type: 'mcp', name: server.title || server.name, id: server.name,
      description: server.description, version: server.version,
      repo: server.repository && server.repository.url ? server.repository.url.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '') : null,
      remotes: (server.remotes || []).map((x) => x.url),
      packages: (server.packages || []).map((p) => ({ ecosystem: p.registryType === 'pypi' ? 'PyPI' : p.registryType, name: p.identifier })),
    });
  }
  return [...seen.values()];
}

// GitHub repository discovery sorted by stars (the best public "recommendation" signal).
async function githubDiscover(kind, query = '', limit = 15) {
  const topics = kind === 'skill'
    ? ['claude-skills', 'agent-skills', 'claude-code-skills', 'codex-skills']
    : ['mcp-server', 'model-context-protocol'];
  const out = new Map();
  for (const t of topics) {
    const q = encodeURIComponent(`topic:${t} ${query}`.trim());
    const r = await fetchJson(`${GH}/search/repositories?q=${q}&sort=stars&order=desc&per_page=${limit}`, { headers: githubHeaders() });
    for (const repo of (r && r.items) || []) {
      out.set(repo.full_name, {
        source: 'github', type: kind, id: repo.full_name, name: repo.name, repo: repo.full_name,
        description: repo.description, stars: repo.stargazers_count, pushedAt: repo.pushed_at,
        archived: repo.archived, license: repo.license && repo.license.spdx_id,
      });
    }
  }
  return [...out.values()].sort((a, b) => b.stars - a.stars).slice(0, limit);
}

module.exports = { githubRepo, githubUserWarnings, githubAdvisories, npmInfo, npmWeeklyDownloads, pypiInfo, osvVulns, registrySearch, githubDiscover };
