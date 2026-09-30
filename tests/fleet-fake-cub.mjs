// A fake cub on PATH for the fleet tests: each call is logged as a JSON array
// of its argv, and answered by the first rule whose pattern matches the argv
// joined with spaces; {N} in a rule's output is the call's Nth argument. An
// unmatched call succeeds with no output, which is what a create or delete
// prints to a script. Nothing here reaches a server.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));

const FAKE_CUB = `#!${process.execPath}
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CUB_LOG,JSON.stringify(args)+'\\n');
const line=args.join(' ');
for (const rule of JSON.parse(process.env.FAKE_CUB_RULES||'[]')) {
  if (!new RegExp(rule.when).test(line)) continue;
  const fill=(text)=>text.replace(/\\{(\\d+)\\}/g,(_,index)=>args[index]??'');
  if (rule.out) process.stdout.write(fill(rule.out));
  if (rule.err) process.stderr.write(fill(rule.err));
  process.exit(rule.code ?? 0);
}
`;

// Run bin/cub-fleet with the fake cub (and any extra fake tools) first on PATH.
// files are written into the scratch directory before the run, so a manifest
// can sit beside the tools; {dir} in their content is replaced by its path.
export function runFleet(argv, { rules = [], files = {}, tools = {}, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-fake-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const log = join(dir, 'calls.jsonl');
    writeFileSync(join(bin, 'cub'), FAKE_CUB, { mode: 0o755 });
    for (const [tool, source] of Object.entries(tools)) writeFileSync(join(bin, tool), `#!${process.execPath}\n${source}`, { mode: 0o755 });
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), String(content).replaceAll('{dir}', dir));
    const resolved = argv.map((arg) => arg.replaceAll('{dir}', dir));
    const result = spawnSync(process.execPath, [join(root, 'bin/cub-fleet'), ...resolved], {
      encoding: 'utf8',
      env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_CUB_LOG: log, FAKE_CUB_RULES: JSON.stringify(rules), FAKE_DIR: dir },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((row) => JSON.parse(row)) : [];
    return { result, calls, output: result.stdout + result.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The cub message for an absent entity, as the CLI prints it.
export const missing = (entity) => ({ err: `Failed: ${entity} not found\n`, code: 1 });
// Every Space the call names reads as absent.
// The wording a current hub gives; tests/fleet-lookup-errors.test.mjs keeps the older one.
export const noSpaces = { when: '^space get', err: 'Failed: space "{2}" not found in any space\n', code: 1 };
