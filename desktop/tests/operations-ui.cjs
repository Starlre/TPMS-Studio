const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {_electron:electron} = require('playwright');

async function main() {
  const root = path.resolve(__dirname,'../..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(),'tpms-operations-ui-'));
  const env = {...process.env,TPMS_PROJECT_ROOT:root,TPMS_PYTHON:'D:\\anaconda3\\python.exe',PYTHONUTF8:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({args:[path.join(root,'desktop'),`--user-data-dir=${path.join(output,'profile')}`],env,timeout:60000});
  const page = await app.firstWindow();page.setDefaultTimeout(180000);
  await app.evaluate(({dialog}) => {globalThis.opsOriginalDialogs={open:dialog.showOpenDialog,save:dialog.showSaveDialog};});
  const errors=[];page.on('pageerror',error => errors.push(error.message));
  const done = async text => {
    await page.waitForFunction(text => document.querySelector('.error-banner') || document.querySelector('.statusbar')?.textContent.includes(text) && !document.querySelector('.generate')?.textContent.includes('正在计算'),text);
    assert.equal(await page.locator('.error-banner').count(),0,(await page.locator('.error-banner').allTextContents()).join('\n'));
  };
  const editor = () => page.locator('[data-editor-node-id]').last();
  const fill = async (label,value) => editor().getByLabel(label,{exact:true}).fill(String(value));
  let success = false;
  try {
    await done('模型已生成');
    await page.getByRole('button',{name:'切换暗色主题',exact:true}).click();
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1680,1040));
    assert.equal(await page.getByRole('tab',{name:'操作',exact:true}).count(),0);
    await page.getByRole('button',{name:'实体建模',exact:true}).click();
    await page.getByRole('tab',{name:'操作',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'抽壳',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'切除',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'添加并集',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'拉伸',exact:true}).count(),0);
    await page.getByRole('button',{name:'新节点',exact:true}).click();
    assert.equal(await page.locator('.node-picker').getByRole('button',{name:'拉伸',exact:true}).count(),0);
    assert.equal(await page.locator('.node-picker').getByRole('button',{name:'切除',exact:true}).count(),0);
    await page.keyboard.press('Escape');
    await page.getByRole('tab',{name:'建模',exact:true}).click();
    await page.getByRole('button',{name:'创建长方体',exact:true}).click();
    await fill('X 长度',30);await fill('Y 长度',24);await fill('Z 长度',18);
    const all = page.getByRole('checkbox',{name:'全部实体',exact:true});if(await all.isChecked()) await all.uncheck();
    await page.getByRole('tab',{name:'操作',exact:true}).click();
    const open = () => page.getByRole('button',{name:'展开操作选项',exact:true}).click();
    await open();const palette = page.getByRole('region',{name:'操作选项',exact:true});
    assert.equal(await palette.locator('.palette-item').count(),1);
    await page.keyboard.press('End');assert.equal(await page.locator(':focus').getAttribute('aria-label'),'抽壳');
    await page.keyboard.press('Escape');assert.equal(await palette.count(),0);
    assert.equal(await page.locator(':focus').getAttribute('aria-label'),'展开操作选项');
    await page.getByRole('button',{name:'抽壳',exact:true}).click();
    await fill('壳体壁厚',1.5);
    await editor().getByLabel('开口方向',{exact:true}).selectOption('+Z');
    await page.getByRole('button',{name:'生成工作流',exact:true}).click();await done('模型已生成');
    assert.match((await page.locator('.metrics').allTextContents()).join(' '),/封闭 \/ 水密/);
    await page.screenshot({path:path.join(output,'shell-dark.png'),scale:'css'});
    const projectFile = path.join(output,'shell-demo.json');
    await app.evaluate(({dialog},file) => {dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},projectFile);
    await page.getByRole('button',{name:'保存项目',exact:true}).click();await done('项目已保存');
    const saved = JSON.parse(await fs.readFile(projectFile,'utf8'));
    assert.deepEqual(saved.scene.nodes.map(n=>n.kind),['box','shell']);
    assert.equal(saved.scene.nodes[1].operation.opening,'+Z');
    const stl = path.join(output,'shell-demo.stl');
    await app.evaluate(({dialog},file) => {dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},stl);
    await page.locator('.export-menu>summary').click();await page.getByRole('button',{name:'导出 STL / OBJ / PLY',exact:true}).click();await done('已导出');
    assert.ok((await fs.stat(stl)).size>84);
    await app.evaluate(({dialog},file) => {dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},projectFile);
    await page.getByRole('button',{name:'打开',exact:true}).click();await done('项目已打开');
    if(await all.isChecked()) await all.uncheck();
    await page.getByRole('button',{name:'生成工作流',exact:true}).click();await done('模型已生成');
    // A legacy project is rejected without replacing the working scene.
    const legacyFile = path.join(output,'legacy-operation.json');
    const legacy = structuredClone(saved);legacy.scene.nodes[0].kind='extrude';
    await fs.writeFile(legacyFile,JSON.stringify(legacy));
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},legacyFile);
    await page.getByRole('button',{name:'打开',exact:true}).click();
    await page.locator('.error-banner').waitFor();
    assert.match(await page.locator('.error-banner').innerText(),/拉伸和切除操作已移除/);
    assert.equal(await page.locator('[data-node-id="n2"]').count()>0,true);
    await page.getByRole('button',{name:'关闭错误提示',exact:true}).click();
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},projectFile);
    await open();await page.screenshot({path:path.join(output,'operations-palette-dark.png'),scale:'css'});await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'切换亮色主题',exact:true}).click();await open();assert.equal(await palette.locator('.palette-item').count(),1);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'切换暗色主题',exact:true}).click();
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1120,760));await open();
    const rect=await palette.boundingBox();assert.ok(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=1120 && rect.y+rect.height<=760);
    await page.keyboard.press('Escape');
    await app.evaluate(({dialog,BrowserWindow}) => {
      dialog.showOpenDialog=globalThis.opsOriginalDialogs.open;dialog.showSaveDialog=globalThis.opsOriginalDialogs.save;delete globalThis.opsOriginalDialogs;
      const win=BrowserWindow.getAllWindows()[0];win.setSize(1680,1040);win.show();win.focus();
    });
    await page.getByRole('button',{name:'收起所有节点',exact:true}).click();
    await page.locator('.panel-scroll').evaluate(el=>{el.scrollTop=0;});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'passed',output,projectFile,stl,errors,metrics:await page.locator('.metrics').allTextContents()},null,2));success=true;
  } catch(error) {await page.screenshot({path:path.join(output,'failure.png')});console.error(output);throw error;}
  finally {if(!process.env.TPMS_KEEP_OPEN || !success) await app.close();}
  if(process.env.TPMS_KEEP_OPEN && success) await page.waitForEvent('close',{timeout:0}).catch(()=>{});
}
main().catch(error=>{console.error(error);process.exitCode=1;});
