// P3 screenshots via docs/promo/shot-lib.mjs. Usage: node shots-p3.mjs <step> [name]
//   detect     Edit project, switch on (unsaved): built-in check + detected commands + Use these
//   insights   the Insights page (rework nudge at the top)
//   setup      Insights → Set up auto review: Edit project opens with the analysis; waits for its draft
//   settings   Edit project as it is (draft, checks)
//   card       a card's drawer (title prefix in TITLE)
import { launch, open, shot, pageText } from '../../promo/shot-lib.mjs';
import { writeFile } from 'node:fs/promises';
const dir = new URL('./', import.meta.url).pathname;
const step = process.argv[2];
const name = process.argv[3] || step;
const browser = await launch();
const s = await open(browser, { w: Number(process.env.W || 2300), h: 1300, project: 'Tinylink' });
const save = async (n) => { await s.page.mouse.move(s.w / 2, 8); await s.page.waitForTimeout(500); await shot(s, `${dir}p3-${n}.png`); };
const out = {};
try {
  if (step === 'detect') {
    await s.page.getByRole('button', { name: 'Project settings' }).first().click();
    await s.page.waitForTimeout(1500);
    await s.page.getByRole('switch', { name: /Auto review/ }).first().click();
    await s.page.waitForTimeout(2500);
    await s.page.getByText('Use these', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
    out.suggest = await s.page.getByText('Suggest checks from past cards', { exact: true }).count();
    out.useThese = await s.page.getByText('Use these', { exact: true }).count();
    await save(`${name}-before`);
    await s.page.getByText('Use these', { exact: true }).first().click();
    await s.page.waitForTimeout(800);
    await save(`${name}-after`);
    out.text = (await pageText(s)).match(/Checks[\s\S]{0,300}/)?.[0];
  } else if (step === 'insights') {
    await s.page.getByText('Insights', { exact: true }).first().click();
    await s.page.waitForTimeout(4000);
    out.nudge = await s.page.getByText('Set up auto review', { exact: true }).count();
    await save(name);
    await writeFile(`${dir}p3-${name}.txt`, await pageText(s));
  } else if (step === 'setup') {
    await s.page.getByText('Insights', { exact: true }).first().click();
    await s.page.waitForTimeout(4000);
    await s.page.getByText('Set up auto review', { exact: true }).first().click();
    await s.page.waitForTimeout(3000);
    await save(`${name}-running`);
    out.running = await s.page.getByText(/Analyzing past cards/).count();
    for (let i = 0; i < 180 && !(await s.page.getByText('Checks from past cards', { exact: true }).count()); i++) await s.page.waitForTimeout(2000);
    await s.page.waitForTimeout(1000);
    out.draft = await s.page.getByText('Checks from past cards', { exact: true }).count();
    await save(`${name}-draft`);
    await writeFile(`${dir}p3-${name}-draft.txt`, await pageText(s));
  } else if (step === 'settings') {
    await s.page.getByRole('button', { name: 'Project settings' }).first().click();
    await s.page.waitForTimeout(2000);
    await s.page.getByText('Auto review', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
    await save(name);
  } else if (step === 'card') {
    await s.page.getByRole('button', { name: new RegExp(`^Open task ${process.env.TITLE}`) }).first().click();
    await s.page.waitForTimeout(3000);
    await save(name);
    await writeFile(`${dir}p3-${name}.txt`, await pageText(s));
  }
  console.log(JSON.stringify({ ...out, errors: s.errors }));
} finally {
  await browser.close();
}
