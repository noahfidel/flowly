// Screenshots for the auto review live check, via docs/promo/shot-lib.mjs. Usage: node shots.mjs <prefix> [settings]
import { launch, open, shot, pageText } from '../../promo/shot-lib.mjs';
import { writeFile } from 'node:fs/promises';
const dir = new URL('./', import.meta.url).pathname;
const prefix = process.argv[2] || 'state';
const withSettings = process.argv.includes('settings');
const withSession = process.argv.includes('session');
const browser = await launch();
const s = await open(browser, { w: Number(process.env.W || 3300), h: 1000, project: 'Tinylink' });
const save = async (name) => { await s.page.mouse.move(s.w / 2, 8); await s.page.waitForTimeout(400); await shot(s, `${dir}${prefix}-${name}.png`); };
try {
  await save('board');
  const boardOnly = process.argv.includes('board-only');
  if (boardOnly) { console.log(JSON.stringify({ errors: s.errors })); await browser.close(); process.exit(0); }
  await s.page.getByRole('button', { name: /^Open task Auto review fixture/ }).first().click();
  await s.page.waitForTimeout(2500);
  const section = s.page.getByText('Auto review', { exact: true }).first();
  await section.scrollIntoViewIfNeeded().catch(() => {});
  await s.page.waitForTimeout(800);
  if (process.argv.includes('rerun')) {
    await s.page.getByRole('button', { name: 'Rerun', exact: true }).first().click();
    await s.page.waitForTimeout(6000);
  }
  await save('drawer');
  await writeFile(`${dir}${prefix}-drawer.txt`, (await pageText(s)));
  if (withSession) {
    await s.page.getByText('Haiku · Auto review fixture').first().click();
    await s.page.waitForTimeout(3500);
    await s.page.getByText(/Flowly auto review · rework/).first().scrollIntoViewIfNeeded().catch(() => {});
    await s.page.waitForTimeout(800);
    await save('session');
    await s.page.keyboard.press('Escape').catch(() => {});
  }
  await s.page.keyboard.press('Escape').catch(() => {});
  await s.page.waitForTimeout(800);
  await s.page.getByRole('button', { name: /^Needs attention/ }).first().click().catch(() => {});
  await s.page.waitForTimeout(1500);
  await save('attention');
  await s.page.keyboard.press('Escape').catch(() => {});
  if (withSettings) {
    await s.page.waitForTimeout(800);
    await s.page.getByRole('button', { name: 'Project settings' }).first().click();
    await s.page.waitForTimeout(1500);
    await s.page.getByText('Review checks', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
    await s.page.waitForTimeout(600);
    await save('settings');
  }
  console.log(JSON.stringify({ errors: s.errors }));
} finally {
  await browser.close();
}
