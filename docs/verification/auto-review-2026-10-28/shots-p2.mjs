// P2 screenshots via docs/promo/shot-lib.mjs. Usage: node shots-p2.mjs <step>
//   setup   project settings → Set up with AI → the setup card opens
//   draft   project settings with the proposed draft; then Apply (APPLY=1)
//   card    the fixture card's drawer (Auto review section)
import { launch, open, shot, pageText } from '../../promo/shot-lib.mjs';
import { writeFile } from 'node:fs/promises';
const dir = new URL('./', import.meta.url).pathname;
const step = process.argv[2];
const browser = await launch();
const s = await open(browser, { w: Number(process.env.W || 2300), h: 1100, project: 'Tinylink' });
const save = async (name) => { await s.page.mouse.move(s.w / 2, 8); await s.page.waitForTimeout(500); await shot(s, `${dir}p2-${name}.png`); };
const settings = async () => {
  await s.page.getByRole('button', { name: 'Project settings' }).first().click();
  await s.page.waitForTimeout(1500);
  await s.page.getByText('Auto review', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
  await s.page.waitForTimeout(600);
};
try {
  if (step === 'setup') {
    await settings();
    await s.page.getByRole('switch', { name: /Auto review/ }).first().click();
    await s.page.waitForTimeout(800);
    await save('settings-before');
    await s.page.getByText('Set up with AI', { exact: true }).first().click();
    await s.page.waitForTimeout(6000);
    await save('setup-card');
    await writeFile(`${dir}p2-setup-card.txt`, await pageText(s));
  } else if (step === 'draft') {
    await settings();
    await s.page.getByText('Proposed rules', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
    await s.page.waitForTimeout(600);
    await save('draft-settings');
    await writeFile(`${dir}p2-draft-settings.txt`, await pageText(s));
    if (process.env.APPLY) {
      await s.page.getByRole('button', { name: /^Apply/ }).first().click();
      await s.page.waitForTimeout(2500);
      await s.page.getByText('Auto review', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
      await s.page.waitForTimeout(600);
      await save('applied-settings');
      await writeFile(`${dir}p2-applied-settings.txt`, await pageText(s));
    }
  } else if (step === 'setup-drawer') {
    await s.page.getByRole('button', { name: /^Open task Auto review setup/ }).first().click();
    await s.page.waitForTimeout(2500);
    await s.page.getByText('Proposed rules', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
    await s.page.waitForTimeout(600);
    await save('setup-drawer');
  } else if (step === 'card') {
    const name = process.env.NAME || 'card';
    await save(`${name}-board`);
    await s.page.getByRole('button', { name: /^Open task Auto review fixture/ }).first().click();
    await s.page.waitForTimeout(2500);
    await s.page.getByText('LLM review', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
    await s.page.waitForTimeout(800);
    await save(`${name}-drawer`);
    await writeFile(`${dir}p2-${name}-drawer.txt`, await pageText(s));
  }
  if (step === 'rerun-live') {
    await s.page.getByRole('button', { name: /^Open task Auto review fixture/ }).first().click();
    await s.page.waitForTimeout(2500);
    await s.page.getByRole('button', { name: 'Rerun', exact: true }).first().click();
    const running = s.page.getByText(/^Reviewing \d+\/\d+$/).first();
    let seen = '';
    for (let i = 0; i < 30 && !seen; i++) { await s.page.waitForTimeout(500); if (await running.count()) seen = await running.innerText(); }
    await s.page.getByText('LLM review', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
    await save('running');
    let done = false;
    for (let i = 0; i < 300 && !done; i++) { await s.page.waitForTimeout(1000); done = (await s.page.getByText(/^Reviewing/).count()) === 0; }
    await s.page.waitForTimeout(1500);
    await s.page.getByText('LLM review', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
    await save('llm-drawer');
    await writeFile(`${dir}p2-llm-drawer.txt`, await pageText(s));
    console.log(JSON.stringify({ seen, done }));
  }
  console.log(JSON.stringify({ errors: s.errors }));
} finally {
  await browser.close();
}
