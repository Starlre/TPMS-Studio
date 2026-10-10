const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..'), output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-inspection-ui-'));
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: process.env.TPMS_PYTHON || 'D:\\anaconda3\\python.exe' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(output, 'profile')}`], env, timeout: 60000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const panel = page.locator('.inspection-panel');
  async function done(text) { await page.waitForFunction(text => document.querySelector('.statusbar')?.textContent.includes(text) && !document.querySelector('.generate')?.textContent.includes('正在计算'), text); }
  async function settled() { await page.waitForFunction(() => { const p = document.querySelector('.section-statistics'); return p && !p.textContent.includes('计算中') && p.querySelector('.metric'); }); assert.equal(await panel.locator('.inspection-warning').count(), 0); }
  async function exportTo(name) {
    const destination = path.join(output, name);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
    await page.locator('.export-menu>summary').click(); await page.getByRole('button', { name: '导出 STL / OBJ / PLY', exact: true }).click(); await done('已导出');
    return fs.readFile(destination);
  }
  async function layout() { const sizes = await page.evaluate(() => { const p = document.querySelector('.inspection-panel').getBoundingClientRect(); return { width: innerWidth, scroll: document.documentElement.scrollWidth, right: p.right, viewport: document.querySelector('.viewport').getBoundingClientRect().width }; }); assert.ok(sizes.scroll <= sizes.width); assert.ok(sizes.right <= sizes.width); assert.ok(sizes.viewport >= 260); }
  try {
    await done('模型已生成');
    await page.getByRole('button', { name: '剖切与测量', exact: true }).click();
    await panel.getByRole('checkbox', { name: '启用剖切', exact: true }).check();
    await panel.getByLabel('剖切位置 / mm', { exact: true }).fill('-2.35'); await settled();
    await page.locator('.inspection-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(root, 'docs', 'electron-tpms-section.png'), scale: 'css' });
    await panel.getByRole('button', { name: '恢复完整模型并清除测量', exact: true }).click();
    const project = { type: 'tpms-electron', version: 1, mode: 'nodes', parameters: {}, cfd: {}, scene: { version: 1, root: 'n1', cell_size: 0.5, nodes: [{ id: 'n1', name: '测量盒', kind: 'box', dimensions: [16, 12, 8], position: [20, -4, 6], rotation: [0, 0, 0], inputs: [], blend: 2 }] } };
    const projectPath = path.join(output, 'box.json'); await fs.writeFile(projectPath, JSON.stringify(project));
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, projectPath);
    await page.getByRole('button', { name: '打开', exact: true }).click(); await done('项目已打开'); await page.getByRole('button', { name: '生成工作流', exact: true }).click(); await done('模型已生成');
    const before = await exportTo('before.stl');
    await page.getByRole('navigation', { name: '检查器类别' }).getByRole('button', { name: '剖切测量', exact: true }).click();
    await panel.getByRole('checkbox', { name: '启用剖切', exact: true }).check(); await panel.getByRole('button', { name: '居中', exact: true }).click(); await settled();
    const area = Number((await panel.locator('.section-statistics .metric strong').first().innerText()).replace(/[^\d.]/g, '')); assert.ok(Math.abs(area - 192) < 2);
    assert.ok(Math.abs(Number(await panel.getByLabel('剖切位置 / mm', { exact: true }).inputValue()) - 6) < 0.1);
    await panel.getByRole('checkbox', { name: '显示包围盒', exact: true }).check(); await settled(); await layout();
    await page.locator('.inspection-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(root, 'docs', 'electron-section-dark.png'), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' });
    await panel.getByRole('button', { name: '正对截面', exact: true }).click(); await page.waitForTimeout(350);
    await panel.getByRole('button', { name: '开始两点测量', exact: true }).click();
    const canvas = page.locator('.canvas-host>canvas'), box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width * 0.48, box.y + box.height * 0.5); await page.waitForFunction(() => document.querySelector('[aria-label="A 点 Z"]').value !== '');
    await page.mouse.click(box.x + box.width * 0.54, box.y + box.height * 0.5); await page.waitForFunction(() => !!document.querySelector('.measurement-result'));
    for (const point of ['A', 'B']) assert.ok(Math.abs(Number(await panel.getByLabel(`${point} 点 Z`, { exact: true }).inputValue()) - 6) < 0.1);
    assert.ok(Number((await panel.locator('.measurement-result output').innerText()).replace(/[^\d.]/g, '')) > 0);
    await panel.locator('.measurement-result').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'docs', 'electron-measurement.png'), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' });
    const after = await exportTo('after.stl'); assert.deepEqual(after, before); // Clipping and measurement never alter the exported solid.
    await panel.getByRole('button', { name: '清除', exact: true }).click();
    for (const [point, coordinates] of [['A', [0, 0, 0]], ['B', [3, 4, 12]]]) for (let i = 0; i < 3; i++) await panel.getByLabel(`${point} 点 ${['X', 'Y', 'Z'][i]}`, { exact: true }).fill(String(coordinates[i]));
    assert.equal(await panel.locator('.measurement-result output').innerText(), '13 mm');
    await panel.getByRole('button', { name: '开始两点测量', exact: true }).click();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 4 }); await page.mouse.up();
    assert.equal(await panel.getByLabel('A 点 X', { exact: true }).inputValue(), '');
    await page.keyboard.press('Escape'); assert.equal(await panel.getByRole('button', { name: '开始两点测量', exact: true }).count(), 1);
    await panel.getByRole('checkbox', { name: '仅显示截面', exact: true }).check(); await settled();
    await panel.getByLabel('平面方向', { exact: true }).selectOption('custom'); await settled();
    await panel.getByRole('button', { name: '正对截面', exact: true }).click();
    await page.getByRole('button', { name: '切换亮色主题', exact: true }).click(); await page.waitForTimeout(250);
    await page.locator('.inspection-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(root, 'docs', 'electron-section-light.png'), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' });
    for (const axis of ['X', 'Y', 'Z']) await panel.getByLabel(`法向 ${axis}`, { exact: true }).fill('0'); assert.match(await panel.locator('[role="alert"]').innerText(), /不能为零/);
    await panel.getByLabel('法向 Z', { exact: true }).fill('1'); await settled();
    await panel.getByLabel('剖切位置滑块', { exact: true }).fill('5'); await settled();
    await panel.getByRole('checkbox', { name: '保留法向正侧', exact: true }).check(); await settled();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760)); await page.waitForFunction(() => innerWidth <= 1120); await page.emulateMedia({ reducedMotion: 'reduce' }); await layout();
    await page.screenshot({ path: path.join(output, 'compact.png'), scale: 'css' });
    await page.getByRole('button', { name: '生成工作流', exact: true }).click(); await done('模型已生成'); assert.equal(await panel.getByRole('checkbox', { name: '启用剖切', exact: true }).isChecked(), false); assert.equal(await panel.getByLabel('A 点 X', { exact: true }).inputValue(), '');
    // Diagnostic boundaries and implicit TPMS use the same display-only inspection.
    await page.getByRole('button', { name: 'TPMS 建模', exact: true }).click(); const parameters = page.locator('.parameters');
    for (const axis of ['X', 'Y', 'Z']) { await parameters.getByLabel(axis, { exact: true }).first().fill('12'); await parameters.getByLabel(axis, { exact: true }).nth(1).fill('1'); }
    await page.getByRole('button', { name: '结构', exact: true }).click(); await page.getByLabel('每周期采样数', { exact: true }).fill('24'); await page.getByRole('button', { name: '生成模型', exact: true }).click(); await done('模型已生成');
    await page.getByRole('navigation', { name: '检查器类别' }).getByRole('button', { name: '剖切测量', exact: true }).click(); await panel.getByRole('checkbox', { name: '启用剖切', exact: true }).check(); await settled();
    assert.ok((await page.locator('.statusbar').innerText()).includes('剖切网格预览'));
    await panel.getByRole('button', { name: '恢复完整模型并清除测量', exact: true }).click(); assert.equal(await panel.getByRole('checkbox', { name: '启用剖切', exact: true }).isChecked(), false);
    assert.ok((await page.locator('.statusbar').innerText()).includes('GPU 隐式曲面'));
    await page.getByRole('button', { name: '仿真区域', exact: true }).click(); await done('仿真区域：'); await panel.getByRole('checkbox', { name: '启用剖切', exact: true }).check(); await settled();
    assert.equal(await page.locator('.error-banner').count(), 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', output, errors, checks: ['world-coordinate section/cap', 'surface point picking', 'manual 13mm distance', 'drag and Escape', 'arbitrary plane', 'zero-normal recovery', 'section-only', 'positive side', 'export unchanged', 'geometry reset', 'dark/light', 'compact layout', 'TPMS implicit recovery', 'CFD boundary inspection'] }, null, 2));
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(output); console.error(await page.locator('.statusbar').innerText()); console.error(await panel.innerText().catch(() => '')); throw error; }
  finally { await app.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
