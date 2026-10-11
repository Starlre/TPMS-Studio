// Capture real generated examples; run with --project and --output for external artifact folders.
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const argument = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const root = path.resolve(argument('--project', path.resolve(__dirname, '../..')));
const output = path.resolve(argument('--output', path.join(root, 'docs')));
const examples = path.resolve(argument('--examples', path.join(root, 'examples/showcase')));
const only = argument('--only', 'all');
assert.ok(['all', 'gyroid', 'sphere'].includes(only), 'Choose all, gyroid or sphere.');
const { _electron: electron } = createRequire(path.join(root, 'desktop/package.json'))('playwright');

async function main() {
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-gallery-'));
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: process.env.TPMS_PYTHON || 'python', PYTHONUTF8: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(temporary, 'profile')}`], env, timeout: 60000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(180000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const reports = [];
  const captures = [];
  let sectionExportUnchanged = false;
  async function done(text) {
    await page.waitForFunction(t => !!document.querySelector('.error-banner') || document.querySelector('.statusbar')?.textContent.includes(t) && !document.querySelector('.generate')?.textContent.includes('正在计算'), text, { timeout: 180000 });
    assert.equal(await page.locator('.error-banner').count(), 0, await page.locator('.error-banner').allTextContents());
  }
  async function theme(name) {
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== name) {
      await page.getByRole('button', { name: name === 'light' ? '切换亮色主题' : '切换暗色主题', exact: true }).click();
    }
  }
  async function capture(name) {
    await theme('dark'); await page.mouse.move(10, 10); await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.locator('.error-banner').count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, name), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' });
    captures.push(name);
    console.log(`Captured ${name}`);
  }
  async function open(file) {
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, file);
    await page.getByRole('button', { name: '打开', exact: true }).click(); await done('项目已打开');
    await page.waitForTimeout(300);
    await page.getByRole('checkbox', { name: '全部实体', exact: true }).uncheck();
    assert.equal(await page.getByRole('checkbox', { name: '全部实体', exact: true }).isChecked(), false);
    await page.getByRole('button', { name: '收起所有节点', exact: true }).click();
    await page.getByRole('button', { name: '生成工作流', exact: true }).click(); await done('模型已生成');
    assert.equal(await page.locator('.error-banner').count(), 0);
    await page.locator('.panel-scroll').evaluate(el => { el.scrollTop = 0; });
    await page.getByRole('button', { name: '重置视角', exact: true }).click();
  }
  async function exportMesh(name) {
    const destination = path.join(temporary, name + '.stl');
    await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, destination);
    await page.locator('.export-menu>summary').click();
    await page.getByRole('button', { name: '导出 STL / OBJ / PLY', exact: true }).click(); await done('已导出');
    reports.push({ name, stl: destination, metrics: await page.locator('.metrics').allTextContents() });
  }
  try {
    await done('模型已生成');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1680, 1040));
    if (only === 'all' || only === 'gyroid') {
    await open(path.join(examples, 'gyroid-flanged-core.json'));
    await capture('showcase-gyroid-dark.png');
    await exportMesh('gyroid-flanged-core');

    await page.getByRole('button', { name: '剖切与测量', exact: true }).click();
    const panel = page.locator('.inspection-panel');
    await panel.getByRole('checkbox', { name: '启用剖切', exact: true }).check();
    await panel.getByLabel('平面方向', { exact: true }).selectOption('Y');
    await panel.getByRole('button', { name: '居中', exact: true }).click();
    await panel.getByRole('checkbox', { name: '保留法向正侧', exact: true }).check();
    await page.waitForFunction(() => { const s = document.querySelector('.section-statistics'); return s && s.querySelector('.metric') && !s.textContent.includes('计算中'); });
    assert.equal(await panel.locator('.inspection-warning').count(), 0);
    await page.locator('.inspection-scroll').evaluate(el => { el.scrollTop = 0; });
    await capture('showcase-gyroid-section.png');
    const firstExport = await fs.readFile(reports[0].stl);
    await exportMesh('gyroid-after-section');
    assert.deepEqual(await fs.readFile(reports[1].stl), firstExport);
    sectionExportUnchanged = true;
    await panel.getByRole('button', { name: '恢复完整模型并清除测量', exact: true }).click();
    }

    if (only === 'all' || only === 'sphere') {
    await open(path.join(examples, 'perforated-ring-sphere.json'));
    await capture('showcase-sphere-dark.png');
    await exportMesh('perforated-ring-sphere');
    await page.getByRole('checkbox', { name: '全部实体', exact: true }).check();
    await page.waitForFunction(() => document.querySelector('.canvas-host')?.dataset.objectCount === '11' && !document.querySelector('.layout-note')?.textContent.includes('正在更新'));
    const project = JSON.parse(await fs.readFile(path.join(examples, 'perforated-ring-sphere.json'), 'utf8'));
    for (const n of project.scene.nodes.filter(n => !['n3', 'n4', 'n6', 'n7', 'n8'].includes(n.id))) {
      await page.locator(`[data-node-id="${n.id}"]`).getByRole('button', { name: `隐藏实体 ${n.name}`, exact: true }).click();
    }
    await page.waitForFunction(() => document.querySelector('.canvas-host')?.dataset.objectCount === '5');
    await page.getByRole('checkbox', { name: '半透明', exact: true }).check();
    await page.locator('.layout-legend').getByRole('button', { name: 'X 向贯穿流道', exact: true }).click();
    await page.getByRole('button', { name: '重置视角', exact: true }).click();
    await capture('showcase-layout-dark.png');
    }

    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(temporary, 'capture-report.json'), JSON.stringify({ exports: reports, errors }, null, 2));
    console.log(JSON.stringify({ result: 'passed', screenshots: captures, exportedModels: reports.map(r => r.name), sectionExportUnchanged, errors, temporary }, null, 2));
  } catch (e) {
    await page.screenshot({ path: path.join(output, 'capture-failure.png') });
    console.error(await page.locator('.statusbar').innerText()); console.error(await page.locator('.error-banner,.layout-note').allTextContents()); throw e;
  } finally { await app.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
