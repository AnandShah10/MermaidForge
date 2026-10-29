// Renders gantt diagrams in real Mermaid and checks that bar start positions match the dates computed by
// core/gantt/ganttSchedule.ts (fit pixels = a + b*time over all scheduled tasks; every bar must land within 0.6px).
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const { parseMermaid, computeGanttSchedule } = req('../.conformance-build/gantt.cjs');
const samples = {
  'durations + after': 'gantt\ndateFormat YYYY-MM-DD\nsection A\nDesign :d, 2024-01-01, 5d\nBuild :b, after d, 2w\nShip :s, after b, 2024-02-10\nReview :3d\nLater :l, 2024-02-20, 4d',
  'after multiple': 'gantt\ndateFormat YYYY-MM-DD\na :a, 2024-01-01, 2d\nb :b, 2024-01-01, 10d\nc :c, after a b, 3d\nd :d, after c, 1d',
  'excludes weekends': 'gantt\ndateFormat YYYY-MM-DD\nexcludes weekends\nsection S\nOne :a, 2024-01-04, 3d\nTwo :b, after a, 4d\nThree :c, after b, 2d',
  'excludes dates': 'gantt\ndateFormat YYYY-MM-DD\nexcludes 2024-01-03, 2024-01-04\nOne :a, 2024-01-01, 4d\nTwo :b, after a, 2d\nThree :c, after b, 3d',
  'weekend friday': 'gantt\ndateFormat YYYY-MM-DD\nweekend friday\nexcludes weekends\nOne :a, 2024-01-04, 3d\nTwo :b, after a, 2d\nThree :c, after b, 4d',
  'until': 'gantt\ndateFormat YYYY-MM-DD\na :a, 2024-01-01, 6d\nb :b, 2024-01-03, until a\nc :c, after b, 2d',
  'time format': 'gantt\ndateFormat YYYY-MM-DD HH:mm\naxisFormat %H:%M\na :a, 2024-01-01 08:00, 3h\nb :b, after a, 90m\nc :c, 2024-01-01 14:00, 2h',
  'other format': 'gantt\ndateFormat DD/MM/YYYY\na :a, 01/02/2024, 3d\nb :b, after a, 1w\nc :c, 20/02/2024, 2d',
  'months': 'gantt\ndateFormat YYYY-MM-DD\na :a, 2024-01-31, 1M\nb :b, after a, 2w\nc :c, 2024-06-01, 1M',
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.setContent('<body><div id="h"></div></body>');
await page.addScriptTag({ path: new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url).pathname });
await page.evaluate(() => mermaid.initialize({ startOnLoad: false, gantt: { useWidth: 1200 } }));
let fail = 0;
for (const [name, src] of Object.entries(samples)) {
  const d = parseMermaid(src);
  const s = computeGanttSchedule(d);
  if (!s.available) { console.log(`FAIL ${name}: schedule unavailable`); fail++; continue; }
  const xs = await page.evaluate(async (text) => {
    const { svg } = await mermaid.render('g' + Math.random().toString(36).slice(2), text);
    const h = document.getElementById('h'); h.innerHTML = svg;
    return [...h.querySelectorAll('rect.task, rect[class*="task"]')].filter((r) => r.id && !/-text$/.test(r.id)).map((r) => ({ id: r.id.replace(/^g[a-z0-9]+-?/, ''), x: Number(r.getAttribute('x')), w: Number(r.getAttribute('width')) }));
  }, src);
  const pts = [];
  s.tasks.forEach((t, i) => {
    const id = t.task.id ?? `task${i + 1}`;
    const bar = xs.find((r) => r.id === id || r.id.endsWith(id));
    if (bar && t.start !== null) pts.push({ id, t: t.start, x: bar.x });
  });
  if (pts.length < 3) { console.log(`FAIL ${name}: only ${pts.length} bars matched (${xs.map((x) => x.id).join(',')})`); fail++; continue; }
  const n = pts.length, mt = pts.reduce((a, p) => a + p.t, 0) / n, mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const b = pts.reduce((a, p) => a + (p.t - mt) * (p.x - mx), 0) / pts.reduce((a, p) => a + (p.t - mt) ** 2, 0);
  const worst = Math.max(...pts.map((p) => Math.abs(mx + b * (p.t - mt) - p.x)));
  const ok = worst < 0.6;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${n} bars, worst deviation ${worst.toFixed(2)}px`);
  if (!ok) { fail++; console.log(pts.map((p) => `${p.id}: x=${p.x} predicted=${(mx + b * (p.t - mt)).toFixed(1)}`).join('\n')); }
}
// Lint severities must reflect what Mermaid really does: errors must fail to render (or break the chart), warnings must still render.
const { lintDiagram } = req('../.conformance-build/gantt.cjs');
const behaviour = [
  ['invalid start (id used as start)', 'gantt\ndateFormat YYYY-MM-DD\nt :r, 3d', 'ganttInvalidDate', 'error', 'throws'],
  ['invalid start (month 13)', 'gantt\ndateFormat YYYY-MM-DD\nt :a, 2024-13-01, 3d', 'ganttInvalidDate', 'error', 'throws'],
  ['day 32', 'gantt\ndateFormat YYYY-MM-DD\nt :a, 2024-01-32, 3d', 'ganttInvalidDate', 'error', 'throws'],
  ['rolled date (Feb 31)', 'gantt\ndateFormat YYYY-MM-DD\nt :a, 2024-02-31, 3d\nu :b, 2024-02-01, 1d', 'ganttRolledDate', 'warning', 'renders'],
  ['invalid duration word', 'gantt\ndateFormat YYYY-MM-DD\nt :a, 2024-01-01, soon\nu :b, 2024-01-02, 1d', 'ganttInvalidDuration', 'warning', 'renders'],
  ['end before start', 'gantt\ndateFormat YYYY-MM-DD\nt :a, 2024-02-01, 2024-01-01\nu :b, 2024-01-02, 1d', 'ganttEndBeforeStart', 'warning', 'renders'],
  ['dependency cycle', 'gantt\ndateFormat YYYY-MM-DD\na :a, after b, 1d\nb :b, after a, 1d', 'ganttDependencyCycle', 'error', 'nan'],
];
for (const [name, src, ruleId, severity, mermaidDoes] of behaviour) {
  const hit = lintDiagram(parseMermaid(src)).find((x) => x.ruleId === ruleId);
  const outcome = await page.evaluate(async (text) => {
    try {
      const { svg } = await mermaid.render('x' + Math.random().toString(36).slice(2), text);
      const h = document.getElementById('h'); h.innerHTML = svg;
      return [...h.querySelectorAll('rect.task')].some((r) => r.getAttribute('x') === 'NaN') ? 'nan' : 'renders';
    } catch { return 'throws'; }
  }, src);
  const ok = hit?.severity === severity && outcome === mermaidDoes;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: lint ${hit ? hit.severity : 'none'} (expected ${severity}), Mermaid ${outcome} (expected ${mermaidDoes})`);
  if (!ok) fail++;
}
await browser.close();
process.exit(fail ? 1 : 0);
