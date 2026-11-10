import { launch, open, shot, pageText } from '../../promo/shot-lib.mjs';
const browser = await launch();
try {
  const s = await open(browser, { w: 2600, h: 1100, project: 'Tinylink' });
  const p = s.page;
  await p.getByText('guardrails-live A', { exact: false }).first().click();
  await p.waitForTimeout(2500);
  const n = await p.locator('textarea[data-composer-input]').count();
  console.log('composer textareas', n);
  console.log((await pageText(s)).split('\n').filter((l) => /Message|Send|Reply|composer|guardrails|Checked|Rework|Review/i.test(l)).slice(0, 25).join('\n'));
  await shot(s, new URL('./ui-probe.png', import.meta.url).pathname);
  await s.context.close();
} finally { await browser.close(); }
