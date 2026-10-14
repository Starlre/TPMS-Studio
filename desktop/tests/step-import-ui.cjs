const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {execFileSync} = require('node:child_process');
const {_electron:electron} = require('playwright');

async function main() {
  const root=path.resolve(__dirname,'../..'),output=await fs.mkdtemp(path.join(os.tmpdir(),'tpms-step-ui-'));
  const source=path.join(output,'开孔零件.step'),python=process.env.TPMS_PYTHON || 'D:\\anaconda3\\python.exe';
  execFileSync(python,[path.join(root,'test_cad_import.py'),source],{cwd:root,env:{...process.env,PYTHONUTF8:'1'}});
  const env={...process.env,TPMS_PROJECT_ROOT:root,TPMS_PYTHON:python,PYTHONUTF8:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[path.join(root,'desktop'),`--user-data-dir=${path.join(output,'profile')}`],env,timeout:60000});
  const page=await app.firstWindow();page.setDefaultTimeout(60000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const done=async text=>{
    await page.waitForFunction(text=>document.querySelector('.error-banner') || document.querySelector('.statusbar')?.textContent.includes(text) && !document.querySelector('.generate')?.textContent.includes('正在计算'),text);
    assert.equal(await page.locator('.error-banner').count(),0,(await page.locator('.error-banner').allTextContents()).join('\n'));
  };
  const openFile=async file=>app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  const saveFile=async file=>app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);
  const importButton=()=>page.getByRole('button',{name:'导入 STEP',exact:true});
  const update=()=>page.locator('.generate').click();
  try {
    await done('模型已生成');
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button',{name:'切换暗色主题',exact:true}).click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1680,1040));
    await openFile(source);await importButton().click();await done('STEP 已导入');
    assert.deepEqual(await page.getByRole('tab').allTextContents(),['导入模型','检查与测量']);
    assert.match((await page.locator('.metrics').allTextContents()).join(' '),/封闭 \/ 水密/);
    assert.match((await page.locator('.metrics').allTextContents()).join(' '),/CAD 实体1/);
    await page.getByLabel('曲面偏差',{exact:true}).fill('.02');
    await page.getByLabel('角度偏差',{exact:true}).fill('5');
    await update();await done('STEP 已导入');
    await page.getByLabel('导入 X 位置',{exact:true}).fill('10');
    await page.getByLabel('导入 Z 旋转',{exact:true}).fill('90');
    await update();await done('STEP 已导入');
    assert.match((await page.locator('.metrics').allTextContents()).join(' '),/X-2 ~ 22/);
    const project=path.join(output,'imported-project.json');
    await saveFile(project);await page.getByRole('button',{name:'保存项目',exact:true}).click();await done('项目已保存');
    const saved=JSON.parse(await fs.readFile(project,'utf8'));
    assert.equal(saved.mode,'cad');assert.equal(saved.cad.position[0],10);assert.equal(saved.cad.rotation[2],90);
    assert.equal(saved.cad.sha256.length,64);
    await openFile(project);await page.getByRole('button',{name:'打开',exact:true}).click();await done('STEP 项目已打开');
    await page.getByRole('tab',{name:'检查与测量',exact:true}).click();
    await page.getByRole('button',{name:'打开剖切工具',exact:true}).click();
    await page.getByLabel('启用剖切',{exact:true}).check();
    await page.waitForFunction(()=>document.querySelector('.section-statistics')?.textContent.includes('截面材料面积'));
    await page.getByLabel('平面方向',{exact:true}).selectOption('Z');
    await page.getByRole('button',{name:'居中',exact:true}).click();
    await page.getByRole('button',{name:'正对截面',exact:true}).click();
    await page.waitForTimeout(800);
    await page.screenshot({path:path.join(output,'step-section-dark.png'),scale:'css'});
    await page.getByRole('button',{name:'恢复完整模型并清除测量',exact:true}).click();
    await page.getByRole('button',{name:'Z 轴正交方向观察',exact:true}).click();
    await page.locator('.inspection-scroll').getByRole('button',{name:'开始两点测量',exact:true}).click();
    const rect=await page.locator('.canvas-host').boundingBox();
    await page.mouse.click(rect.x+rect.width*.35,rect.y+rect.height*.5);
    await page.waitForFunction(()=>document.querySelector('.inspection-scroll')?.textContent.includes('请选择 B 点'));
    await page.mouse.click(rect.x+rect.width*.65,rect.y+rect.height*.5);
    await page.waitForFunction(()=>document.querySelector('.inspection-scroll')?.textContent.includes('直线距离'));
    await page.getByRole('button',{name:'恢复完整模型并清除测量',exact:true}).click();
    await page.getByRole('button',{name:'重置视角',exact:true}).click();
    await page.getByRole('tab',{name:'导入模型',exact:true}).click();await page.getByRole('button',{name:'模型信息',exact:true}).click();
    const stl=path.join(output,'imported.stl');await saveFile(stl);
    await page.locator('.export-menu>summary').click();await page.getByRole('button',{name:'导出 STL / OBJ / PLY',exact:true}).click();await done('已导出');
    assert.ok((await fs.stat(stl)).size>84);
    // Invalid STEP and cancellation leave the current reference and export intact.
    const invalid=path.join(output,'invalid.step');await fs.writeFile(invalid,'invalid');
    await openFile(invalid);await importButton().click();await page.locator('.error-banner').waitFor();
    assert.match(await page.locator('.error-banner').innerText(),/无法读取|可显示/);
    await page.getByRole('button',{name:'关闭错误提示',exact:true}).click();
    assert.match(await page.locator('.result-name').innerText(),/开孔零件.step/);
    await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
    await importButton().click();await done('已取消导入');
    await page.getByRole('button',{name:'实体建模',exact:true}).click();
    await page.getByRole('button',{name:'导入模型',exact:true}).click();
    await update();await done('STEP 已导入');
    await page.screenshot({path:path.join(output,'step-import-dark.png'),scale:'css'});
    await page.getByRole('button',{name:'切换亮色主题',exact:true}).click();
    await page.getByRole('button',{name:'切换暗色主题',exact:true}).click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1120,760));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'passed',output,project,stl,errors},null,2));
  } catch(e) {await page.screenshot({path:path.join(output,'failure.png')});console.error(output);throw e;}
  finally {await app.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
