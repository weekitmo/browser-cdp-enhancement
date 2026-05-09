#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const root = process.cwd();
const next = process.argv[2];

if (!next || !VERSION_RE.test(next)) {
  console.error('Usage: node scripts/bump-version.mjs <semver>');
  console.error('Example: node scripts/bump-version.mjs 1.0.1');
  process.exit(2);
}

function fileExists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function writeIfChanged(rel, text) {
  const file = path.join(root, rel);
  const old = fs.readFileSync(file, 'utf8');
  if (old === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

function updateSkill(rel) {
  if (!fileExists(rel)) return { rel, skipped: 'missing' };
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { rel, skipped: 'no frontmatter' };

  const frontmatter = match[1];
  const versionLine = /^([ \t]*version:[ \t]*)["']?[^"'\n]+["']?[ \t]*$/m;
  if (!versionLine.test(frontmatter)) return { rel, skipped: 'no metadata.version' };

  const updatedFrontmatter = frontmatter.replace(versionLine, `$1"${next}"`);
  const body = text.slice(match[0].length);
  const updated = `---\n${updatedFrontmatter}\n---\n${body}`;
  return { rel, changed: writeIfChanged(rel, updated) };
}

function updateJson(rel, mutator) {
  if (!fileExists(rel)) return { rel, skipped: 'missing' };
  const file = path.join(root, rel);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const changed = mutator(data);
  if (!changed) return { rel, changed: false };
  return { rel, changed: writeIfChanged(rel, JSON.stringify(data, null, 2) + '\n') };
}

const results = [];
results.push(updateSkill('SKILL.md'));
results.push(updateJson('.codex-plugin/plugin.json', data => {
  if (data.version === next) return false;
  data.version = next;
  return true;
}));
results.push(updateJson('.claude-plugin/plugin.json', data => {
  if (data.version === next) return false;
  data.version = next;
  return true;
}));
results.push(updateJson('.claude-plugin/marketplace.json', data => {
  let changed = false;
  for (const plugin of data.plugins || []) {
    if (plugin.name === 'browser-cdp-enhancement' && plugin.version !== next) {
      plugin.version = next;
      changed = true;
    }
  }
  return changed;
}));

for (const r of results) {
  if (r.skipped) console.log(`skip    ${r.rel} (${r.skipped})`);
  else console.log(`${r.changed ? 'updated' : 'same   '} ${r.rel}`);
}
