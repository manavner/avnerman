'use strict';
const path = require('path');
const catalog = require(path.join(__dirname, '..', 'data', 'catalog.json'));

function all() { return catalog.items; }
function get(id) { return catalog.items.find((i) => i.id === id) || null; }

function blocklisted(ecosystem, name) {
  return catalog.blocklist.find((b) => b.ecosystem === ecosystem && b.name === name) || null;
}

// Servers that ship with an agent itself (not third-party).
function builtin(agent, name) {
  return (catalog.builtins || []).find((b) => b.agent === agent && b.name === name) || null;
}

function globalWarningsFor(ecosystem, name) {
  return catalog.globalWarnings.filter((w) => w.ecosystem === ecosystem && w.match === name);
}

// Free-text search over name, description, tags and publisher.
function search(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.items
    .map((item) => {
      const hay = [item.id, item.name, item.description, item.publisher, ...item.tags].join(' ').toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      return { item, hits };
    })
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.item.rating - a.item.rating)
    .map((r) => r.item);
}

module.exports = { all, get, search, blocklisted, builtin, globalWarningsFor, meta: { version: catalog.version, updated: catalog.updated } };
