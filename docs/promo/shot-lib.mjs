// Shared screenshot module for release shots and UI verification (AGENTS.md: verification screenshots must use it).
//   import { launch, open, shot, pageText } from './shot-lib.mjs';
//   const browser = await launch();
//   const s = await open(browser, { w: 1700, h: 1000, project: 'Tinylink' });
//   await shot(s, 'out/board.png');          // sidebar is cropped away
//   const text = await pageText(s);           // sidebar text is left out
// Playwright and Chromium are looked up, never hard-coded: PLAYWRIGHT_MODULE / PLAYWRIGHT_CHROMIUM_PATH, then the
// repo's node_modules, global npm, the npx cache, and the ms-playwright browser cache.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SIDEBAR_WIDTH = 320; // Paseo's left host sidebar (personal workspaces); never part of a shot

const dirs = (p) => { try { return readdirSync(p).map((n) => join(p, n)); } catch { return []; } };

async function loadPlaywright() {
  const here = createRequire(import.meta.url);
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  try { candidates.push(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')); } catch { /* no npm */ }
  for (const d of dirs(join(homedir(), '.npm', '_npx'))) candidates.push(join(d, 'node_modules', 'playwright'));
  for (const c of candidates) {
    try { return await import(pathToFileURL(here.resolve(c)).href); } catch { /* next */ }
  }
  throw new Error('Playwright not found. Run `npm i --no-save playwright` (or set PLAYWRIGHT_MODULE=/path/to/playwright).');
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), 'Library', 'Caches', 'ms-playwright'), join(homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  const rel = ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-win/chrome.exe'];
  const builds = roots.flatMap(dirs).filter((d) => /chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
  for (const b of builds) for (const r of rel) if (existsSync(join(b, r))) return join(b, r);
  return undefined;
}

export async function launch() {
  const pw = await loadPlaywright();
  const chromium = (pw.chromium ?? pw.default?.chromium);
  try { return await chromium.launch({ headless: true }); } catch (e) {
    const executablePath = findChromium();
    if (!executablePath) throw new Error(`Chromium not found (${String(e).split('\n')[0]}). Run \`npx playwright install chromium\` or set PLAYWRIGHT_CHROMIUM_PATH.`);
    return chromium.launch({ headless: true, executablePath });
  }
}

// Hide every project tab except `project` (the tab row's other labelled children; "+" and the chevron have no text).
export async function hidePrivate(page, project) {
  await page.evaluate(({ project, sidebar }) => {
    const label = (el) => el.textContent.trim();
    const leaf = [...document.querySelectorAll('*')].find((el) => !el.children.length && label(el) === project && el.getBoundingClientRect().x > sidebar && el.getBoundingClientRect().y < 140);
    if (!leaf) return;
    let tab = leaf;
    while (tab.parentElement && [...tab.parentElement.children].filter((c) => label(c)).length < 2) tab = tab.parentElement;
    if (!tab.parentElement) return;
    // Only siblings on the tab's own row: in the compact header the walk can reach the column that also holds the board.
    const row = tab.getBoundingClientRect();
    for (const sib of tab.parentElement.children) {
      const r = sib.getBoundingClientRect();
      if (sib !== tab && label(sib) && Math.abs(r.y - row.y) < 12 && r.height < 80) sib.style.display = 'none';
    }
  }, { project, sidebar: SIDEBAR_WIDTH - 20 });
}

// Click a leaf element whose exact text is `text` inside a horizontal band of the page. The two bands are the
// host sidebar (x < SIDEBAR_WIDTH: the Flowly entry) and the plugin area (x >= SIDEBAR_WIDTH, near the top:
// the project tab row). Text search anywhere else matches session entries named after cards, which is how open()
// used to land on the wrong project. Polls until the leaf appears; false on timeout.
async function clickLeaf(page, text, { minX = 0, maxX = Infinity, yMax = 160, timeout = 20000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const point = await page.evaluate(({ text, minX, maxX, yMax }) => {
      const el = [...document.querySelectorAll('*')].find((n) => {
        if (n.children.length || n.textContent.trim() !== text) return false;
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.x >= minX && r.x < maxX && r.y < yMax;
      });
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, { text, minX, maxX, yMax });
    if (point) {
      await page.mouse.click(point.x, point.y);
      return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

// Open Paseo, enter the Flowly project `project`. Returns a session; `clip` excludes the sidebar.
// The Flowly entry is clicked inside the host sidebar and the project tab inside the plugin tab row, both by exact
// text in that band only. A project without an open tab is entered through the "All projects" chooser (its rows are
// buttons named by project title). Every step waits or fails: open() never silently continues on the wrong screen
// or project.
export async function open(browser, { w, h, scheme = 'light', locale = 'en-US', project = 'Tinylink', url = 'https://app.paseo.sh' }) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme, locale });
  await context.grantPermissions(['local-network-access'], { origin: url });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  if (!(await clickLeaf(page, 'Flowly', { maxX: SIDEBAR_WIDTH - 20, yMax: 400, timeout: 20000 })))
    throw new Error('Flowly entry not found in the host sidebar');
  if (!(await clickLeaf(page, project, { minX: SIDEBAR_WIDTH, yMax: 160, timeout: 8000 }))) {
    // No open tab for the project: switch through the project chooser. Wide layouts open it from the
    // tab row's "All projects" chevron, compact layouts from the toolbar's "Project: …" switcher.
    const chooser = page.locator('button[aria-label^="All projects"], button[aria-label^="Project:"]').first();
    await chooser.click({ timeout: 8000 });
    // The chooser's rows are buttons whose accessible name is the project title; exact match keeps
    // "flowly" from matching "flowly-test" and never touches the board's "Open task …" cards.
    const row = page.getByRole('button', { name: project, exact: true }).last();
    await row.click({ timeout: 15000 });
    // The project must now be the open one: its tab (wide) or the toolbar switcher's name (compact).
    const active = await page.evaluate(({ project, sidebar }) => {
      const tab = [...document.querySelectorAll('*')].find((n) => {
        if (n.children.length || n.textContent.trim() !== project) return false;
        const r = n.getBoundingClientRect();
        return r.x > sidebar && r.y < 160;
      });
      if (tab) return true;
      return [...document.querySelectorAll('button[aria-label]')].some((n) => n.getAttribute('aria-label').startsWith('Project: ') && n.getAttribute('aria-label').includes(project));
    }, { project, sidebar: SIDEBAR_WIDTH });
    if (!active) throw new Error(`Project "${project}" did not become the open project after choosing it`);
  }
  // Lanes (any locale) prove the project's board rendered; cards' names carry the locale's text.
  await page.waitForSelector('[data-testid^="lane-"], [data-testid^="card-"], [aria-label^="Open task"]', { timeout: 45000 });
  await page.waitForTimeout(3500);
  await hidePrivate(page, project);
  return { page, context, errors, w, h, project, clip: { x: SIDEBAR_WIDTH, y: 0, width: w - SIDEBAR_WIDTH, height: h } };
}

// Open the board card titled `title` — nothing else — and wait until its sidebar shows the title. The card's
// accessible name starts "Open task {title}." (UI-UX-SPEC §2, automation names), so getByRole disambiguates it
// from host session entries that reuse the title as their own text. The English prefix is deliberate: open()
// pins the locale, and a locale-free substring match could not tell a title from another card's longer title.
// Exactly one card must match; ambiguity is an error, never a blind click on the first hit.
export async function openCard(s, title, { timeout = 15000 } = {}) {
  const name = new RegExp(`^Open task ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`);
  const card = s.page.getByRole('button', { name });
  const found = await card.count();
  if (found === 0) throw new Error(`No board card is titled "${title}"`);
  if (found > 1) throw new Error(`${found} board cards are titled "${title}"; pass an unambiguous title`);
  await card.click({ timeout });
  const drawer = s.page.getByTestId('task-drawer-motion').filter({ hasText: title }).first();
  await drawer.waitFor({ state: 'visible', timeout });
  return card;
}

// Close the card sidebar (Esc on desktop web, then the Close button) and wait until it stops taking pointers.
export async function closeCard(s, { timeout = 15000, closeLabel = 'Close side bar' } = {}) {
  const closed = () => s.page.waitForFunction(() => {
    const drawer = document.querySelector('[data-testid="task-drawer-motion"]');
    return !drawer || drawer.style.pointerEvents === 'none';
  }, null, { timeout });
  await s.page.keyboard.press('Escape');
  try {
    await closed();
  } catch {
    await s.page.locator(`button[aria-label="${closeLabel}"]`).first().click({ timeout });
    await closed();
  }
}

// Screenshot to `path`. An explicit clip is in page coordinates but is never allowed to reach into the sidebar.
export async function shot(s, path, clip = s.clip) {
  await hidePrivate(s.page, s.project);
  const x = Math.max(clip.x, SIDEBAR_WIDTH);
  await s.page.screenshot({ path, clip: { ...clip, x, width: clip.width - (x - clip.x) } });
}

// Visible page text with everything left of the sidebar edge removed.
export async function pageText(s) {
  return s.page.evaluate((sidebar) => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.trim();
      if (!t) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width && r.height && r.x >= sidebar) out.push(t);
    }
    return out.join('\n');
  }, SIDEBAR_WIDTH);
}
