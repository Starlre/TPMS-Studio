const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..'), output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-workflow-drag-ui-'));
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: 'D:\\anaconda3\\python.exe' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(output, 'profile')}`], env, timeout: 60000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  const step = id => page.locator(`[data-node-id="${id}"]`), value = id => page.locator(`[data-value-id="${id}"]`);
  const input = descriptor => page.locator(`[data-reference-target='${JSON.stringify(descriptor)}']`);
  const editor = id => step(id).locator('.notebook-editor');
  const vEditor = id => value(id).locator('.notebook-editor');
  const order = async group => page.locator(group === 'body' ? '[data-node-id]' : '[data-value-id]').evaluateAll((els, attr) => els.map(e => e.getAttribute(attr)), group === 'body' ? 'data-node-id' : 'data-value-id');
  async function waitDone(text) { await page.waitForFunction(t => document.querySelector('.statusbar')?.textContent.includes(t) && !document.querySelector('.generate')?.textContent.includes('正在计算'), text); }
  async function generate() { await page.getByRole('button', { name: '生成工作流', exact: true }).click(); await waitDone('模型已生成'); assert.equal(await page.locator('.error-banner').count(), 0); }
  async function select(id) { await (id.startsWith('p') ? value(id) : step(id)).locator('.notebook-node-select').click(); }
  async function add(name) { await page.getByRole('button', { name: '新节点', exact: true }).click(); await page.getByRole('region', { name: '创建节点' }).getByRole('button', { name, exact: true }).click(); }
  async function move(id, direction, name) { await step(id).getByRole('button', { name: `节点操作 ${name}`, exact: true }).click(); await page.getByRole('group', { name: '节点操作菜单' }).getByRole('button', { name: `${direction}节点 ${name}`, exact: true }).click(); await page.keyboard.press('Escape'); }
  async function settings() { if (!(await page.getByRole('button', { name: '输出设置', exact: true }).getAttribute('aria-expanded') === 'true')) await page.getByRole('button', { name: '输出设置', exact: true }).click(); }
  async function undo() { await page.getByRole('button', { name: '撤销节点修改', exact: true }).click(); }
  async function redo() { await page.getByRole('button', { name: '重做节点修改', exact: true }).click(); }
  async function save(file) { await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, file); await page.getByRole('button', { name: '保存项目', exact: true }).click(); await waitDone('项目已保存'); return JSON.parse(await fs.readFile(file, 'utf8')); }
  async function open(file) { await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, file); await page.getByRole('button', { name: '打开', exact: true }).click(); await waitDone('项目已打开'); }
  async function exportMesh(file) { await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, file); const menu = page.locator('.export-menu'); if (!(await menu.getAttribute('open'))) await menu.locator('summary').click(); await page.getByRole('button', { name: '导出 STL / OBJ / PLY', exact: true }).click(); await waitDone('已导出'); return fs.readFile(file); }
  async function drag(source, destination, fraction = 0.5, checkHover, checkScroll = false) {
    // Real mouse input starts Chromium's native HTML drag; target scrolling does not synthesize a drop.
    await source.scrollIntoViewIfNeeded(); const a = await source.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 14, a.y + a.height / 2 + 8, { steps: 8 });
    await page.waitForFunction(() => document.querySelector('.workflow-drag-status')?.textContent.startsWith('拖到') || document.querySelector('.workflow-drag-status')?.textContent.startsWith('将'));
    if (checkScroll) {
      const pane = page.locator('.node-workspace .panel-scroll');
      await pane.evaluate(el => { el.scrollTop = 0; }); const p = await pane.boundingBox();
      await page.mouse.move(p.x + p.width / 2, p.y + p.height - 8, { steps: 8 });
      await page.mouse.move(p.x + p.width / 2 + 1, p.y + p.height - 8);
      await page.waitForFunction(() => document.querySelector('.node-workspace .panel-scroll').scrollTop > 20);
    }
    await destination.evaluate(el => el.scrollIntoView({ block: 'center' })); const b = await destination.boundingBox();
    // Chromium emits the first native dragover while traversing the path. Move again
    // after layout/edge scrolling so the last advertised insertion line matches the drop.
    await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * fraction, { steps: 12 });
    const final = await destination.boundingBox();
    await page.mouse.move(final.x + final.width * 0.65, final.y + final.height * fraction, { steps: 4 });
    if (checkHover) await checkHover();
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.drop-compatible,.drop-over'));
  }
  async function capture(name) { await page.screenshot({ path: path.join(root, 'docs', name), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' }); }
  try {
    await waitDone('模型已生成'); await page.getByRole('button', { name: '实体建模', exact: true }).click();
    for (const [kind, symbol] of [['number', 'radius'], ['formula', 'outer'], ['vector', 'offset']]) {
      await add({ number: '数值参数', formula: '公式参数', vector: '向量参数' }[kind]);
      await page.locator('[data-value-id]').last().getByLabel('引用符号', { exact: true }).fill(symbol);
    }
    await vEditor('p2').getByLabel('参数公式', { exact: true }).fill('radius + 1');
    await vEditor('p3').getByLabel('向量 X', { exact: true }).fill('20');
    for (const kind of ['sphere', 'cylinder', 'difference', 'transform']) {
      await add({ sphere: '球体', cylinder: '圆柱', difference: '差集', transform: '变换' }[kind]);
    }
    await editor('n1').getByLabel('半径参数引用', { exact: true }).selectOption('outer');
    await editor('n2').getByLabel('半径', { exact: true }).fill('1.5'); await editor('n2').getByLabel('高度', { exact: true }).fill('16');
    await editor('n3').getByLabel('输入 A', { exact: true }).selectOption('n1'); await editor('n3').getByLabel('输入 B', { exact: true }).selectOption('n2');
    await editor('n4').getByLabel('位置向量引用', { exact: true }).selectOption('p3'); await generate();
    const originalSTL = await exportMesh(path.join(output, 'before.stl'));
    await page.getByRole('button', { name: '收起所有节点', exact: true }).click();
    await drag(step('n4').locator('.notebook-sort-handle'), step('n1').locator('.notebook-node-heading'), 0.2, async () => {
      await page.waitForFunction(() => document.querySelector('[data-node-id="n1"] .notebook-node-heading').classList.contains('sort-before-before'));
    }, true);
    assert.deepEqual(await order('body'), ['n4', 'n1', 'n2', 'n3']); assert.equal(await page.locator('.snapshot-note').count(), 0);
    await undo(); assert.deepEqual(await order('body'), ['n1', 'n2', 'n3', 'n4']); await redo();
    await drag(value('p3').locator('.notebook-sort-handle'), value('p1').locator('.notebook-node-heading'), 0.2);
    assert.deepEqual(await order('value'), ['p3', 'p1', 'p2']); assert.equal(await page.locator('.snapshot-note').count(), 0);
    const sortedFile = path.join(output, 'sorted.json'), saved = await save(sortedFile);
    assert.deepEqual(saved.scene.nodes.map(n => n.id), ['n4', 'n1', 'n2', 'n3']); assert.deepEqual(saved.scene.value_nodes.map(n => n.id), ['p3', 'p1', 'p2']);
    assert.deepEqual(await exportMesh(path.join(output, 'sorted.stl')), originalSTL);
    await open(sortedFile); await generate(); assert.deepEqual(await order('body'), ['n4', 'n1', 'n2', 'n3']);
    assert.deepEqual(await exportMesh(path.join(output, 'reopened.stl')), originalSTL);
    await select('n4'); await move('n4', '下移', '变换 4');
    assert.deepEqual(await order('body'), ['n1', 'n4', 'n2', 'n3']);
    const handle = step('n4').locator('.notebook-sort-handle'); await handle.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    assert.deepEqual(await order('body'), ['n1', 'n2', 'n3', 'n4']); assert.equal(await page.locator('.snapshot-note').count(), 0);
    // Scalar connection changes the geometry after generation; undo/redo restore the binding.
    await select('n1'); await drag(value('p1').locator('.reference-output'), input({ kind: 'number', id: 'n1', field: 'dimensions.0' }));
    assert.equal(await editor('n1').getByLabel('半径', { exact: true }).inputValue(), 'radius'); assert.equal(await page.locator('.snapshot-note').count(), 1);
    await generate(); assert.match(await page.locator('.metrics').nth(1).innerText(), /16 ~ 24/);
    await undo(); assert.equal(await editor('n1').getByLabel('半径', { exact: true }).inputValue(), 'outer'); await redo(); assert.equal(await editor('n1').getByLabel('半径', { exact: true }).inputValue(), 'radius'); await undo(); await generate();
    // Body references support a transform input and final output.
    await select('n4'); await drag(step('n1').locator('.reference-output'), input({ kind: 'body', id: 'n4', index: 0 }));
    assert.equal(await editor('n4').getByLabel('输入实体', { exact: true }).inputValue(), 'n1'); await generate();
    await undo(); await generate();
    await settings(); await drag(step('n1').locator('.reference-output'), input({ kind: 'root' })); assert.equal(await page.getByLabel('输出节点', { exact: true }).inputValue(), 'n1'); await undo(); await generate();
    // Vector replaces component bindings, and disables manual components.
    await select('n4'); await editor('n4').getByLabel('位置向量引用', { exact: true }).selectOption('');
    await editor('n4').getByRole('button', { name: 'X 位置使用表达式', exact: true }).click(); await editor('n4').getByLabel('X 位置', { exact: true }).fill('radius');
    await drag(value('p3').locator('.reference-output'), input({ kind: 'vector', id: 'n4', field: 'position' }));
    assert.equal(await editor('n4').getByLabel('位置向量引用', { exact: true }).inputValue(), 'p3'); assert.equal(await editor('n4').getByLabel('X 位置', { exact: true }).isDisabled(), true);
    const linked = await save(path.join(output, 'linked.json')); assert.equal(linked.scene.nodes.find(n => n.id === 'n4').expressions['position.0'], undefined); await generate();
    // Incompatible references and cycles show reasons during drag and leave saved data untouched.
    await select('n3'); const beforeRejected = await save(path.join(output, 'rejected-before.json'));
    for (const [source, destination, reason] of [
      [step('n4').locator('.reference-output'), input({ kind: 'body', id: 'n3', index: 0 }), /循环/],
      [step('n1').locator('.reference-output'), input({ kind: 'body', id: 'n3', index: 1 }), /不同/],
      [value('p1').locator('.reference-output'), input({ kind: 'body', id: 'n3', index: 0 }), /类型/]
    ]) await drag(source, destination, 0.35, async () => assert.match(await destination.locator('.reference-drop-hint').innerText(), reason));
    const afterRejected = await save(path.join(output, 'rejected-after.json')); assert.deepEqual(afterRejected.scene, beforeRejected.scene); assert.equal(await page.locator('.snapshot-note').count(), 0);
    await select('p2'); await drag(value('p2').locator('.reference-output'), input({ kind: 'value-expression', id: 'p2' }), 0.3, async () => assert.match(await input({ kind: 'value-expression', id: 'p2' }).locator('.reference-drop-hint').innerText(), /循环/));
    await drag(value('p1').locator('.reference-output'), input({ kind: 'value-expression', id: 'p2' })); assert.equal(await vEditor('p2').getByLabel('参数公式', { exact: true }).inputValue(), 'radius'); await undo();
    await select('p3'); await drag(value('p2').locator('.reference-output'), input({ kind: 'value-component', id: 'p3', index: 0 })); assert.equal(await vEditor('p3').getByLabel('向量 X', { exact: true }).inputValue(), 'outer'); await undo(); await generate();
    // Sorting does not restart automatic updates, clear cached values or end an intermediate preview.
    await select('n1'); await step('n1').getByRole('button', { name: '预览节点 球体 1', exact: true }).click(); await waitDone('中间节点预览已更新');
    await page.getByRole('checkbox', { name: '自动更新输出', exact: true }).check();
    const preview = await page.locator('.metrics').allTextContents();
    await move('n1', '下移', '球体 1'); await page.waitForTimeout(1200);
    assert.deepEqual(await page.locator('.metrics').allTextContents(), preview); assert.equal(await page.getByRole('button', { name: '返回最终输出', exact: true }).count(), 1); assert.equal(await page.locator('.snapshot-note').count(), 0);
    await undo(); await page.getByRole('checkbox', { name: '自动更新输出', exact: true }).uncheck(); await page.getByRole('button', { name: '返回最终输出', exact: true }).click();
    await page.getByRole('button', { name: '收起所有节点', exact: true }).click(); await select('n3');
    await step('n3').evaluate(el => { const pane = el.closest('.panel-scroll'); pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 120; });
    await capture('electron-node-drag-dark.png'); await page.getByRole('button', { name: '切换亮色主题', exact: true }).click(); await page.waitForTimeout(250); await capture('electron-node-drag-light.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760)); await page.emulateMedia({ reducedMotion: 'reduce' }); await select('n4');
    await step('n4').getByRole('button', { name: '节点操作 变换 4', exact: true }).click(); assert.ok(await page.getByRole('button', { name: '上移节点 变换 4', exact: true }).isVisible()); await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', output, checks: ['native mouse body/value sort and edge scrolling', 'keyboard/buttons reorder', 'sort undo/redo and save/open', 'unchanged STL bytes', 'scalar/body/vector/root drag connections', 'parameter formula/component drag', 'type/cycle/duplicate rejection', 'connection undo/redo', 'sorting preserves preview and automatic-update state', 'dark/light screenshots', '1120x760 and reduced motion'], errors }, null, 2));
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(output); console.error(await page.locator('.workflow-drag-status,.statusbar,.error-banner').allTextContents()); throw error; }
  finally { await app.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
