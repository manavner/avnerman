'use strict';
const catalog = require('./catalog');
const { assess } = require('./security');
const { LEVEL_ORDER } = require('./util');

function supports(item, target) {
  if (target === 'both') return true;
  const inst = item.install || {};
  if (item.type === 'mcp' || item.type === 'skill') return true;
  if (target === 'claude') return Array.isArray(inst.claude);
  return Array.isArray(inst.codex) || Array.isArray(inst.codexSkills);
}

function verdict(item, level) {
  if (level === 'blocked') return 'AVOID';
  if (item.deprecated) return 'AVOID';
  if (item.rating >= 4 && LEVEL_ORDER[level] <= 1) return 'RECOMMENDED';
  if (level === 'high') return 'USE WITH CARE';
  return 'OPTIONAL';
}

// Broad tags say little on their own; specific ones (payments, supabase...) matter more.
const BROAD = new Set(['web', 'frontend', 'html', 'node', 'backend', 'python', 'docs', 'css']);
function relevanceOf(matched) {
  const broad = matched.filter((t) => BROAD.has(t)).length;
  return Math.min(broad * 0.6, 1.2) + (matched.length - broad) * 1.5;
}

// "web, frontend (index.html)" instead of repeating the same evidence per tag.
function explain(matched, tags) {
  const byEvidence = new Map();
  for (const t of matched) byEvidence.set(tags.get(t), [...(byEvidence.get(tags.get(t)) || []), t]);
  return [...byEvidence].map(([ev, ts]) => `${ts.join('/')} (${ev})`);
}

// tags: Map(tag -> evidence). Returns ranked recommendations with reasons.
async function recommend(tags, { target = 'both', live = false, limit = 12, includeGeneral = true } = {}) {
  const out = [];
  for (const item of catalog.all()) {
    if (!supports(item, target)) continue;
    const matched = item.tags.filter((t) => t !== 'general' && tags.has(t));
    const general = includeGeneral && item.always;
    if (!matched.length && !general) continue;
    const a = await assess(item, { live });
    const relevance = relevanceOf(matched) + (general ? 0.8 : 0);
    const score = relevance * 20 + item.rating * 8 + a.trust * 0.3 - LEVEL_ORDER[a.level] * 6 - (item.deprecated ? 60 : 0);
    out.push({
      item, assessment: a, score: Math.round(score), verdict: verdict(item, a.level),
      why: matched.length ? explain(matched, tags) : ['useful for almost every project'],
    });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

// Top-rated items overall (no project context).
async function top({ type, target = 'both', live = false, limit = 15 } = {}) {
  const items = catalog.all().filter((i) => (!type || i.type === type || (type === 'skill' && i.type === 'plugin')) && supports(i, target) && !i.deprecated);
  const rows = [];
  for (const item of items) {
    const a = await assess(item, { live });
    const pop = a.popularity.stars ? Math.log10(a.popularity.stars + 1) * 6 : 0;
    rows.push({ item, assessment: a, score: Math.round(item.rating * 12 + a.trust * 0.3 + pop - LEVEL_ORDER[a.level] * 4), verdict: verdict(item, a.level) });
  }
  return rows.sort((x, y) => y.score - x.score).slice(0, limit);
}

module.exports = { recommend, top, verdict };
