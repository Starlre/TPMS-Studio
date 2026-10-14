const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..'), output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-multi-entity-ui-'));
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: process.env.TPMS_PYTHON || 'D:\\anaconda3\\python.exe' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(output, 'profile')}`], env, timeout: 60000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const card = id => page.locator(`[data-node-id="${id}"]`), editor = id => card(id).locator('.notebook-editor').first();
  async function done(text) { await page.waitForFunction(t => document.querySelector('.statusbar')?.textContent.includes(t) && !document.querySelector('.generate')?.textContent.includes('正在计算'), text); }
  async function add(name) { await page.getByRole('button', { name: '新节点', exact: true }).click(); await page.getByRole('region', { name: '创建节点' }).getByRole('button', { name, exact: true }).click(); }
  async function objects(count) { await page.waitForFunction(n => document.querySelector('.canvas-host')?.dataset.objectCount === String(n) && !document.querySelector('.layout-note')?.textContent.includes('正在更新'), count); }
  async function capture(file) { await page.screenshot({ path: path.join(root, 'docs', file), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' }); }
  async function exportMesh(file) {
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, file);
    const menu = page.locator('.export-menu'); if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
    await page.getByRole('button', { name: '导出 STL / OBJ / PLY', exact: true }).click(); await done('已导出'); return fs.readFile(file);
  }
  try {
    await done('模型已生成'); if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: '切换暗色主题', exact: true }).click(); await page.getByRole('button', { name: '实体建模', exact: true }).click();
    await add('球体'); await add('长方体'); await objects(2);
    assert.ok(await page.getByRole('checkbox', { name: '全部实体', exact: true }).isChecked());
    assert.ok(await page.getByRole('checkbox', { name: '半透明', exact: true }).isChecked());
    assert.equal(await page.locator('.layout-legend button').count(), 2);
    assert.equal(await page.locator('.result-name strong').innerText(), '长方体 2');
    await editor('n2').locator('.editor-transforms>summary').click();
    await editor('n2').getByLabel('X 位置', { exact: true }).fill('30'); await objects(2);
    await page.waitForFunction(() => document.querySelector('.metrics:nth-of-type(2)')?.textContent.includes('22 ~ 38') || [...document.querySelectorAll('.metrics')].some(el => el.textContent.includes('22 ~ 38')));
    await page.getByRole('button', { name: '收起所有节点', exact: true }).click(); await card('n2').locator('.notebook-node-select').click();
    await page.locator('.panel-scroll').evaluate(el => { el.scrollTop = 0; }); await capture('electron-multi-entity-dark.png');
    await page.getByRole('button', { name: '切换亮色主题', exact: true }).click(); await page.waitForTimeout(200); await capture('electron-multi-entity-light.png');
    // Fixture places the sphere on the left and box on the right after the joint fit.
    const pickView = await page.locator('.canvas-host').boundingBox();
    await page.mouse.click(pickView.x + pickView.width * 0.35, pickView.y + pickView.height * 0.44);
    await page.waitForFunction(() => document.querySelector('.result-name strong')?.textContent === '球体 1');
    await page.locator('.layout-legend').getByRole('button', { name: '长方体 2', exact: true }).click();
    await page.locator('.layout-legend').getByRole('button', { name: '球体 1', exact: true }).click();
    assert.equal(await page.locator('.result-name strong').innerText(), '球体 1');
    assert.match(await page.locator('.metrics').nth(1).innerText(), /-8 ~ 8/);
    await card('n2').getByRole('button', { name: '隐藏实体 长方体 2', exact: true }).click(); await objects(1);
    await card('n2').getByRole('button', { name: '显示实体 长方体 2', exact: true }).click(); await objects(2);
    await page.getByRole('checkbox', { name: '半透明', exact: true }).uncheck(); await objects(2);
    await page.getByRole('checkbox', { name: '半透明', exact: true }).check();
    const view = await page.locator('.canvas-host').boundingBox();
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2); await page.mouse.down();
    await page.mouse.move(view.x + view.width / 2 + 45, view.y + view.height / 2 + 25, { steps: 10 }); await page.mouse.up();
    assert.equal(await page.locator('.layout-legend button[aria-pressed="true"]').innerText(), '球体 1');
    await card('n2').locator('.notebook-node-select').click(); await editor('n2').locator('.editor-transforms>summary').click();
    await editor('n2').getByLabel('X 位置', { exact: true }).fill('10'); await objects(2);
    await add('差集'); await editor('n3').getByLabel('输入 A', { exact: true }).selectOption('n1'); await editor('n3').getByLabel('输入 B', { exact: true }).selectOption('n2'); await objects(3);
    await page.getByRole('button', { name: '生成工作流', exact: true }).click(); await done('模型已生成');
    assert.equal(await page.getByRole('checkbox', { name: '全部实体', exact: true }).isChecked(), false);
    assert.equal(await page.locator('.layout-legend').count(), 0); assert.equal(await page.locator('.error-banner').count(), 0);
    const finalMesh = await exportMesh(path.join(output, 'final.stl'));
    await page.getByRole('checkbox', { name: '全部实体', exact: true }).check(); await objects(3);
    assert.deepEqual(await exportMesh(path.join(output, 'during-layout.stl')), finalMesh);
    assert.ok(await page.getByRole('button', { name: '剖切与测量', exact: true }).isDisabled());
    // An incomplete operation must not erase valid independent entities.
    await add('差集'); await editor('n4').getByLabel('输入 A', { exact: true }).selectOption(''); await objects(3);
    assert.match(await page.locator('.layout-note').innerText(), /未显示.*输入|上游/);
    assert.ok(await page.getByRole('button', { name: '生成工作流', exact: true }).isDisabled());
    await card('n4').locator('.card-menu-trigger').click(); await page.getByRole('group', { name: '节点操作菜单' }).getByRole('button', { name: '删除节点', exact: true }).click(); await objects(3);
    await card('n1').locator('.notebook-node-select').click(); await editor('n1').getByLabel('半径', { exact: true }).fill('6'); await objects(3);
    await page.waitForFunction(() => [...document.querySelectorAll('.metrics')].some(el => el.textContent.includes('-6 ~ 6')));
    assert.ok(await page.locator('.export-menu .primary').isDisabled());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', output, checks: ['automatic sphere/box simultaneous display', 'relative-position updates and selection', 'translucent/opaque and individual visibility', 'rotation does not select', 'boolean generation and final export isolation', 'incomplete-node tolerance', 'edited dimensions and dirty export protection', 'dark/light screenshots and compact window'], errors }, null, 2));
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(output); console.error(await page.locator('.layout-note,.error-banner').allTextContents()); throw error; }
  finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
