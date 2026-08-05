'use strict';
// The browser code, checked without a browser.
//
// This exists because of a real outage: a backtick inside an HTML comment
// inside a template literal ended the string early, and schedules.js stopped
// parsing. app.js imports every screen statically, so one bad module took the
// whole interface down — blank page, no working buttons, and nothing on the
// server to notice. The API suite was entirely green throughout.
//
// No database and no network. Runs first so a broken frontend fails fast.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, section, summary } = require('./helpers');

const APP_DIR = path.join(__dirname, '..', 'public', 'app');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = jsFiles(APP_DIR);
const rel   = (file) => path.relative(APP_DIR, file).replace(/\\/g, '/');

// ─── Every module parses as ESM ──────────────────────────────────────────────

section('every frontend module parses');

// `node --check` treats .js as CommonJS and rejects import/export outright, so
// each file is copied to .mjs to be parsed the way a browser would.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'medrem-esm-'));

for (const file of files) {
  const copy = path.join(tmp, rel(file).replace(/\//g, '__').replace(/\.js$/, '.mjs'));
  fs.writeFileSync(copy, fs.readFileSync(file));

  const result = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
  const ok = result.status === 0;
  check(`${rel(file)} parses`, ok, true);
  if (!ok) console.log(`        ${(result.stderr || '').split('\n').slice(0, 4).join('\n        ')}`);
}

fs.rmSync(tmp, { recursive: true, force: true });

// ─── Every import resolves to a real export ──────────────────────────────────
//
// A missing export is a link-time failure in the browser: the module graph
// never evaluates, so the symptom is the same blank page as a parse error.

section('every import names something that is exported');

const sources = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]));

function exportsOf(source) {
  const names = new Set();
  // export function foo / export const foo / export class foo
  for (const m of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

let unresolved = 0;

for (const [file, source] of sources) {
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[2]);
    const targetSource = sources.get(target);

    if (!targetSource) {
      console.log(`FAIL  ${rel(file)} imports from "${m[2]}", which does not exist`);
      unresolved++;
      continue;
    }

    const available = exportsOf(targetSource);
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!available.has(name)) {
        console.log(`FAIL  ${rel(file)} imports "${name}" from ${m[2]}, which does not export it`);
        unresolved++;
      }
    }
  }
}

check('all imports resolve', unresolved, 0);

// ─── The shell loads the entry point ─────────────────────────────────────────

section('the shell wires up to the entry point');

const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
check('loads app.js as a module', /<script[^>]+type="module"[^>]+src="\/app\/app\.js"/.test(html), true);
check('has the container screens render into', html.includes('id="screen"'), true);
check('has the toast target', html.includes('id="toast"'), true);

// Each tab in the shell has to match a screen the router knows about, or the
// link silently falls back to Today.
const appSource = sources.get(path.join(APP_DIR, 'app.js'));
for (const m of html.matchAll(/data-tab="([a-z]+)"/g)) {
  check(`tab "${m[1]}" has a screen`, new RegExp(`^\\s*${m[1]}:`, 'm').test(appSource), true);
}

process.exitCode = summary() ? 1 : 0;
