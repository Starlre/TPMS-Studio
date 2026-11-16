const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-imported-solid-ui-'));
  const python = process.env.TPMS_PYTHON || 'D:\\anaconda3\\python.exe';
  const stlFile = path.join(output, 'blank.stl');
  const stepFile = path.join(output, 'part.step');
  execFileSync(python, ['-c', `
import trimesh
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
from OCP.gp import gp_Pnt
trimesh.creation.box(extents=[28, 22, 18]).export(r"${stlFile}")
w = STEPControl_Writer()
w.Transfer(BRepPrimAPI_MakeBox(gp_Pnt(-14, -10, -8), 28.0, 20.0, 16.0).Shape(), STEPControl_AsIs)
w.Write(r"${stepFile}")
`], { cwd: root, env: { ...process.env, PYTHONUTF8: '1' } });

  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: python, PYTHONUTF8: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(output, 'profile')}`],
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const done = async text => {
    await page.waitForFunction(
      t => document.querySelector('.error-banner') || (document.querySelector('.statusbar')?.textContent.includes(t) && !document.querySelector('.generate')?.textContent.includes('正在计算')),
      text
    );
    assert.equal(await page.locator('.error-banner').count(), 0, (await page.locator('.error-banner').allTextContents()).join('\n'));
  };

  try {
    await done('模型已生成');
    if (await page.locator('html').getAttribute('data-theme') !== 'light') {
      await page.getByRole('button', { name: '切换亮色主题', exact: true }).click();
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1520, 980));

    // 1. Switch to 实体建模 and import STL directly via Ribbon 导入外部实体
    await page.getByRole('button', { name: '实体建模', exact: true }).click();
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, stlFile);
    await page.getByRole('button', { name: '导入外部实体', exact: true }).click();
    await done('已导入外部实体');
    assert.equal(await page.locator('[data-node-id="n1"]').count(), 1);
    await page.waitForFunction(() => document.querySelector('.canvas-host')?.dataset.objectCount === '1');

    // Add TPMS 填充 on imported STL (2-node workflow!) -> 快速 0.6mm -> 生成工作流
    await page.getByRole('tab', { name: 'TPMS 节点', exact: true }).click();
    await page.getByRole('button', { name: 'TPMS 填充', exact: true }).click();
    await page.locator('.editor-section').getByLabel('结构模式', { exact: true }).selectOption('solid');
    await page.getByRole('button', { name: /快速/ }).click();
    await page.getByRole('button', { name: '生成工作流', exact: true }).click();
    await done('模型已生成');
    assert.match((await page.locator('.metrics').allTextContents()).join(' '), /封闭 \/ 水密/);

    // 2. Also verify CAD 参考模型 -> 转入实体建模（支持 TPMS 填充与布尔）
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, stepFile);
    await page.getByRole('button', { name: '导入 STEP', exact: true }).click();
    await done('STEP 已导入');
    await page.getByRole('button', { name: '转入实体建模（支持 TPMS 填充与布尔）', exact: true }).click();
    await done('已导入外部实体');
    assert.equal(await page.getByRole('button', { name: '实体建模', exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('[data-node-id]').count(), 3);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', errors }, null, 2));
  } finally {
    await app.close();
    await fs.rm(output, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
