const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..'), output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-cards-ui-'));
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: process.env.TPMS_PYTHON || 'D:\\anaconda3\\python.exe' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(output, 'profile')}`], env, timeout: 60000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(45000);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  const card = id => page.locator(id.startsWith('p') ? `[data-value-id="${id}"]` : `[data-node-id="${id}"]`);
  const edit = id => card(id).locator('.notebook-editor').first();
  async function done(text) { await page.waitForFunction(t => document.querySelector('.statusbar')?.textContent.includes(t) && !document.querySelector('.generate')?.textContent.includes('正在计算'), text); }
  async function add(name, search = '') {
    await page.getByRole('button', { name: '新节点', exact: true }).click();
    await page.getByLabel('搜索节点', { exact: true }).fill(search);
    await page.getByRole('region', { name: '创建节点' }).getByRole('button', { name, exact: true }).click();
  }
  async function select(id) { await card(id).locator('.notebook-node-select').click(); }
  async function menu(id) { await card(id).locator('.card-menu-trigger').click(); return page.getByRole('group', { name: '节点操作菜单' }); }
  async function settings() { const b = page.getByRole('button', { name: '输出设置', exact: true }); if (await b.getAttribute('aria-expanded') !== 'true') await b.click(); }
  async function generate() { await page.getByRole('button', { name: '生成工作流', exact: true }).click(); await done('模型已生成'); assert.equal(await page.locator('.error-banner').count(), 0); }
  async function save(file) { await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, file); await page.getByRole('button', { name: '保存项目', exact: true }).click(); await done('项目已保存'); return JSON.parse(await fs.readFile(file, 'utf8')); }
  async function open(file) { await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, file); await page.getByRole('button', { name: '打开', exact: true }).click(); await done('项目已打开'); }
  async function capture(file) { await page.screenshot({ path: path.join(root, 'docs', file), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' }); }
  try {
    await done('模型已生成');
    await page.getByRole('button', { name: '切换暗色主题', exact: true }).click();
    await page.getByRole('button', { name: '实体建模', exact: true }).click();
    assert.deepEqual(await page.locator('.card-workflow button').allTextContents(), ['新节点']);
    assert.equal(await page.locator('.generate-footer').count(), 0);
    assert.equal(await page.locator('.snapshot-note').count(), 0);
    assert.equal(await page.locator('.result-name strong').innerText(), '待生成');
    assert.equal(await page.getByRole('checkbox', { name: 'GPU 隐式曲面', exact: true }).isDisabled(), true);
    assert.ok(await page.getByRole('heading', { name: '创建你的第一个节点' }).isVisible());
    await capture('electron-notebook-empty.png');
    await page.getByRole('button', { name: '新节点', exact: true }).click();
    await page.getByLabel('搜索节点', { exact: true }).fill('不存在的节点');
    assert.ok(await page.getByText('没有匹配的节点', { exact: true }).isVisible());
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.node-picker').count(), 0);
    await add('球体', '球'); await edit('n1').getByLabel('半径', { exact: true }).fill('5');
    await add('数值参数', '数值'); await edit('p1').getByLabel('引用符号', { exact: true }).fill('radius');
    await edit('p1').getByLabel('参数数值', { exact: true }).fill('5');
    await add('圆柱'); await edit('n2').getByLabel('半径', { exact: true }).fill('1.5'); await edit('n2').getByLabel('高度', { exact: true }).fill('16');
    await add('差集');
    await edit('n3').getByLabel('输入 A', { exact: true }).selectOption('n1');
    await edit('n3').getByLabel('输入 B', { exact: true }).selectOption('n2');
    assert.deepEqual(await page.locator('.card-list>li').evaluateAll(els => els.map(e => e.dataset.nodeId || 'value:' + e.dataset.valueId)), ['n1', 'value:p1', 'n2', 'n3']);
    assert.equal(await page.locator('.workflow-tabs,.notebook-group,.notebook-node-summary,.notebook-actions').count(), 0);
    // The nested editor uses the original node ID; editing it updates the top-level card and every consumer.
    await edit('n3').locator('.nested-reference').first().locator(':scope > summary').click();
    const nested = card('n3').locator('.nested-editor').first();
    await nested.getByLabel('半径参数引用', { exact: true }).selectOption('radius');
    assert.equal(await edit('n1').getByLabel('半径', { exact: true }).inputValue(), 'radius');
    await nested.getByLabel('节点名称', { exact: true }).fill('共享球体');
    assert.equal(await card('n1').locator('.notebook-node-select').innerText(), '共享球体');
    await edit('n3').locator('.nested-reference').first().locator(':scope > summary').click();
    // A title context menu is also discoverable by button and supports keyboard closing.
    await card('n1').locator('.notebook-node-heading').click({ button: 'right' });
    assert.ok(await page.getByRole('group', { name: '节点操作菜单' }).isVisible());
    await page.keyboard.press('Escape');
    const m = await menu('n1'); await m.getByRole('button', { name: '下移节点 共享球体', exact: true }).click(); await page.keyboard.press('Escape');
    assert.deepEqual(await page.locator('.card-list>li').evaluateAll(els => els.map(e => e.dataset.nodeId || 'value:' + e.dataset.valueId)), ['value:p1', 'n1', 'n2', 'n3']);
    await page.getByRole('button', { name: '撤销节点修改', exact: true }).click();
    await generate();
    const stats = await page.locator('.metrics').allTextContents();
    await card('n1').getByRole('button', { name: '预览节点 共享球体', exact: true }).click(); await done('中间节点预览已更新');
    assert.notDeepEqual(await page.locator('.metrics').allTextContents(), stats);
    await card('n1').getByRole('button', { name: '预览节点 共享球体', exact: true }).click();
    assert.deepEqual(await page.locator('.metrics').allTextContents(), stats);
    await card('n1').getByRole('button', { name: '预览节点 共享球体', exact: true }).click(); await done('中间节点预览已更新');
    await page.getByRole('button', { name: '返回最终输出', exact: true }).click();
    assert.deepEqual(await page.locator('.metrics').allTextContents(), stats);
    const saved = await save(path.join(output, 'cards.json'));
    assert.deepEqual(saved.scene.notebook_order, ['n1', 'value:p1', 'n2', 'n3']);
    assert.equal(saved.scene.nodes[0].expressions['dimensions.0'], 'radius');
    await settings(); assert.equal(await page.getByLabel('输出节点', { exact: true }).inputValue(), 'n3');
    await page.getByRole('button', { name: '输出设置', exact: true }).click();
    await page.getByRole('button', { name: '收起所有节点', exact: true }).click(); await select('n3');
    await page.locator('.panel-scroll').evaluate(el => { el.scrollTop = 0; });
    await capture('electron-notebook-cards-dark.png');
    await page.getByRole('button', { name: '切换亮色主题', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.waitForTimeout(200); await capture('electron-notebook-cards-light.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const bounds = await page.locator('.generate').boundingBox(); assert.ok(bounds.y + bounds.height < 760);
    assert.ok(await edit('n3').getByLabel('输入 A', { exact: true }).isVisible());
    // Deletion protection is retained in the overflow menu.
    await (await menu('n1')).getByRole('button', { name: '删除节点', exact: true }).click();
    assert.match(await page.locator('.error-banner').innerText(), /引用/);
    await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
    await (await menu('p1')).getByRole('button', { name: '删除参数', exact: true }).click();
    assert.match(await page.locator('.error-banner').innerText(), /引用/);
    await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
    await card('n1').getByRole('button', { name: '预览节点 共享球体', exact: true }).click(); await done('中间节点预览已更新');
    await open(path.join(output, 'cards.json')); await page.getByRole('checkbox', { name: '全部实体', exact: true }).uncheck(); assert.equal(await page.locator('.result-name strong').innerText(), '待生成');
    assert.ok(await page.getByRole('heading', { name: '生成你的模型' }).isVisible()); await generate();
    assert.deepEqual(await page.locator('.metrics').allTextContents(), stats);
    // The empty project starts blank even after generation/opening/switching workspaces.
    const empty = { ...saved, scene: { version: 1, nodes: [], value_nodes: [], parameters: {}, root: '', cell_size: 0.6 } };
    const emptyFile = path.join(output, 'empty.json'); await fs.writeFile(emptyFile, JSON.stringify(empty)); await open(emptyFile);
    assert.ok(await page.getByRole('heading', { name: '创建你的第一个节点' }).isVisible());
    assert.equal(await page.locator('.metrics strong').first().innerText(), '—');
    await page.getByRole('button', { name: 'TPMS 建模', exact: true }).click();
    await page.getByRole('button', { name: '实体建模', exact: true }).click();
    assert.equal(await page.locator('.card-list>li').count(), 0);
    assert.equal(await page.locator('.result-name strong').innerText(), '待生成');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', output, checks: ['blank start and stale-preview isolation', 'search/create and inline editing', 'mixed persistent order and undo', 'shared nested upstream editing', 'keyboard/context menus and dependency protection', 'real libfive generation and isolated preview', 'save/open and blank project', 'dark/light screenshots and compact layout'], errors }, null, 2));
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(output); throw error; }
  finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
