// Acceptance run for the card "看板卡片补齐可访问名称，让 UI 自动化验证可定位" (aef0a68c):
// a script opens a board card's sidebar by its title alone, five times in a row, on the real
// desktop web app through docs/promo/shot-lib.mjs (AGENTS.md: verification screenshots and page
// text come from shot-lib). Usage:
//   node run.mjs          # 5x open+close by title
//   node run.mjs --shot   # also save board.png / drawer.png as evidence
//   node run.mjs --title "…" --project flowly
// The real "flowly" project's board is read-only for this run (open + close only). The Tinylink
// fixture does not exist on this machine; the default title is this card's own title.
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, open, openCard, closeCard, shot } from '../../promo/shot-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const TITLE = arg('--title', '看板卡片补齐可访问名称，让 UI 自动化验证可定位');
const PROJECT = arg('--project', 'flowly');
// A second, different card proves the name is not a one-off; titles move with their cards, so
// this leg runs only when --second names a card that is currently on the board.
const SECOND = arg('--second', '');
const RUNS = 5;

const browser = await launch();
const s = await open(browser, { w: 1700, h: 1000, project: PROJECT });
const results = [];
const attempt = async (title, shotFile) => {
  const started = Date.now();
  await openCard(s, title);
  if (shotFile) await shot(s, shotFile).catch(() => undefined);
  await closeCard(s);
  return { title, ok: true, ms: Date.now() - started };
};
try {
  for (let i = 1; i <= RUNS; i++) {
    const r = await attempt(TITLE, process.argv.includes('--shot') && i === 1 ? `${here}/drawer-open.png` : undefined);
    results.push({ run: i, ...r });
    console.log(`run ${i}/${RUNS}: opened and closed "${r.title}" (${r.ms} ms)`);
  }
  if (SECOND) {
    results.push({ run: 'second-card', ...(await attempt(SECOND)) });
    console.log(`second card: opened and closed "${SECOND}"`);
  }
  if (process.argv.includes('--shot')) await shot(s, `${here}/board.png`);
} catch (error) {
  results.push({ run: results.length + 1, ok: false, error: String(error).slice(0, 300) });
  console.error(String(error).split('\n')[0]);
} finally {
  await browser.close();
}

const report = {
  check: 'Open a card sidebar by title only, 5 consecutive times (+1 second card)',
  project: PROJECT,
  title: TITLE,
  secondTitle: SECOND,
  date: new Date().toISOString(),
  script: 'docs/verification/board-card-open-2026-11-05/run.mjs',
  command: process.argv.join(' '),
  passed: results.length === RUNS + (SECOND ? 1 : 0) && results.every((r) => r.ok) && s.errors.length === 0,
  runs: results,
  pageErrors: s.errors,
};
writeFileSync(`${here}/report.json`, JSON.stringify(report, null, 2));
console.log(report.passed ? `PASS: ${RUNS}/${RUNS} consecutive opens by title` : `FAIL: ${results.filter((r) => r.ok).length}/${RUNS} succeeded`);
process.exit(report.passed ? 0 : 1);
