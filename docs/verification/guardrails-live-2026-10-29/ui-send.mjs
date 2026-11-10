// Sends one message as the user through the Paseo composer of a card's session (headless browser; never the user's windows).
import { launch, open } from '../../promo/shot-lib.mjs';
const [cardText, message] = process.argv.slice(2);
const browser = await launch();
try {
  const s = await open(browser, { w: 2600, h: 1100, project: 'Tinylink' });
  const p = s.page;
  await p.getByText(cardText, { exact: false }).first().click();
  await p.waitForTimeout(2500);
  const box = p.locator('textarea[data-composer-input]').first();
  await box.click();
  await box.fill(message);
  await p.waitForTimeout(300);
  await box.press('Enter');
  await p.waitForTimeout(3000);
  console.log('left in box:', JSON.stringify(await box.inputValue()));
  await s.context.close();
} finally { await browser.close(); }
