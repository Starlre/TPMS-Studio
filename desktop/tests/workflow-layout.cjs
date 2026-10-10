const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-workflow-layout-ui-'));
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: 'D:\\anaconda3\\python.exe' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(output, 'profile')}`], env, timeout: 60000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  let editor = page.locator('.notebook-editor').last();
  const step = id => page.locator(`[data-node-id="${id}"]`);
  const value = id => page.locator(`[data-value-id="${id}"]`);
  async function category(name) { await page.getByRole('navigation', { name: '工作流类别' }).getByRole('button', { name, exact: true }).click(); if (name === '输出设置') editor = page.locator('.notebook-output'); }
  async function selectStep(id) { await category('建模步骤'); await step(id).locator('.notebook-node-select').click(); editor = step(id).locator('.notebook-editor'); return editor.locator(`[data-editor-node-id="${id}"]`); }
  async function selectValue(id) { await category('设计参数'); await value(id).locator('.notebook-node-select').click(); editor = value(id).locator('.notebook-editor'); return editor.locator(`[data-editor-value-id="${id}"]`); }
  async function waitDone(text) { await page.waitForFunction(text => document.querySelector('.statusbar')?.textContent.includes(text) && !document.querySelector('.generate')?.textContent.includes('正在计算'), text); }
  async function generate() { await page.getByRole('button', { name: '生成工作流', exact: true }).click(); await waitDone('模型已生成'); assert.equal(await page.locator('.error-banner').count(), 0); }
  async function add(kind) { await category('建模步骤'); await page.getByLabel('新节点类型', { exact: true }).selectOption(kind); await page.getByRole('button', { name: '添加节点', exact: true }).click(); editor = page.locator('[data-node-id]').last().locator('.notebook-editor'); }
  async function addValue(kind, symbol) { await category('设计参数'); await page.getByLabel('新参数节点类型', { exact: true }).selectOption(kind); await page.getByRole('button', { name: '添加参数节点', exact: true }).click(); editor = page.locator('[data-value-id]').last().locator('.notebook-editor'); await editor.getByLabel('引用符号', { exact: true }).fill(symbol); }
  async function capture(name) { await page.screenshot({ path: path.join(root, 'docs', name), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' }); }
  async function frameNode(id) {
    const params = page.locator('.notebook-group').first().locator('.notebook-group-heading button');
    if (await params.getAttribute('aria-expanded') === 'true') await params.click();
    await step(id).evaluate(el => { const host = el.closest('.panel-scroll'); host.scrollTop += el.getBoundingClientRect().top - host.getBoundingClientRect().top - 148; });
  }
  async function modelInfo() { await page.getByRole('navigation', { name: '检查器类别' }).getByRole('button', { name: '模型信息', exact: true }).click(); }
  async function volume() { await modelInfo(); return Number((await page.locator('.metric').filter({ has: page.locator('span', { hasText: /^体积$/ }) }).first().innerText()).replace(/[^\d.]/g, '')); }
  async function assertLayout() {
    const bounds = await page.evaluate(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect().toJSON();
      return { width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth, left: rect('.parameters'), view: rect('.model-area'), right: rect('.inspector'), action: rect('.generate'), header: rect('.file-actions') };
    });
    assert.ok(bounds.scroll <= bounds.width);
    assert.ok(bounds.left.right <= bounds.view.left + 1 && bounds.view.right <= bounds.right.left + 1);
    assert.ok(bounds.view.width >= 280 && bounds.right.width >= 260 && bounds.left.width >= 410);
    assert.ok(bounds.action.bottom <= bounds.height && bounds.header.right <= bounds.width);
    assert.ok(await page.locator('.parameters [data-editor-node-id] input').count() > 0);
    assert.equal(await page.locator('.inspector [data-editor-node-id],.inspector [data-editor-value-id],.property-host').count(), 0);
  }
  try {
    await waitDone('模型已生成');
    await page.getByRole('button', { name: '实体建模', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '生成工作流', exact: true }).isDisabled(), true);
    await addValue('number', 'radius'); await editor.getByLabel('参数名称', { exact: true }).fill('基体半径');
    await addValue('formula', 'outer'); await editor.getByLabel('参数名称', { exact: true }).fill('外形半径'); await editor.getByLabel('参数公式', { exact: true }).fill('radius + 1');
    await addValue('vector', 'offset'); await editor.getByLabel('参数名称', { exact: true }).fill('输出位移'); await editor.getByLabel('向量 X', { exact: true }).fill('20');
    await page.getByRole('button', { name: '计算参数值', exact: true }).click(); await waitDone('参数值计算完成');
    assert.match(await value('p2').locator('.notebook-node-select output').innerText(), /5/);
    await add('sphere'); await editor.getByLabel('半径参数引用', { exact: true }).selectOption('outer');
    assert.equal(await editor.getByLabel('半径参数引用', { exact: true }).locator('option[value="offset"]').count(), 0);
    await add('cylinder'); await editor.getByLabel('半径', { exact: true }).fill('1.5'); await editor.getByLabel('高度', { exact: true }).fill('16');
    await add('difference'); await editor.getByLabel('输入 A', { exact: true }).selectOption('n1'); await editor.getByLabel('输入 B', { exact: true }).selectOption('n2');
    assert.match(await step('n3').innerText(), /球体 1 − 圆柱 2/);
    await add('transform'); await editor.getByLabel('位置向量引用', { exact: true }).selectOption('p3');
    assert.equal(await editor.getByLabel('X 位置', { exact: true }).isDisabled(), true);
    assert.equal(await step('n4').locator('[data-editor-node-id]').count(), 1);
    assert.ok(await page.locator('[data-editor-node-id]').count() > 1); // Independent disclosures keep earlier nodes open.
    await generate(); const finalVolume = await volume(); assert.match(await page.locator('.metrics').nth(1).innerText(), /15 ~ 25/);
    await generate(); await category('输出设置'); assert.match(await editor.locator('.cache-summary').innerText(), /网格缓存命中/);
    assert.equal(await editor.getByLabel('输出节点', { exact: true }).inputValue(), 'n4');
    await selectStep('n1'); await editor.getByRole('button', { name: '预览节点 球体 1', exact: true }).click(); await waitDone('中间节点预览已更新');
    assert.ok(await volume() > finalVolume); assert.match(await page.locator('.metrics').nth(1).innerText(), /-5 ~ 5/);
    const projectFile = path.join(output, '工作流.json');
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, projectFile);
    await page.getByRole('button', { name: '保存项目', exact: true }).click(); await waitDone('项目已保存');
    const saved = JSON.parse(await fs.readFile(projectFile, 'utf8')); assert.equal(saved.scene.root, 'n4'); assert.equal(saved.scene.value_nodes.length, 3); assert.equal(saved.scene.nodes[3].vector_inputs.position, 'p3');
    const stl = path.join(output, 'final.stl'); await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, stl);
    await page.locator('.export-menu>summary').click(); await page.getByRole('button', { name: '导出 STL / OBJ / PLY', exact: true }).click(); await waitDone('已导出');
    const data = await fs.readFile(stl); let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < data.readUInt32LE(80); i++) for (const offset of [12, 24, 36]) { const x = data.readFloatLE(84 + i * 50 + offset); minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    assert.ok(minX > 14 && maxX < 26);
    await page.getByRole('button', { name: '返回最终输出', exact: true }).click(); assert.ok(Math.abs(await volume() - finalVolume) < 0.01);
    await selectValue('p1'); await editor.getByRole('button', { name: '删除参数节点 基体半径', exact: true }).click(); assert.match(await page.locator('.error-banner').innerText(), /引用/); await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
    // A consumer link jumps from a parameter to another parameter and its editor.
    await editor.locator('.parameter-consumers').getByRole('button', { name: '外形半径', exact: true }).click(); editor = value('p2').locator('.notebook-editor'); assert.equal(await editor.locator('[data-editor-value-id="p2"]').count(), 1);
    await selectValue('p1'); await editor.getByLabel('参数数值', { exact: true }).fill('5');
    await category('建模步骤'); assert.equal(await step('n1').locator('.step-status').getAttribute('data-state'), 'pending'); assert.notEqual(await step('n2').locator('.step-status').getAttribute('data-state'), 'pending');
    await page.getByRole('checkbox', { name: '自动更新输出', exact: true }).check(); await waitDone('模型已生成'); await modelInfo(); assert.match(await page.locator('.metrics').nth(1).innerText(), /14 ~ 26/);
    await selectValue('p2'); await editor.getByLabel('参数公式', { exact: true }).fill('1 / 0'); await waitDone('操作未完成'); await page.waitForTimeout(2000); assert.equal(await page.locator('.generate').innerText(), '生成工作流');
    await editor.getByLabel('参数公式', { exact: true }).fill('radius + 1'); await waitDone('模型已生成'); await page.getByRole('checkbox', { name: '自动更新输出', exact: true }).uncheck();
    await page.getByRole('button', { name: '打开', exact: true }).click(); await waitDone('项目已打开'); await selectValue('p1'); assert.equal(await editor.getByLabel('参数数值', { exact: true }).inputValue(), '4');
    await editor.getByLabel('参数数值', { exact: true }).fill('7'); await page.getByRole('button', { name: '撤销节点修改', exact: true }).click(); assert.equal(await editor.locator('[data-editor-value-id="p1"]').count(), 1); assert.equal(await editor.getByLabel('参数数值', { exact: true }).inputValue(), '4');
    await page.getByRole('button', { name: '重做节点修改', exact: true }).click(); await selectValue('p1'); assert.equal(await editor.getByLabel('参数数值', { exact: true }).inputValue(), '7'); await page.getByRole('button', { name: '撤销节点修改', exact: true }).click();
    await selectStep('n3'); const opts = await editor.getByLabel('输入 A', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(n => n.value)); assert.ok(!opts.includes('n4'));
    await editor.getByLabel('输入 B', { exact: true }).selectOption('n1'); assert.equal(await page.getByRole('button', { name: '生成工作流', exact: true }).isDisabled(), true); assert.match(await editor.locator('.node-error').innerText(), /不同/); await editor.getByLabel('输入 B', { exact: true }).selectOption('n2');
    await selectStep('n1'); await editor.getByRole('button', { name: '删除节点 球体 1', exact: true }).click(); assert.match(await page.locator('.error-banner').innerText(), /引用/); await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
    // Disclosure and selection are view state; native buttons work with keyboard.
    await generate(); await page.getByRole('button', { name: '收起所有节点', exact: true }).click(); assert.equal(await page.locator('[data-editor-node-id],[data-editor-value-id]').count(), 0);
    const disclosure = step('n2').locator('.notebook-disclosure'); await disclosure.focus(); await page.keyboard.press('Enter'); assert.equal(await disclosure.getAttribute('aria-expanded'), 'true'); assert.equal(await step('n2').locator('[data-editor-node-id="n2"]').count(), 1);
    await page.keyboard.press('Enter'); assert.equal(await disclosure.getAttribute('aria-expanded'), 'false'); assert.equal(await page.locator('.snapshot-note').count(), 0);
    await selectStep('n3'); await editor.getByRole('button', { name: '定位引用 球体 1', exact: true }).click(); editor = step('n1').locator('.notebook-editor'); assert.equal(await step('n1').locator('.notebook-node-select').getAttribute('aria-pressed'), 'true');
    await editor.getByRole('button', { name: '定位引用 外形半径', exact: true }).click(); assert.equal(await value('p2').locator('.notebook-node-select').getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '收起所有节点', exact: true }).click(); await selectStep('n3'); await assertLayout();
    await frameNode('n3'); await capture('electron-workflow-steps-dark.png');
    await page.getByRole('button', { name: '切换亮色主题', exact: true }).click(); await page.waitForTimeout(200); await capture('electron-workflow-steps-light.png');
    await page.getByRole('button', { name: '收起所有节点', exact: true }).click(); await selectValue('p2'); await capture('electron-workflow-parameters.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760)); await page.emulateMedia({ reducedMotion: 'reduce' }); await selectStep('n4'); await page.waitForTimeout(200); await assertLayout();
    assert.ok(await editor.getByLabel('位置向量引用', { exact: true }).isVisible()); await page.screenshot({ path: path.join(output, 'compact.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1520, 980));
    await page.getByRole('button', { name: '收起所有节点', exact: true }).click(); await selectStep('n1'); await editor.getByRole('button', { name: '预览节点 球体 1', exact: true }).click(); await waitDone('中间节点预览已更新'); await frameNode('n1'); await capture('electron-workflow-preview.png');
    // Legacy shared constants and TPMS editing still work through separate views.
    await category('建模步骤'); await page.locator('.workflow-presets>summary').click(); await page.getByRole('button', { name: '圆柱 TPMS 减流道', exact: true }).click(); await waitDone('工作流已加载');
    await selectStep('n1'); await editor.getByLabel('壁厚', { exact: true }).fill('2'); await generate();
    await category('设计参数'); await page.locator('.workflow-inputs>summary').click(); await page.getByLabel('新共享参数名称', { exact: true }).fill('wall'); await page.getByRole('button', { name: '添加参数', exact: true }).click(); await page.locator('.workflow-inputs').getByLabel('wall', { exact: true }).fill('1.8');
    await selectStep('n1'); await editor.getByRole('button', { name: '壁厚使用表达式', exact: true }).click(); await editor.getByLabel('壁厚', { exact: true }).fill('wall'); await generate();
    await page.getByRole('button', { name: '收起所有节点', exact: true }).click(); await selectStep('n5'); await frameNode('n5'); await capture('electron-notebook-tpms.png');
    await page.getByRole('button', { name: '剖切与测量', exact: true }).click(); await page.getByRole('checkbox', { name: '启用剖切', exact: true }).check(); await selectStep('n5'); assert.equal(await page.getByRole('checkbox', { name: '启用剖切', exact: true }).isChecked(), true); assert.ok(await page.locator('.inspection-scroll').isVisible());
    await page.getByRole('button', { name: '剖切与测量', exact: true }).click(); assert.ok(await page.locator('.inspector-scroll').isVisible());
    // Switching to the existing workspaces does not leave a hidden/stale inspector.
    await page.getByRole('button', { name: 'TPMS 建模', exact: true }).click(); assert.equal(await page.locator('.property-host').count(), 0); assert.ok(await page.locator('.inspector-scroll').isVisible());
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', output, checks: ['inline independent disclosures', 'typed reference navigation', 'consumer navigation', 'cache reuse', 'preview/final-export isolation', 'automatic update/error recovery', 'save/open/undo/redo', 'cycle/deletion protection', 'keyboard/view-only disclosure', '1120x760 layout/reduced motion', 'dark/light screenshots', 'TPMS and legacy constants', 'inspection persistence during selection', 'workspace switching'], errors }, null, 2));
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(await page.locator('.statusbar').innerText()); console.error(await page.locator('.error-banner').allTextContents()); console.error(output); throw error; }
  finally { await app.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
