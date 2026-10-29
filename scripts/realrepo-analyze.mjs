// Runs every code analyzer over real repositories and checks the generated Mermaid with the real renderer.
// usage: node scripts/realrepo-analyze.mjs <reposDir> [repo[:lang] ...]   (needs Playwright + Chromium; see README)
// Build first: esbuild .conformance-build/real-entry.ts --bundle --platform=node --format=cjs --outfile=.conformance-build/real.cjs
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync, lstatSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const { LANGUAGES, runAnalysis, parseMermaid } = req('../.conformance-build/real.cjs');
const root = process.argv[2];
const only = process.argv.slice(3);
const outDir = process.env.REALREPO_OUT ?? join(root, '..', 'out');
mkdirSync(outDir, { recursive: true });
const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', 'third_party', 'out', '.venv', 'bin', 'obj']);
const MAX_FILE = 1_000_000; // bytes; the extension reads files the same way and skips none, this only protects the harness from generated blobs

function walk(dir, exts, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, exts, acc);
    else if (exts.has(extname(name).slice(1)) && st.size <= MAX_FILE) acc.push(p);
  }
  return acc;
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<body><div id="h"></div></body>');
await page.addScriptTag({ path: new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url).pathname });
await page.evaluate(() => mermaid.initialize({ startOnLoad: false, maxTextSize: 5_000_000, maxEdges: 5000 }));

const rows = [];
const dirs = readdirSync(root).filter((d) => lstatSync(join(root, d)).isDirectory() && (!only.length || only.some((o) => o.split(':')[0] === d)));
for (const repo of dirs) {
  const forced = only.find((o) => o.split(':')[0] === repo)?.split(':')[1];
  for (const lang of LANGUAGES) {
    if (forced && forced !== lang.id) continue;
    const paths = walk(join(root, repo), new Set(lang.extensions));
    if (paths.length < 3) continue;
    const files = paths.map((p) => ({ path: relative(join(root, repo), p), text: readFileSync(p, 'utf8') }));
    for (const a of lang.analyses) {
      const t0 = Date.now();
      let out, err = null;
      try { out = runAnalysis(lang.id, a.kind, files); } catch (e) { err = String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '); }
      const ms = Date.now() - t0;
      const row = { repo, lang: lang.id, kind: a.kind, files: files.length, ms, nodes: 0, edges: 0, parse: '-', render: '-', err };
      if (out?.mermaid) {
        const src = out.mermaid;
        row.nodes = (src.match(/^\s*\w+[\[({]/gm) ?? []).length;
        row.edges = (src.match(/-->|-\.->|==>/g) ?? []).length;
        writeFileSync(join(outDir, `${repo}.${lang.id}.${a.kind}.mmd`), src);
        const d = parseMermaid(src);
        row.parse = d.parseIssues?.filter((i) => i.severity === 'error').length ? 'ERR' : 'ok';
        if (row.edges <= 1500) {
          row.render = await page.evaluate(async (t) => { try { await mermaid.render('x' + Math.random().toString(36).slice(2), t); return 'ok'; } catch (e) { return 'FAIL ' + String(e.message ?? e).split('\n')[0].slice(0, 80); } }, src);
        } else row.render = 'skipped(>1500 edges)';
      } else row.note = out?.note?.slice(0, 60);
      rows.push(row);
      console.log(`${repo.padEnd(18)} ${lang.id.padEnd(10)} ${a.kind.padEnd(8)} files=${String(row.files).padStart(5)} ${String(ms).padStart(6)}ms nodes=${String(row.nodes).padStart(5)} edges=${String(row.edges).padStart(5)} parse=${row.parse} render=${row.render}${err ? ' CRASH ' + err : ''}${row.note && !out?.mermaid ? ' (empty: ' + row.note + ')' : ''}`);
    }
  }
}
await browser.close();
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(rows, null, 1));
const bad = rows.filter((r) => r.err || r.parse === 'ERR' || String(r.render).startsWith('FAIL'));
console.log(`\n${rows.length} analyses, ${bad.length} problem(s)`);
if (bad.length) process.exit(1);
