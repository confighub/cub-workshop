#!/usr/bin/env node
// Read the reviewed public example snapshot. This never fetches or runs an example.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const index = JSON.parse(readFileSync(new URL('../catalog/examples.json', import.meta.url), 'utf8'));
const snapshotSource = JSON.parse(readFileSync(new URL('../catalog/source.json', import.meta.url), 'utf8'));
if (index.schema_version !== 1 || !Array.isArray(index.entries)) {
  throw new Error('Unsupported public example index');
}

export function runnable(entry) {
  return entry.visibility === 'public' && entry.lifecycle === 'maintained' &&
    entry.role === 'walkthrough' && entry.admission === 'verified-source';
}

function words(value) {
  return String(value).toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// Words that carry no meaning in a question, so "how do I start" does not
// match every example that contains an i or a do.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in',
  'into', 'is', 'it', 'like', 'me', 'my', 'of', 'on', 'or', 'should', 'so', 'the',
  'this', 'to', 'want', 'we', 'what', 'when', 'where', 'which', 'with', 'you', 'your',
]);

function queryWords(query) {
  return words(query).filter(word => word.length > 1 && !STOP_WORDS.has(word));
}

// A word matches another when they are equal, or when a query word of three or
// more letters starts it, so "app" finds "apps" but "i" finds nothing.
function matches(word, target) {
  return target === word || (word.length >= 3 && target.startsWith(word));
}

function score(entry, query) {
  const tags = (entry.tags ?? []).map(tag => String(tag).toLowerCase());
  const tagWords = tags.flatMap(words);
  const idWords = words(entry.id ?? '');
  const taskWords = words(entry.task ?? '');
  let result = 0;
  for (const word of queryWords(query)) {
    if (tags.includes(word)) result += 8;
    else if (tagWords.some(tag => matches(word, tag))) result += 4;
    if (idWords.some(id => matches(word, id))) result += 5;
    if (taskWords.some(task => matches(word, task))) result += 2;
  }
  return result;
}

export function findExamples(query, { all = false } = {}) {
  return index.entries
    .filter(entry => (all || runnable(entry)) && entry.visibility === 'public')
    .map(entry => ({ entry, score: query ? score(entry, query) : 1 }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id, 'en'))
    .map(row => row.entry);
}

function guideUrl(entry) {
  const guide = entry.guides.human;
  return guide.startsWith('https://')
    ? guide
    : `https://github.com/${entry.source.repository}/blob/${entry.source.revision}/${guide}`;
}

function tutorialUrl(entry) {
  if (!entry.tutorial) return null;
  return entry.tutorial.startsWith('https://')
    ? entry.tutorial
    : `https://github.com/${snapshotSource.repository}/blob/${snapshotSource.revision}/${entry.tutorial}`;
}

export function runExamples(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: cub config examples [problem words] [--json] [--all]\n');
    return;
  }
  const all = args.includes('--all');
  const json = args.includes('--json');
  const terms = args.filter(arg => arg !== '--all' && arg !== '--json');
  if (terms.some(arg => arg.startsWith('-'))) {
    throw new Error('Usage: cub config examples [problem words] [--json] [--all]');
  }
  const query = terms.join(' ');
  const entries = findExamples(query, { all });
  if (json) {
    process.stdout.write(JSON.stringify({ schema_version: 1, query, entries }, null, 2) + '\n');
    return;
  }
  for (const entry of entries) {
    process.stdout.write(`${entry.task} [${entry.id}]\n`);
    process.stdout.write(`  Start here: ${tutorialUrl(entry) ?? guideUrl(entry)}\n`);
    if (entry.lesson) process.stdout.write(`  What it shows: ${entry.lesson}\n`);
    process.stdout.write(`  First artifact: ${entry.preview.artifact}\n`);
    if (entry.practice) process.stdout.write(`  Local edit: ${entry.practice.artifact} (${entry.practice.effects}; see pinned tutorial for ${entry.practice.command})\n`);
    if (entry.tutorial) process.stdout.write(`  Owning guide: ${guideUrl(entry)}\n`);
    process.stdout.write(`  Needs: ${entry.preview.requires.join(', ') || 'no additional tools declared'}\n`);
    const local = entry.requirements.local;
    const connected = entry.requirements.connected;
    process.stdout.write(`  Tested local tools: ${Object.entries(local.tested_tool_versions).map(([tool, version]) => `${tool} ${version}`).join(', ')}\n`);
    process.stdout.write(`  Local credentials: ${local.credentials}\n`);
    process.stdout.write(`  Local cost: ${local.cost}\n`);
    process.stdout.write(`  Local cleanup: ${local.cleanup}\n`);
    process.stdout.write(`  Connected qualification: ${connected.qualification}\n`);
    if (connected.tested_tool_versions) process.stdout.write(`  Connected tested tools: ${Object.entries(connected.tested_tool_versions).map(([tool, version]) => `${tool} ${version}`).join(', ')}\n`);
    if (connected.version_note) process.stdout.write(`  Version note: ${connected.version_note}\n`);
    process.stdout.write(`  Connected credentials: ${connected.credentials}\n`);
    process.stdout.write(`  Connected cost: ${connected.cost}\n`);
    process.stdout.write(`  Connected cleanup: ${connected.cleanup}\n`);
    process.stdout.write(`  Effects: ${entry.effects}\n`);
    process.stdout.write(`  Stop: ${entry.stop_when}\n`);
    process.stdout.write(`  Evidence: static ${entry.evidence.static}; connected ${entry.evidence.connected}; controller ${entry.evidence.controller}; runtime ${entry.evidence.runtime}\n`);
    if (entry.evidence.receipt) process.stdout.write(`  Qualification: https://github.com/${snapshotSource.repository}/blob/${snapshotSource.revision}/${entry.evidence.receipt}\n`);
    if (entry.evidence.connected_receipt) process.stdout.write(`  Connected receipt: https://github.com/${snapshotSource.repository}/blob/${snapshotSource.revision}/${entry.evidence.connected_receipt}\n`);
    process.stdout.write(`  Maintainer acceptance: ${entry.maintainer_acceptance}\n`);
    process.stdout.write(`  Source: ${entry.source.url} (${entry.lifecycle}; ${entry.admission})\n`);
  }
  if (entries.length === 0) process.stdout.write('No admitted public example matched. Try --all for research candidates.\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { runExamples(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
