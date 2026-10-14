const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-ribbon-ui-'));
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: 'D:\\anaconda3\\python.exe' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args:[path.join(root,'desktop'), `--user-data-dir=${path.join(output,'profile')}`],env,timeout:60000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(40000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const ribbon = page.getByRole('region', { name:'顶部功能工具栏' });
  // A named section is exposed as a region.
  const tabs = ribbon.getByRole('tab');
  const choose = name => ribbon.getByRole('tab',{name,exact:true}).click();
  const click = name => ribbon.getByRole('button',{name,exact:true}).click();
  async function done(text) { await page.waitForFunction(t => document.querySelector('.statusbar')?.textContent.includes(t) && !document.querySelector('.generate')?.textContent.includes('正在计算'),text,{timeout:90000}); }
  async function capture(file) {
    await page.waitForTimeout(250); // Capture the settled theme/focus colors, not a transition frame.
    await page.screenshot({path:path.join(root,'docs',file),scale:'css',style:'.statusbar [role="status"] { visibility:hidden; }'});
  }
  try {
    await done('模型已生成');
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button',{name:'切换暗色主题',exact:true}).click();
    const modes = page.getByRole('navigation',{name:'建模工作区'});
    assert.deepEqual(await modes.getByRole('button').allTextContents(),['TPMS 建模','实体建模']);
    assert.equal(await page.getByRole('button',{name:'实体组合',exact:true}).count(),0);
    assert.deepEqual(await tabs.allTextContents(),['TPMS','检查与测量','仿真与网格']);
    assert.equal(await page.locator('#ribbon-tab-model,#ribbon-tab-values,#ribbon-panel-model,#ribbon-panel-values').count(),0);
    await choose('TPMS');
    assert.equal(await ribbon.getByRole('button',{name:'添加 TPMS',exact:true}).count(),0);
    const metrics = await page.locator('.metrics').allTextContents();
    const footer = await page.locator('.generate-footer').innerText();
    for (const name of ['TPMS','检查与测量','仿真与网格']) {
      await choose(name);
      assert.equal(await ribbon.getByRole('tabpanel').count(),1);
      assert.equal(await ribbon.getByRole('tab',{name,exact:true}).getAttribute('aria-selected'),'true');
    }
    assert.deepEqual(await page.locator('.metrics').allTextContents(),metrics);
    assert.equal(await page.locator('.generate-footer').innerText(),footer);
    await tabs.first().focus(); await page.keyboard.press('End');
    assert.equal(await tabs.last().getAttribute('aria-selected'),'true');
    await page.keyboard.press('ArrowRight'); assert.equal(await tabs.first().getAttribute('aria-selected'),'true');
    await page.keyboard.press('ArrowLeft'); assert.equal(await tabs.last().getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home'); assert.equal(await tabs.first().getAttribute('aria-selected'),'true');
    const before = await page.locator('.workspace').boundingBox();
    await click('收起功能工具栏'); assert.equal(await ribbon.getByRole('tabpanel').count(),0);
    assert.ok((await page.locator('.workspace').boundingBox()).height > before.height + 60);
    await choose('TPMS'); assert.equal(await ribbon.getByRole('tabpanel').count(),1);
    await capture('electron-ribbon-dark.png');
    await page.getByRole('button',{name:'切换亮色主题',exact:true}).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await capture('electron-ribbon-light.png');
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1120,760));
    await page.waitForFunction(() => innerWidth <= 1120);
    for (const name of ['TPMS','检查与测量','仿真与网格']) {
      await choose(name);
      const dimensions = await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,
        button:document.querySelector('.generate').getBoundingClientRect().toJSON(),height:innerHeight}));
      assert.ok(dimensions.scroll <= dimensions.width);
      assert.ok(dimensions.button.bottom < dimensions.height && dimensions.button.top > 0);
    }
    await choose('检查与测量'); await click('打开剖切工具');
    assert.equal(await page.locator('.inspection-scroll').count(),1);
    await click('开始两点测量'); await click('线框显示');
    assert.equal(await ribbon.getByRole('button',{name:'线框显示',exact:true}).getAttribute('aria-pressed'),'true');
    await click('线框显示'); await click('恢复整体视角'); await click('查看模型信息');
    await choose('TPMS'); await click('壁厚与孔隙率');
    assert.equal(await page.getByLabel('结构模式',{exact:true}).count(),1);
    await click('曲面与尺寸'); assert.equal(await page.getByLabel('曲面类型',{exact:true}).count(),1);
    await choose('仿真与网格'); await click('收起功能工具栏');
    await modes.getByRole('button',{name:'实体建模',exact:true}).click();
    assert.deepEqual(await tabs.allTextContents(),['建模','操作','TPMS 节点','参数与公式','检查与测量']);
    assert.equal(await tabs.first().getAttribute('aria-selected'),'true');
    assert.equal(await ribbon.getByRole('tabpanel').count(),1);
    assert.equal(await page.locator('#ribbon-tab-cfd,#ribbon-panel-cfd').count(),0);
    await choose('TPMS 节点');
    assert.equal(await ribbon.getByRole('button',{name:'曲面与尺寸',exact:true}).count(),0);
    assert.ok(await ribbon.getByRole('button',{name:'添加 TPMS',exact:true}).isVisible());
    await choose('参数与公式');
    await modes.getByRole('button',{name:'TPMS 建模',exact:true}).click();
    assert.deepEqual(await tabs.allTextContents(),['TPMS','检查与测量','仿真与网格']);
    assert.equal(await tabs.first().getAttribute('aria-selected'),'true');
    await modes.getByRole('button',{name:'实体建模',exact:true}).click();
    // Keyboard navigation must cycle only through tabs available in this workspace.
    await tabs.first().focus(); await page.keyboard.press('End');
    assert.equal(await tabs.last().getAttribute('aria-selected'),'true');
    await page.keyboard.press('ArrowRight'); assert.equal(await tabs.first().getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home');
    assert.ok(await ribbon.getByRole('button',{name:'添加并集',exact:true}).isDisabled());
    await click('创建球体'); assert.equal(await page.locator('[data-node-id]').count(),1);
    await click('创建圆柱'); await click('添加差集'); await click('独立变换');
    assert.equal(await page.locator('[data-node-id]').count(),4);
    assert.equal(await page.locator('[data-editor-node-id="n4"]').count(),1);
    await choose('参数与公式');
    for (const name of ['新建数值参数','新建公式参数','新建向量参数']) await click(name);
    assert.equal(await page.locator('[data-value-id]').count(),3);
    await click('求值全部参数'); await done('参数值计算完成');
    await choose('建模'); await click('撤销编辑'); assert.equal(await page.locator('[data-value-id]').count(),2);
    await click('重做编辑'); assert.equal(await page.locator('[data-value-id]').count(),3);
    assert.equal(await ribbon.getByRole('tab',{name:'仿真与网格',exact:true}).count(),0);
    for (const name of ['编辑 CFD 参数','显示仿真边界','打开网格质量检查','导出流体体网格']) assert.equal(await ribbon.getByRole('button',{name,exact:true}).count(),0);
    const fixture = path.join(output,'ribbon-project.json');
    await app.evaluate(({dialog},file) => { dialog.showSaveDialog = async () => ({canceled:false,filePath:file}); },fixture);
    await page.getByRole('button',{name:'保存项目',exact:true}).click(); await done('项目已保存');
    const saved = JSON.parse(await fs.readFile(fixture,'utf8'));
    assert.equal(saved.mode,'nodes'); assert.equal(saved.scene.root,'n4');
    assert.deepEqual(saved.scene.nodes[2].inputs,['n2','n1']);
    assert.deepEqual(saved.scene.nodes[3].inputs,['n3']);
    assert.deepEqual(saved.scene.value_nodes.map(n=>n.kind),['number','formula','vector']);
    await page.getByRole('button',{name:'生成工作流',exact:true}).click(); await done('模型已生成');
    assert.equal(await page.locator('.error-banner').count(),0);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1520,980));
    await choose('建模'); await capture('electron-ribbon-nodes.png');
    await choose('TPMS 节点'); await click('添加 TPMS'); await choose('建模');
    assert.ok(await ribbon.getByRole('button',{name:'添加平滑融合',exact:true}).isDisabled());
    await choose('TPMS 节点'); await click('添加隐式公式');
    assert.equal(await page.locator('[data-node-id]').count(),6);
    // Both legacy Electron envelopes and raw Qt scene JSON enter the unified workspace.
    for (const [name, project] of [['legacy-electron',{...saved,mode:'solid'}],['legacy-raw',saved.scene]]) {
      const source = path.join(output,name+'.json'), migratedFile = path.join(output,name+'-migrated.json');
      await fs.writeFile(source,JSON.stringify(project));
      await app.evaluate(({dialog},{source,target}) => {
        dialog.showOpenDialog = async () => ({canceled:false,filePaths:[source]});
        dialog.showSaveDialog = async () => ({canceled:false,filePath:target});
      },{source,target:migratedFile});
      await page.getByRole('button',{name:'打开',exact:true}).click(); await done('项目已打开');
      assert.equal(await modes.getByRole('button',{name:'实体建模',exact:true}).getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('[data-node-id]').count(),saved.scene.nodes.length);
      assert.equal(await page.locator('[data-value-id]').count(),saved.scene.value_nodes.length);
      assert.ok(await page.locator('.export-menu .primary').isDisabled());
      await page.getByRole('button',{name:'保存项目',exact:true}).click(); await done('项目已保存');
      const migrated = JSON.parse(await fs.readFile(migratedFile,'utf8'));
      assert.equal(migrated.mode,'nodes'); assert.equal(migrated.scene.root,saved.scene.root);
      assert.deepEqual(migrated.scene.value_nodes,saved.scene.value_nodes);
      if (name === 'legacy-electron') assert.deepEqual(migrated.scene,saved.scene);
      await page.getByRole('button',{name:'生成工作流',exact:true}).click(); await done('模型已生成');
      assert.equal(await page.locator('.error-banner').count(),0);
    }
    assert.deepEqual(errors,[]);
    console.log('Ribbon UI passed: tabs, keyboard, collapse, themes, compact layout, real node/parameter creation, history, save, libfive generation and CFD/TPMS restrictions.');
  } catch (error) {
    await page.screenshot({path:path.join(output,'failure.png')});
    console.error('Artifacts: ' + output);
    console.error(await page.locator('.error-banner,.statusbar').allTextContents());
    throw error;
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
