'use strict';

const { execSync } = require('child_process');

const SF_METADATA_DIRS = new Set([
  'classes', 'triggers', 'lwc', 'aura', 'flows', 'objects',
  'pages', 'permissionsets', 'layouts', 'staticresources',
  'components', 'email', 'reports', 'dashboards', 'tabs',
  'profiles', 'roles', 'queues', 'groups', 'customMetadata',
]);

const TEST_RE = /Tests?$/i;

function stripMetaExtension(filename) {
  // Remove -meta.xml suffix first, then any remaining SF extension
  // e.g. AccountTrigger.cls-meta.xml → AccountTrigger.cls → AccountTrigger
  // e.g. Quote-Cotação Comerc.layout-meta.xml → Quote-Cotação Comerc.layout → Quote-Cotação Comerc
  return filename
    .replace(/-meta\.xml$/, '')
    .replace(/\.[^.]+$/, '');
}

function extractMetadata(changes) {
  const itemMap = new Map();
  for (const { file } of changes) {
    const parts = file.split('/');
    const idx = parts.findIndex(p => SF_METADATA_DIRS.has(p));
    if (idx < 0 || !parts[idx + 1]) continue;
    const name = stripMetaExtension(parts[idx + 1]);
    if (!name) continue;
    const key = `${parts[idx]}/${name}`;
    if (!itemMap.has(key)) {
      itemMap.set(key, { name, type: parts[idx], files: [], isTest: TEST_RE.test(name) });
    }
    itemMap.get(key).files.push(file);
  }
  return [...itemMap.values()].filter(m => !m.isTest);
}

function toKebab(str) {
  return str.replace(/([A-Z])/g, (_, c) => '-' + c.toLowerCase()).replace(/^-/, '');
}

function generateBranchName(metadata) {
  if (!metadata.length) {
    return `feature/changes-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  }
  const slugs = [...new Set(metadata.slice(0, 3).map(m => toKebab(m.name)))];
  return `feature/${slugs.join('-')}`;
}

function getGitChanges(cwd) {
  const raw = execSync('git -c core.quotepath=false status --porcelain', { cwd }).toString();
  return raw
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      const status = l.slice(0, 2).trim();
      let file = l.slice(3).trim();
      if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
      return { status, file };
    });
}

module.exports = { extractMetadata, generateBranchName, toKebab, getGitChanges, stripMetaExtension };
