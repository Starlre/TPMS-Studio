// Quick UI capture: launch app, generate a fast TPMS model, screenshot both themes.
// Usage: node desktop/tests/capture-quick.cjs [--output DIR]
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.argv[process.argv.indexOf('--output') + 1] || path.join(os.tmpdir(), 'tpms-quick-capture'));
const { _electron: electron } = createRequire(path.join(root, 'desktop/package.json'))('playwright');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-quick-'));
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: 'D:\\anaconda3\\python.exe', PYTHONUTF8: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(temporary, 'profile')}`],
    env, timeout: 60000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // Wait for the ribbon to appear (app ready)
  await page.waitForSelector('.ribbon, .toolbar, header', { timeout: 60000 });
  await page.setViewportSize ? null : null;
  await page.waitForTimeout(1500);

  // Small fast model: switch to TPMS workspace if needed, then generate directly.
  const generate = page.locator('button:has-text("生成模型"), button:has-text("生成工作流"), .generate');
  if (await generate.count()) {
    await generate.first().click();
    // Wait for generation to finish (statusbar stops spinning); 24 samples is fast.
    await page.waitForTimeout(6000);
  }
  await page.mouse.move(10, 10);
  await page.waitForTimeout(900);

  // Dark theme shot
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.screenshot({ path: path.join(output, 'ui-dark.png'), scale: 'css' });
  console.log('Captured ui-dark.png (theme=' + theme + ')');

  // Toggle theme and shoot light
  const toggle = page.locator('button[title*="主题"], button:has-text("切换亮色主题"), button:has-text("切换暗色主题")');
  if (await toggle.count()) {
    await toggle.first().click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(output, 'ui-light.png'), scale: 'css' });
    console.log('Captured ui-light.png (theme=' + await page.evaluate(() => document.documentElement.dataset.theme) + ')');
  }

  if (errors.length) console.log('Page errors:', errors.join(' | '));
  await app.close();
  console.log('DONE ' + output);
})().catch(e => { console.error(e); process.exit(1); });
