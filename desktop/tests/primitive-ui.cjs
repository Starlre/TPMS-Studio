const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {_electron:electron} = require('playwright');

async function main() {
  const root = path.resolve(__dirname,'../..'), output = await fs.mkdtemp(path.join(os.tmpdir(),'tpms-primitives-ui-'));
  const env = {...process.env,TPMS_PROJECT_ROOT:root,TPMS_PYTHON:'D:\\anaconda3\\python.exe',PYTHONUTF8:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({args:[path.join(root,'desktop'),`--user-data-dir=${path.join(output,'profile')}`],env,timeout:60000});
  const page = await app.firstWindow(); page.setDefaultTimeout(120000);
  const errors=[]; page.on('pageerror',error => errors.push(error.message));
  const done = async text => {
    await page.waitForFunction(text => document.querySelector('.error-banner') || document.querySelector('.statusbar')?.textContent.includes(text) && !document.querySelector('.generate')?.textContent.includes('正在计算'),text);
    assert.equal(await page.locator('.error-banner').count(),0,(await page.locator('.error-banner').allTextContents()).join('\n'));
  };
  const open = () => page.getByRole('button',{name:'展开基本体选项',exact:true}).click();
  const palette = page.getByRole('region',{name:'基本体选项',exact:true});
  const capture = async name => {await page.mouse.move(500,85);await page.waitForTimeout(250);assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await page.screenshot({path:path.join(output,name),scale:'css',style:'.statusbar [role="status"] {visibility:hidden;}'});};
  try {
    await done('模型已生成');
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button',{name:'切换暗色主题',exact:true}).click();
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1680,1040));
    await page.getByRole('button',{name:'实体建模',exact:true}).click();
    const all = page.getByRole('checkbox',{name:'全部实体',exact:true}); if (await all.isChecked()) await all.uncheck();
    await open(); assert.equal(await palette.locator('.palette-item').count(),11);
    await page.keyboard.press('End'); assert.equal(await page.locator(':focus').getAttribute('aria-label'),'创建圆环');
    await page.keyboard.press('Home'); assert.equal(await page.locator(':focus').getAttribute('aria-label'),'创建长方体');
    await page.keyboard.press('Escape'); assert.equal(await palette.count(),0);
    assert.equal(await page.locator(':focus').getAttribute('aria-label'),'展开基本体选项');
    await open(); await page.locator('.viewport-title').click(); assert.equal(await palette.count(),0);
    const {PRIMITIVES} = await import('../src/primitive_catalog.mjs');
    for (const item of PRIMITIVES) {
      await open(); await palette.getByRole('button',{name:`创建${item.name}`,exact:true}).click();
      assert.equal(await palette.count(),0);
      const editor = page.locator('[data-editor-node-id]').last();
      for (let i=0;i<item.labels.length;i++) assert.equal(await editor.getByLabel(item.labels[i],{exact:true}).inputValue(),String(item.dimensions[i]));
    }
    assert.equal(await page.locator('.card-node[data-node-id]').count(),11);
    await all.check();
    await page.waitForFunction(()=>document.querySelector('.canvas-host')?.dataset.objectCount==='11' && !document.querySelector('.layout-note')?.textContent.includes('正在更新'));
    assert.ok(!await page.locator('.layout-note').count() || !(await page.locator('.layout-note').innerText()).includes('失败'));
    await all.uncheck();
    const projectFile = path.join(output,'primitives.json');
    await app.evaluate(({dialog},file) => {dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},projectFile);
    await page.getByRole('button',{name:'保存项目',exact:true}).click(); await done('项目已保存');
    const saved = JSON.parse(await fs.readFile(projectFile,'utf8'));
    assert.deepEqual(saved.scene.nodes.map(n=>n.kind),PRIMITIVES.map(n=>n.kind));
    // Select a rounded body as final output, alter its fourth dimension, generate and export.
    const rounded = saved.scene.nodes.find(n=>n.kind==='rounded_box');
    await page.getByRole('button',{name:`选择步骤 ${rounded.name}`,exact:true}).click();
    const editor = page.locator(`[data-editor-node-id="${rounded.id}"]`);
    await editor.getByLabel('圆角半径',{exact:true}).fill('2.5');
    await page.getByRole('button',{name:'输出设置',exact:true}).click();
    await page.getByLabel('输出节点',{exact:true}).selectOption(rounded.id);
    await page.getByRole('button',{name:'生成工作流',exact:true}).click();await done('模型已生成');
    await capture('primitive-rounded-body-dark.png');
    const exported = path.join(output,'rounded-box.stl');
    await app.evaluate(({dialog},file) => {dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exported);
    await page.locator('.export-menu>summary').click();
    await page.getByRole('button',{name:'导出 STL / OBJ / PLY',exact:true}).click();await done('已导出');
    assert.ok((await fs.stat(exported)).size>84);
    await open();await capture('primitive-palette-dark.png');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'切换亮色主题',exact:true}).click();await open();
    assert.equal(await palette.locator('.palette-item').count(),11);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'切换暗色主题',exact:true}).click();
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1120,760));await open();
    const rect = await palette.boundingBox();assert.ok(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=1120 && rect.y+rect.height<=760);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'passed',output,errors,checks:['11 editable primitives','palette keyboard / Escape / outside close','project serialization','fourth dimension / generation / STL export','dark / light / compact layout']},null,2));
  } catch (error) {await page.screenshot({path:path.join(output,'failure.png')});console.error(output);throw error;}
  finally {await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
