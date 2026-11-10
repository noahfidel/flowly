// Sends one user message to card A and captures the review strip while it runs (headless browser, never the user's windows).
import { launch, open, shot, pageText } from '../../promo/shot-lib.mjs';
import { writeFile } from 'node:fs/promises';
const dir = new URL('.', import.meta.url).pathname;
const browser = await launch();
try {
  const s = await open(browser, { w: 2600, h: 1100, project: 'Tinylink' });
  const p = s.page;
  await p.getByText('guardrails-live A', { exact: false }).first().click();
  await p.waitForTimeout(2000);
  const box = p.locator('textarea[data-composer-input]').first();
  await box.click();
  await box.fill('请重新运行 npm test，确认通过后再交付到 In review');
  await box.press('Enter');
  await p.waitForTimeout(1500);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(1500);
  const seen = new Set();
  let shots = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 300000 && shots < 1) {
    const hits = await p.locator('text=/Reviewing|Auto review|judging|running npm|passed · /').allInnerTexts().catch(() => []);
    for (const h of hits) if (!seen.has(h)) { seen.add(h); console.log('seen:', h.slice(0, 120)); }
    if (hits.some((h) => /Reviewing|running npm|judging/.test(h))) { await shot(s, `${dir}item1-card-a-running.png`); shots++; }
    await p.waitForTimeout(300);
  }
  await p.waitForTimeout(12000);
  await shot(s, `${dir}item1-card-a-after-review.png`);
  await writeFile(`${dir}item1-card-a-after-review.txt`, await pageText(s));
  console.log('shots', shots, 'errors', s.errors.length);
  await s.context.close();
} finally { await browser.close(); }
