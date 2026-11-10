// Board open with no drawer; a review of card A is triggered by a CLI message; captures the card-face strip while it runs.
import { launch, open, shot } from '../../promo/shot-lib.mjs';
import { execFileSync } from 'node:child_process';
const dir = new URL('.', import.meta.url).pathname;
const browser = await launch();
try {
  const s = await open(browser, { w: 2600, h: 1100, project: 'Tinylink' });
  const p = s.page;
  execFileSync('paseo', ['send', '023f99c0-d0cb-4edb-aa5c-afe7b9b0b4ee', '请重新运行 npm test，确认通过后再交付到 In review，不需要改动代码。'], { stdio: 'ignore' });
  let shots = 0, lastSeen = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 360000 && shots < 1) {
    const hits = await p.locator('text=/Reviewing|judging|running npm|passed · /').allInnerTexts().catch(() => []);
    const h = hits.join(' || ');
    if (h && h !== lastSeen) { console.log('seen:', h.slice(0, 200)); lastSeen = h; }
    if (hits.some((x) => /Reviewing|judging|running npm/.test(x))) { await shot(s, `${dir}item1-card-a-running.png`); shots++; }
    await p.waitForTimeout(250);
  }
  await p.waitForTimeout(15000);
  await shot(s, `${dir}item1-card-a-finished.png`);
  console.log('shots', shots, 'errors', s.errors.length);
  await s.context.close();
} finally { await browser.close(); }
