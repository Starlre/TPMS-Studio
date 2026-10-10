const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-electron-ui-'));
  const environment = { ...process.env, TPMS_PYTHON: process.env.TPMS_PYTHON || 'D:\\anaconda3\\python.exe' };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [process.env.TPMS_DESKTOP_DIR || path.join(root, 'desktop'), `--user-data-dir=${path.join(output, 'profile')}`],
    env: environment, timeout: 60000 });
  const page = await application.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('模型已生成'), { timeout: 90000 });
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('GPU 隐式曲面'));
    assert.equal(await page.locator('.error-banner').count(), 0);
    await page.screenshot({ path: path.join(root, 'docs', 'electron-tpms-dark.png') });
    await page.getByRole('button', { name: '切换亮色主题', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(root, 'docs', 'electron-tpms-light.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
    await page.waitForFunction(() => innerWidth <= 1120 && innerHeight <= 760);
    const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      generate: document.querySelector('.generate').getBoundingClientRect().toJSON() }));
    assert.ok(bounds.scroll <= bounds.width);
    assert.ok(bounds.generate.x >= 0 && bounds.generate.bottom <= 760);
    await page.screenshot({ path: path.join(output, 'compact.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1520, 980));
    await page.waitForFunction(() => innerWidth >= 1500);
    await page.getByRole('button', { name: '切换暗色主题', exact: true }).click();
    // Real native export dialog result, without requiring a human in the test.
    await application.evaluate(({ dialog }, outputPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: outputPath });
    }, path.join(output, '实际模型.stl'));
    await page.locator('.export-menu>summary').click();
    await page.screenshot({ path: path.join(root, 'docs', 'electron-export.png') });
    await page.getByRole('button', { name: '导出 STL / OBJ / PLY', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('已导出'));
    assert.ok((await fs.stat(path.join(output, '实际模型.stl'))).size > 10000);
    await page.getByRole('button', { name: '实体组合', exact: true }).click();
    await page.getByRole('button', { name: '圆柱 TPMS 减流道', exact: true }).click();
    await page.getByRole('button', { name: '生成实体', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('模型已生成'));
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('网格预览'));
    assert.equal(await page.getByRole('button', { name: '仿真区域', exact: true }).isDisabled(), true);
    await page.locator('.panel-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(root, 'docs', 'electron-solid.png') });
    await page.getByRole('button', { name: 'TPMS 建模', exact: true }).click();
    const panel = page.locator('.parameters');
    for (const axis of ['X', 'Y', 'Z']) await panel.getByLabel(axis, { exact: true }).first().fill('12');
    for (const axis of ['X', 'Y', 'Z']) await panel.getByLabel(axis, { exact: true }).nth(1).fill('1');
    await page.getByRole('button', { name: '结构', exact: true }).click();
    await page.getByLabel('每周期采样数', { exact: true }).fill('24');
    await page.getByRole('button', { name: '生成模型', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('模型已生成'));
    await page.screenshot({ path: path.join(root, 'docs', 'electron-structure.png') });
    await page.getByRole('button', { name: 'CFD 网格', exact: true }).click();
    await page.getByLabel('体单元尺寸', { exact: true }).fill('2');
    await page.getByLabel('流体表面采样数', { exact: true }).fill('32');
    await page.getByLabel('入口 / 出口局部加密', { exact: true }).uncheck();
    await page.getByLabel('曲率自适应', { exact: true }).uncheck();
    await page.getByRole('button', { name: '仿真区域', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.legend')?.textContent.includes('入口'));
    assert.equal(await page.locator('.error-banner').count(), 0);
    await page.screenshot({ path: path.join(root, 'docs', 'electron-cfd.png') });
    await page.getByRole('button', { name: '网格质量', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('dialog')?.open, { timeout: 90000 });
    assert.ok((await page.locator('.quality-summary').innerText()).includes('最小值'));
    await page.screenshot({ path: path.join(root, 'docs', 'electron-quality.png') });
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.getByRole('button', { name: '低质量', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.legend')?.textContent.includes('低质量单元'));
    const projectFile = path.join(output, '建模项目.json');
    await application.evaluate(({ dialog }, projectPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: projectPath });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
    }, projectFile);
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('项目已保存'));
    const project = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    assert.equal(project.parameters.size_x, 12);
    assert.ok(project.scene.nodes.length >= 3);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('项目已打开'));
    await page.getByRole('button', { name: '几何', exact: true }).click();
    await page.getByLabel('曲面类型', { exact: true }).selectOption('Custom');
    await page.getByLabel('隐式函数 f(x,y,z)').fill('sqrt(x*x+y*y+z*z)-4');
    assert.equal(await page.getByLabel('X', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '结构', exact: true }).click();
    await page.getByLabel('结构模式', { exact: true }).selectOption('solid');
    await page.getByRole('button', { name: '生成模型', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('模型已生成'));
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('网格预览'));
    assert.equal(await page.getByLabel('GPU 隐式曲面', { exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.error-banner').count(), 0);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ result: 'passed', artifacts: output, pageErrors }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') });
    console.error(await page.locator('.statusbar').innerText());
    console.error(await page.locator('.error-banner').allTextContents());
    console.error('Artifacts: ' + output);
    throw error;
  } finally { await application.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
