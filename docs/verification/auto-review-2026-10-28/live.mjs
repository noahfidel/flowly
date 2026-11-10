// One open page across a whole review: the strip expands when Rerun starts it and folds when it ends.
import { launch, open, shot } from '../../promo/shot-lib.mjs';
const dir = new URL('./', import.meta.url).pathname;
const browser = await launch();
const s = await open(browser, { w: 2300, h: 1000, project: 'Tinylink' });
const clip = async (name) => { await s.page.mouse.move(s.w / 2, 8); await s.page.waitForTimeout(300); await shot(s, `${dir}live-${name}.png`); };
const strip = () => s.page.getByText('Reviewing', { exact: true }).count();
try {
  await clip('0-before');
  const before = await strip();
  await s.page.getByRole('button', { name: /^Open task Auto review fixture/ }).first().click();
  await s.page.waitForTimeout(2000);
  await s.page.getByRole('button', { name: 'Rerun', exact: true }).first().click();
  await s.page.keyboard.press('Escape');
  let shown = 0;
  for (let i = 0; i < 20 && !shown; i++) { await s.page.waitForTimeout(500); shown = await strip(); }
  await s.page.waitForTimeout(400);
  await clip('1-running');
  let gone = false;
  for (let i = 0; i < 70 && !gone; i++) { await s.page.waitForTimeout(1000); gone = (await strip()) === 0; }
  await s.page.waitForTimeout(600);
  await clip('2-after');
  console.log(JSON.stringify({ before, shown, gone, errors: s.errors }));
} finally {
  await browser.close();
}
