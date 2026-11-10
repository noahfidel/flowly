// Usage: node shot-board.mjs <outFile> [scheme]  — board screenshot via docs/promo/shot-lib.mjs (sidebar cropped).
import { launch, open, shot, pageText } from '../../promo/shot-lib.mjs';
import { writeFile } from 'node:fs/promises';
const [out, scheme = 'light'] = process.argv.slice(2);
const browser = await launch();
try {
  const s = await open(browser, { w: Number(process.env.SHOT_W || 1700), h: 1000, scheme, project: 'Tinylink' });
  await shot(s, out);
  await writeFile(out.replace(/\.png$/, '.txt'), await pageText(s));
  console.log('shot', out, 'errors', s.errors.length);
  await s.context.close();
} finally { await browser.close(); }
