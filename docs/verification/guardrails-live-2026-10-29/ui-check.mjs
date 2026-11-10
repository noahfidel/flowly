import { launch, open, shot, pageText } from '../../promo/shot-lib.mjs';
import { writeFile } from 'node:fs/promises';
const dir = new URL('.', import.meta.url).pathname;
const browser = await launch();
try {
  const s = await open(browser, { w: 2600, h: 1100, project: 'Tinylink' });
  const p = s.page;
  await p.getByText(/^Guardrails/).first().click();
  await p.waitForTimeout(3000);
  await shot(s, `${dir}item2-guardrails-page.png`);
  await writeFile(`${dir}item2-guardrails-page.txt`, await pageText(s));
  await p.keyboard.press('Escape');
  await p.waitForTimeout(1500);
  await p.getByText('guardrails-live E', { exact: false }).first().click();
  await p.waitForTimeout(3000);
  await writeFile(`${dir}item3-card-e-drawer.txt`, await pageText(s));
  await shot(s, `${dir}item3-card-e-drawer.png`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(1500);
  await p.getByText('guardrails-live C', { exact: false }).first().click();
  await p.waitForTimeout(3000);
  await writeFile(`${dir}item2-card-c-drawer.txt`, await pageText(s));
  console.log('errors', s.errors.length);
  await s.context.close();
} finally { await browser.close(); }
