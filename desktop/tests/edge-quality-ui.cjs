const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const argument = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const root = path.resolve(argument('--project', path.resolve(__dirname, '../..')));
const baseline = process.argv.includes('--baseline');
const { _electron: electron } = createRequire(path.join(root, 'desktop/package.json'))('playwright');

async function main() {
  const output = argument('--output', await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-edge-ui-')));
  await fs.mkdir(output, { recursive: true });
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: process.env.TPMS_PYTHON || 'python', PYTHONUTF8: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(output, baseline ? 'before-profile' : 'after-profile')}`], env, timeout: 60000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(180000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  async function done(text) {
    await page.waitForFunction(t => document.querySelector('.error-banner') || document.querySelector('.statusbar')?.textContent.includes(t) && !document.querySelector('.generate')?.textContent.includes('正在计算'), text);
    assert.equal(await page.locator('.error-banner').count(), 0, (await page.locator('.error-banner').allTextContents()).join('\n'));
  }
  async function exportMesh(name) {
    const file = path.join(output, name);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, file);
    const menu = page.locator('.export-menu'); if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
    await page.getByRole('button', { name: '导出 STL / OBJ / PLY', exact: true }).click(); await done('已导出');
    return fs.readFile(file);
  }
  async function capture(name) {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.mouse.move(10, 10); await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(output, name), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' });
  }
  try {
    await done('模型已生成');
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button',{name:'切换暗色主题',exact:true}).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1680, 1040));
    if (!baseline) {
      const implicit = page.getByRole('checkbox', { name: 'GPU 隐式曲面', exact: true });
      assert.ok(await implicit.isChecked()); assert.ok(await implicit.isEnabled());
      await page.getByRole('checkbox', { name: '线框', exact: true }).check();
      assert.ok(!await implicit.isChecked()); assert.ok(await implicit.isDisabled());
      await page.getByRole('checkbox', { name: '线框', exact: true }).uncheck(); assert.ok(await implicit.isChecked());
    }
    const node = (id, kind, dimensions, inputs = []) => ({ id, name: `${kind} ${id}`, kind, dimensions, inputs, position: [0,0,0], rotation: [0,0,0], blend: 2 });
    const fixture = { type: 'tpms-electron', version: 1, mode: 'nodes', parameters: {}, cfd: {},
      scene: { version: 1, cell_size: 0.3, root: 'n3', parameters: {}, nodes: [node('n1','sphere',[20]), node('n2','box',[50,50,10]), node('n3','intersection',[],['n1','n2'])] } };
    const file = path.join(output, 'cut-sphere.json'); await fs.writeFile(file, JSON.stringify(fixture));
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, file);
    await page.getByRole('button', { name: '打开', exact: true }).click(); await done('项目已打开');
    await page.getByRole('checkbox', { name: '全部实体', exact: true }).uncheck();
    await page.getByRole('button', { name: '收起所有节点', exact: true }).click();
    await page.getByRole('button', { name: '生成工作流', exact: true }).click(); await done('模型已生成');
    await capture(baseline ? 'edge-before-dark.png' : 'edge-after-standard-dark.png');
    const standard = await exportMesh(baseline ? 'baseline.stl' : 'standard.stl');
    if (baseline) { console.log(JSON.stringify({ baseline: true, output, errors })); return; }
    const reference = argument('--compare-stl', null);
    if (reference) assert.deepEqual(standard, await fs.readFile(reference), 'shading must not change exported triangles');
    const implicit = page.getByRole('checkbox', { name: 'GPU 隐式曲面', exact: true });
    assert.ok(!await implicit.isChecked()); assert.ok(await implicit.isDisabled());
    await page.getByRole('button', { name: '输出设置', exact: true }).click();
    assert.equal(await page.getByLabel('输出网格尺寸', { exact: true }).inputValue(), '0.3');
    await page.getByRole('group', { name: '网格精度预设' }).getByRole('button', { name: '精细', exact: false }).click();
    assert.equal(await page.getByLabel('输出网格尺寸', { exact: true }).inputValue(), '0.15');
    assert.ok(await page.locator('.export-menu .primary').isDisabled());
    await page.getByRole('button', { name: '生成工作流', exact: true }).click(); await done('模型已生成');
    const fine = await exportMesh('fine.stl'); assert.ok(fine.length > standard.length);
    await capture('edge-after-fine-dark.png');
    await page.getByRole('checkbox', { name: '线框', exact: true }).check(); await capture('edge-wireframe-dark.png');
    await page.getByRole('checkbox', { name: '线框', exact: true }).uncheck();
    await page.getByRole('button', { name: '剖切与测量', exact: true }).click();
    const panel = page.locator('.inspection-panel');
    await panel.getByRole('checkbox', { name: '启用剖切', exact: true }).check();
    await panel.getByLabel('平面方向', { exact: true }).selectOption('X');
    await panel.getByRole('button', { name: '居中', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.section-statistics .metric') && !document.querySelector('.section-statistics')?.textContent.includes('计算中'));
    assert.equal(await panel.locator('.inspection-warning').count(), 0);
    assert.deepEqual(await exportMesh('after-section.stl'), fine);
    await panel.getByRole('button', { name: '恢复完整模型并清除测量', exact: true }).click();
    await page.getByRole('checkbox', { name: '全部实体', exact: true }).check();
    await page.waitForFunction(() => document.querySelector('.canvas-host')?.dataset.objectCount === '3' && !document.querySelector('.layout-note')?.textContent.includes('正在更新'));
    await page.getByRole('checkbox', { name: '半透明', exact: true }).uncheck();
    await capture('edge-layout-dark.png');
    assert.deepEqual(await exportMesh('after-layout.stl'), fine);
    const view = await page.locator('.canvas-host').boundingBox();
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2); await page.mouse.down();
    await page.mouse.move(view.x + view.width / 2 + 60, view.y + view.height / 2 + 40, { steps: 12 }); await page.mouse.up();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', output, standardBytes: standard.length, fineBytes: fine.length,
      checks: ['TPMS / solid / wireframe GPU toggle', 'crease shading export invariance', 'precision presets and dirty export protection', 'fine mesh generation', 'section and layout export invariance', 'opaque layout and rotation', 'compact window'], errors }, null, 2));
  } catch (error) { await page.screenshot({ path: path.join(output, 'edge-failure-dark.png') }); console.error(output); console.error(await page.locator('.error-banner,.statusbar').allTextContents()); throw error; }
  finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
