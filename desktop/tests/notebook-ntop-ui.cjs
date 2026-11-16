const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..'), output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-ntop-ui-'));
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
    if (search) await page.getByLabel('搜索节点', { exact: true }).fill(search);
    await page.getByRole('region', { name: '创建节点' }).getByRole('button', { name, exact: true }).click();
  }
  async function save(file) {
    await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, file);
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await done('项目已保存');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  async function open(file) {
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, file);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await done('项目已打开');
  }
  async function capture(file) {
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(root, 'docs', file), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' });
  }
  try {
    await done('模型已生成');
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: '切换暗色主题', exact: true }).click();
    await page.getByRole('button', { name: '实体建模', exact: true }).click();

    // 1. Create parameter & formula blocks
    await add('数值参数', '数值');
    await edit('p1').getByLabel('引用符号', { exact: true }).fill('wall');
    await edit('p1').getByLabel('参数数值', { exact: true }).fill('2');
    await add('公式参数', '公式');
    await edit('p2').getByLabel('引用符号', { exact: true }).fill('outer_r');
    await edit('p2').getByLabel('参数公式', { exact: true }).fill('wall * 4');

    // 2. Rename parameter symbol and verify downstream formula auto-syncs atomically
    await card('p1').locator('.notebook-node-select').click();
    await edit('p1').getByLabel('引用符号', { exact: true }).fill('core_w');
    await edit('p1').getByRole('button', { name: /应用并同步/, exact: false }).click();
    assert.equal(await edit('p1').getByLabel('引用符号', { exact: true }).inputValue(), 'core_w');
    assert.equal(await edit('p2').getByLabel('参数公式', { exact: true }).inputValue(), 'core_w * 4');

    // 3. Create section, rename, add note, collapse and expand
    await page.getByRole('button', { name: '新建章节', exact: true }).click();
    const secInput = page.locator('[data-section-id="s1"] input[aria-label="章节名称"]');
    await secInput.fill('主体布尔与孔道');
    await secInput.press('Enter');
    await page.locator('[data-section-id="s1"]').getByRole('button', { name: /编辑章节.*注释/ }).click();
    await page.locator('[data-section-id="s1"] textarea').fill('球体半径由 core_w * 4 驱动，孔道为内嵌子块');

    // 4. Create parent sphere & difference, then inline-create cylinder in Slot B
    await add('球体', '球');
    await edit('n1').getByLabel('半径参数引用', { exact: true }).selectOption('outer_r');
    await add('差集', '差集');
    await edit('n2').getByLabel('输入 A', { exact: true }).selectOption('n1');
    const slotB = edit('n2').locator('[data-reference-target=\'{"kind":"body","id":"n2","index":1}\']');
    await slotB.getByRole('button', { name: '就地新建', exact: true }).click();
    await slotB.getByRole('region', { name: '就地新建子块' }).getByRole('button', { name: '圆柱', exact: true }).click();

    // Verify inline child is NOT rendered as top-level card, but IS open inside nested editor
    assert.equal(await page.locator('.card-list > [data-node-id="n3"]').count(), 0);
    assert.ok(await slotB.locator('.inline-badge').isVisible());
    const nestedCyl = slotB.locator('.nested-editor [data-editor-node-id="n3"]');
    await nestedCyl.getByLabel('半径', { exact: true }).fill('2.5');
    await nestedCyl.getByLabel('高度', { exact: true }).fill('22');

    // Capture Notebook screenshot showing section + parameter sync + inline nested cylinder
    await capture('electron-notebook-ntop-dark.png');

    // 5. Generate real geometry with inline child
    await page.getByRole('button', { name: '生成工作流', exact: true }).click();
    await done('模型已生成');
    assert.equal(await page.locator('.error-banner').count(), 0);

    // 6. Test keyboard Isolate shortcut (`I`) on top-level node n1 -> toggle back to output
    await card('n1').locator('.notebook-node-select').click();
    const outStats = await page.locator('.metrics').allTextContents();
    await page.locator('.viewport').click({ position: { x: 40, y: 40 } });
    await page.keyboard.press('i');
    await done('中间节点预览已更新');
    assert.notDeepEqual(await page.locator('.metrics').allTextContents(), outStats);
    await page.keyboard.press('i');
    assert.deepEqual(await page.locator('.metrics').allTextContents(), outStats);

    // 7. Test Make Variable (promote inline n3 -> top level) & Demote back to inline
    await card('n2').locator('.notebook-node-select').click();
    await slotB.getByRole('button', { name: '提升为独立卡片', exact: true }).click();
    assert.equal(await page.locator('.card-list > [data-node-id="n3"]').count(), 1);
    await card('n2').locator('.notebook-node-select').click();
    await slotB.getByRole('button', { name: '转为内嵌子块', exact: true }).click();
    assert.equal(await page.locator('.card-list > [data-node-id="n3"]').count(), 0);

    // 8. Test Section collapse hides children cleanly and displays badges, then expand
    await page.locator('[data-section-id="s1"] .notebook-disclosure').click();
    assert.equal(await page.locator('.card-list > [data-node-id]').count(), 0);
    assert.ok(await page.locator('[data-section-id="s1"] .section-output-pill').isVisible());
    await page.locator('[data-section-id="s1"] .notebook-disclosure').click();
    assert.equal(await page.locator('.card-list > [data-node-id]').count(), 2);

    // Light theme screenshot & Save/Open roundtrip check
    await page.getByRole('button', { name: '切换亮色主题', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await capture('electron-notebook-ntop-light.png');

    const projFile = path.join(output, 'ntop-project.json');
    const saved = await save(projFile);
    assert.deepEqual(saved.scene.inline_nodes, ['n3']);
    assert.equal(saved.scene.notebook_sections[0].name, '主体布尔与孔道');
    assert.equal(saved.scene.value_nodes[1].expression, 'core_w * 4');

    await open(projFile);
    assert.equal(await page.locator('.card-list > [data-node-id]').count(), 2);
    assert.equal(await page.locator('[data-section-id="s1"]').count(), 1);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
      result: 'passed',
      output,
      checks: [
        'symbol rename auto-sync across formula',
        'section creation, rename, note and collapse badges',
        'inline slot creation without cluttering top-level list',
        'promote (Make Variable) and demote toggle',
        'real libfive generation with inline children',
        'viewport I isolate hotkey toggle',
        'project JSON roundtrip for sections and inline_nodes'
      ],
      errors
    }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error(output);
    throw error;
  } finally {
    await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
