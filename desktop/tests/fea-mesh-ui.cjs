const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function waitForFile(filePath, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 0) return stat;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for exported file: ${filePath}`);
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-fea-ui-'));
  const shotDir = process.env.TPMS_FEA_SCREENSHOT_DIR || output;
  const python = process.env.TPMS_PYTHON || 'D:\\anaconda3\\python.exe';
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: python, PYTHONUTF8: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(output, 'profile')}`],
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1560, 1000));

    // 1. Switch to 实体建模 and build composite box - cylinder hole bracket
    await page.getByRole('button', { name: '实体建模', exact: true }).click();
    await page.getByRole('button', { name: '创建长方体', exact: true }).click();
    const boxEditor = page.locator('[data-editor-node-id="n1"]');
    await boxEditor.getByLabel('X 长度', { exact: true }).fill('24');
    await boxEditor.getByLabel('Y 长度', { exact: true }).fill('24');
    await boxEditor.getByLabel('Z 长度', { exact: true }).fill('16');

    await page.getByRole('button', { name: '创建圆柱', exact: true }).click();
    const cylEditor = page.locator('[data-editor-node-id="n2"]');
    await cylEditor.getByLabel('半径', { exact: true }).fill('4');
    await cylEditor.getByLabel('高度', { exact: true }).fill('20');

    await page.getByRole('button', { name: '添加差集', exact: true }).click();
    const diffEditor = page.locator('[data-editor-node-id="n3"]');
    await diffEditor.getByLabel('输入 A', { exact: true }).selectOption('n1');
    await diffEditor.getByLabel('输入 B', { exact: true }).selectOption('n2');

    const allToggle = page.getByRole('checkbox', { name: '全部实体', exact: true });
    if (await allToggle.isChecked()) await allToggle.uncheck();
    await page.getByRole('button', { name: /快速/ }).click();
    await page.getByRole('button', { name: '生成工作流', exact: true }).click();
    await done('模型已生成');

    // 2. Check 检查与测量 Ribbon tab and open 模型信息 Inspector
    await page.getByRole('tab', { name: '检查与测量', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '划分 FEA 体网格', exact: true }).count(), 2); // Ribbon + Inspector or check exact roles
    const ribbonMeshBtn = page.locator('#ribbon-panel-inspect').getByRole('button', { name: '划分 FEA 体网格', exact: true });
    const ribbonLowBtn = page.locator('#ribbon-panel-inspect').getByRole('button', { name: '高亮低质量单元', exact: true });
    const ribbonExportBtn = page.locator('#ribbon-panel-inspect').getByRole('button', { name: '导出 FEA 体网格', exact: true });
    assert.equal(await ribbonMeshBtn.isEnabled(), true);
    assert.equal(await ribbonLowBtn.isDisabled(), true);
    assert.equal(await ribbonExportBtn.isEnabled(), true);

    await page.getByRole('button', { name: '查看模型信息', exact: true }).click();
    await page.getByLabel('FEA 体单元尺寸', { exact: true }).fill('1.8');
    await page.getByLabel('FEA 表面策略', { exact: true }).selectOption('auto');

    // 3. Generate FEA volume mesh & verify FEA quality report dialog
    await ribbonMeshBtn.click();
    const reportHeading = page.getByRole('heading', { name: 'FEA 结构体网格质量报告', exact: true });
    await reportHeading.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.error-banner').count(), 0);
    const modalText = await page.locator('dialog[open]').innerText();
    assert.match(modalText, /1 个实体域/);
    assert.match(modalText, /体单元/);
    assert.match(modalText, /mm³/);
    await fs.mkdir(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'fea-report-bracket.png'), scale: 'css' });
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();

    // 4. Verify right Inspector summary & low-quality element toggle
    assert.match(await page.locator('.metrics').last().innerText(), /最小雅可比/);
    assert.equal(await ribbonLowBtn.isEnabled(), true);
    await page.getByRole('button', { name: '定位低质量单元', exact: true }).click();
    await page.getByRole('button', { name: '恢复模型显示', exact: true }).waitFor();
    assert.equal(await ribbonLowBtn.getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: path.join(shotDir, 'fea-lowq-bracket.png'), scale: 'css' });
    await ribbonLowBtn.click();
    await page.getByRole('button', { name: '定位低质量单元', exact: true }).waitFor();

    // 5. Export FEA volume mesh (.bdf / .msh / _fea.json / _quality.vtu)
    const bdfOut = path.join(output, 'bracket-fea.bdf');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, bdfOut);
    await page.getByRole('button', { name: '导出 FEA 体网格 (MSH / BDF)', exact: true }).click();
    await waitForFile(bdfOut);
    const mshOut = path.join(output, 'bracket-fea.msh');
    const jsonOut = path.join(output, 'bracket-fea_fea.json');
    const vtuOut = path.join(output, 'bracket-fea_quality.vtu');
    await waitForFile(mshOut);
    await waitForFile(jsonOut);
    await waitForFile(vtuOut);
    await page.waitForFunction(() => !document.querySelector('.statusbar')?.textContent.includes('正在'));
    if (await page.locator('dialog[open]').count()) {
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    }
    const meta = JSON.parse(await fs.readFile(jsonOut, 'utf8'));
    assert.equal(meta.solid_domains, 1);
    assert.ok(meta.tetrahedra > 500);
    assert.equal(meta.physical_ids.solid, 201);
    assert.ok(meta.min_scaled_jacobian > 0);

    // 6. Save project and verify FEA settings persist in project JSON
    const projectFile = path.join(output, 'bracket-fea.json');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, projectFile);
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await done('项目已保存');
    const saved = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    assert.equal(saved.fea.element_size, 1.8);
    assert.equal(saved.fea.remesh_surface, 'auto');

    // 7. Load 2-node Gyroid sneaker shoe sole and verify FEA meshing on imported STL + TPMS lattice
    const shoeProject = path.join(root, 'examples', 'showcase', 'stl-shoe-midsole.json');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, shoeProject);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await done('项目已打开');
    await page.getByRole('button', { name: '生成工作流', exact: true }).click();
    await done('模型已生成');

    await page.getByRole('button', { name: '查看模型信息', exact: true }).click();
    await page.getByLabel('FEA 体单元尺寸', { exact: true }).fill('2.4');
    await page.locator('.metrics').getByRole('button', { name: '划分 FEA 体网格', exact: true }).click();
    await reportHeading.waitFor({ state: 'visible' });
    const shoeModal = await page.locator('dialog[open]').innerText();
    assert.match(shoeModal, /体单元/);
    assert.match(shoeModal, /个实体域/);
    await page.screenshot({ path: path.join(shotDir, 'fea-shoe-report.png'), scale: 'css' });
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.screenshot({ path: path.join(shotDir, 'fea-shoe-mesh.png'), scale: 'css' });

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
      result: 'passed',
      bracket_tets: meta.tetrahedra,
      bracket_min_jacobian: meta.min_scaled_jacobian,
      bracket_volume_mm3: meta.mesh_volume_mm3,
      errors,
    }, null, 2));
  } finally {
    await app.close();
    await fs.rm(output, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
