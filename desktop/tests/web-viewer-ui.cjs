const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname,'../..'), docs = path.join(root,'docs');
  const output = await fs.mkdtemp(path.join(os.tmpdir(),'tpms-web-viewer-'));
  const metadata = JSON.parse(await fs.readFile(path.join(docs,'models/gyroid-flanged-core.metadata.json'),'utf8'));
  const localSTL = await fs.readFile(path.join(docs,metadata.file));
  assert.equal(createHash('sha256').update(localSTL).digest('hex'),metadata.sha256);
  assert.equal(localSTL.length,metadata.stl_bytes); assert.equal(localSTL.readUInt32LE(80),metadata.faces);
  const server = http.createServer(async (request,response) => {
    try {
      const url = new URL(request.url,'http://localhost');
      if (!url.pathname.startsWith('/TPMS-Studio/')) { response.writeHead(404); response.end(); return; }
      const relative = decodeURIComponent(url.pathname.slice('/TPMS-Studio/'.length)) || 'index.html';
      const file = path.resolve(docs,relative);
      if (!file.startsWith(docs+path.sep)) { response.writeHead(403); response.end(); return; }
      const data = await fs.readFile(file), extension = path.extname(file);
      const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.stl':'application/octet-stream'};
      response.writeHead(200,{'Content-Type':types[extension] || 'application/octet-stream','Content-Length':data.length}); response.end(data);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const live = process.argv.includes('--live');
  const base = live ? 'https://starlre.github.io/TPMS-Studio/' : `http://127.0.0.1:${server.address().port}/TPMS-Studio/`;
  let browser;
  try { browser = await chromium.launch({headless:true}); }
  catch (error) {
    try { browser = await chromium.launch({headless:true,channel:'msedge'}); }
    catch { await new Promise(resolve => server.close(resolve)); throw error; }
  }
  const page = await browser.newPage({viewport:{width:1680,height:1040},deviceScaleFactor:1}); page.setDefaultTimeout(60000);
  const errors = [], external = [];
  page.on('pageerror',error => errors.push(error.message));
  page.on('request',request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.push(request.url()); });
  async function ready(target = page) { await target.waitForFunction(() => document.querySelector('#viewport')?.dataset.loaded === 'true',{},{timeout:180000}); }
  async function cutReady() { await page.waitForFunction(() => document.querySelector('#viewport')?.dataset.sectionReady && document.querySelector('#section-statistics')?.textContent.includes('截面面积')); assert.ok(!await page.locator('#section-message').evaluate(el => el.classList.contains('error')),await page.locator('#section-message').innerText()); }
  async function capture(name,target = page) { assert.equal(await target.locator('html').getAttribute('data-theme'),'dark'); await target.mouse.move(5,5); await target.waitForTimeout(250); await target.screenshot({path:path.join(output,name),scale:'css'}); }
  try {
    await page.goto(live ? `${base}?v=${metadata.sha256.slice(0,12)}` : base); await ready();
    assert.equal(await page.locator('.node-card').count(),19);
    assert.equal(await page.locator('#design-parameters>div').count(),3);
    assert.equal(await page.locator('#viewport').getAttribute('data-faces'),String(metadata.faces));
    assert.equal(await page.locator('#triangle-count').innerText(),'363,544');
    assert.match(await page.locator('#file-size').innerText(),/17\.34/);
    await page.locator('.node-card').first().locator('summary').click();
    assert.match(await page.locator('.node-card').first().innerText(),/1\.4 mm/);
    assert.deepEqual(await page.getByRole('tab').allTextContents(),['建模','操作','TPMS 节点','参数与公式','检查与测量']);
    for (const label of ['创建球体','创建长方体','创建圆柱','创建圆环','添加并集','添加交集','添加差集','添加平滑融合','独立变换','复制实体','撤销编辑','重做编辑']) {
      assert.ok(await page.getByRole('button',{name:label,exact:true}).isVisible());
      assert.ok(await page.getByRole('button',{name:label,exact:true}).isDisabled());
    }
    await page.getByRole('tab',{name:'操作',exact:true}).click();
    assert.ok(await page.getByRole('button',{name:'抽壳',exact:true}).isDisabled());
    assert.equal(await page.getByRole('button',{name:'拉伸',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'切除',exact:true}).count(),0);
    const operations = page.getByRole('region',{name:'操作选项',exact:true});
    await page.getByRole('button',{name:'展开操作选项',exact:true}).click();
    assert.equal(await operations.locator('.palette-item').count(),1);
    assert.equal(await operations.getByRole('button',{name:'抽壳',exact:true}).getAttribute('aria-disabled'),'true');
    await page.keyboard.press('End');assert.equal(await page.locator(':focus').getAttribute('aria-label'),'抽壳');
    await capture('web-operations-palette-dark.png');
    await page.keyboard.press('Escape');assert.ok(await operations.isHidden());
    assert.equal(await page.locator(':focus').getAttribute('aria-label'),'展开操作选项');
    await page.getByRole('tab',{name:'TPMS 节点',exact:true}).click();
    assert.ok(await page.getByRole('button',{name:'添加 TPMS',exact:true}).isVisible());
    await page.getByRole('tab',{name:'参数与公式',exact:true}).click();
    assert.ok(await page.getByRole('button',{name:'新建公式参数',exact:true}).isDisabled());
    await page.getByRole('button',{name:'TPMS 建模',exact:true}).click();
    assert.deepEqual(await page.getByRole('tab').allTextContents(),['TPMS','检查与测量','仿真与网格']);
    assert.ok(await page.locator('#tpms-project').isVisible());
    assert.equal(await page.locator('#tpms-structure-fields input').first().inputValue(),'片层结构');
    assert.equal(await page.locator('#tpms-structure-fields input').nth(1).inputValue(),'1.4');
    await page.getByRole('tab',{name:'仿真与网格',exact:true}).click();
    assert.ok(await page.getByRole('button',{name:'显示仿真边界',exact:true}).isDisabled());
    await page.getByRole('button',{name:'实体建模',exact:true}).click();
    assert.equal(await page.locator('.node-card').count(),19);
    await page.getByRole('tab',{name:'建模',exact:true}).focus(); await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab',{name:'检查与测量',exact:true}).getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home');
    await page.getByRole('button',{name:'操作说明',exact:true}).click();
    assert.ok(await page.locator('#help-dialog').isVisible()); await page.keyboard.press('Escape');
    await page.locator('#info-model-tab').click();
    await page.locator('.viewport-toolbar strong').click();
    await capture('web-flanged-dark.png');
    const palette = page.getByRole('region',{name:'基本体选项',exact:true});
    const openPalette = () => page.getByRole('button',{name:'展开基本体选项',exact:true}).click();
    await openPalette();
    assert.equal(await palette.locator('.palette-item').count(),11);
    const {PRIMITIVES} = await import('../src/primitive_catalog.mjs');
    assert.deepEqual(await palette.locator('.palette-item span').allTextContents(),PRIMITIVES.map(item=>item.name));
    for (const button of await palette.locator('.palette-item').all()) assert.equal(await button.getAttribute('aria-disabled'),'true');
    await page.keyboard.press('End'); assert.equal(await page.locator(':focus').getAttribute('aria-label'),'创建圆环');
    await page.keyboard.press('Home'); assert.equal(await page.locator(':focus').getAttribute('aria-label'),'创建长方体');
    await capture('web-primitive-palette-dark.png');
    await palette.getByRole('button',{name:'创建圆角方盒',exact:true}).evaluate(el=>el.click());
    assert.equal(await page.locator('.node-card').count(),19);
    assert.equal(await page.locator('#viewport').getAttribute('data-sha256'),metadata.sha256);
    assert.match(await page.locator('#status').innerText(),/界面展示选项/);
    await page.keyboard.press('Escape'); assert.ok(await palette.isHidden());
    assert.equal(await page.locator(':focus').getAttribute('aria-label'),'展开基本体选项');
    await openPalette(); await page.locator('.viewport-toolbar strong').click(); assert.ok(await palette.isHidden());
    await openPalette(); await page.getByRole('tab',{name:'TPMS 节点',exact:true}).click(); assert.ok(await palette.isHidden());
    await page.getByRole('tab',{name:'建模',exact:true}).click();
    await page.getByRole('button',{name:'切换亮色主题',exact:true}).click(); assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    await openPalette(); assert.equal(await palette.locator('.palette-item').count(),11); await page.keyboard.press('Escape');
    await page.getByRole('tab',{name:'操作',exact:true}).click();
    await page.getByRole('button',{name:'展开操作选项',exact:true}).click();
    assert.equal(await operations.locator('.palette-item').count(),1);await page.keyboard.press('Escape');
    await page.getByRole('tab',{name:'建模',exact:true}).click();
    await page.getByRole('button',{name:'切换暗色主题',exact:true}).click();
    await page.getByLabel('线框',{exact:true}).check(); await page.getByLabel('线框',{exact:true}).uncheck();
    await page.getByLabel('网格地面',{exact:true}).uncheck(); await page.getByLabel('网格地面',{exact:true}).check();
    for (const axis of ['X','Y','Z']) await page.getByRole('button',{name:`${axis} 轴视角`,exact:true}).click();
    await page.getByRole('button',{name:'放大',exact:true}).click(); await page.getByRole('button',{name:'缩小',exact:true}).click();
    await page.getByRole('button',{name:'自动旋转',exact:true}).click(); assert.equal(await page.locator('#auto-rotate').getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'停止旋转',exact:true}).click();
    const beforeAxes = await page.locator('#orientation-gizmo').evaluate(canvas => canvas.toDataURL());
    await page.getByRole('button',{name:'重置视角',exact:true}).first().click(); await page.waitForTimeout(400);
    assert.notEqual(await page.locator('#orientation-gizmo').evaluate(canvas => canvas.toDataURL()),beforeAxes);
    await page.getByRole('tab',{name:'检查与测量',exact:true}).click();
    await page.getByRole('button',{name:'打开剖切工具',exact:true}).click(); await cutReady();
    assert.match(await page.locator('#section-statistics').innerText(),/mm²/);
    await page.getByLabel('平面方向',{exact:true}).selectOption('custom'); await cutReady();
    await page.getByRole('button',{name:'居中',exact:true}).click(); await cutReady();
    await page.getByRole('button',{name:'正对截面',exact:true}).click();
    await page.getByLabel('仅显示截面',{exact:true}).check(); await cutReady(); await capture('web-flanged-section-dark.png');
    await page.getByLabel('保留法向正侧',{exact:true}).check(); await cutReady();
    await page.getByRole('button',{name:'恢复完整模型并清除测量',exact:true}).click();
    assert.ok(!await page.getByLabel('启用剖切',{exact:true}).isChecked());
    await page.getByRole('button',{name:'Z 轴视角',exact:true}).click();
    await page.getByRole('button',{name:'选择 A / B 点',exact:true}).click();
    const rect = await page.locator('#viewport').boundingBox();
    await page.mouse.click(rect.x+rect.width*0.62,rect.y+rect.height*0.65);
    await page.waitForFunction(() => document.querySelector('#measurement')?.textContent.includes('请选 B 点'));
    await page.mouse.click(rect.x+rect.width*0.38,rect.y+rect.height*0.65);
    await page.waitForFunction(() => document.querySelector('#measurement')?.textContent.includes('直线距离'));
    assert.match(await page.locator('#measurement').innerText(),/A 点.*B 点/s);
    await page.getByRole('button',{name:'恢复完整模型并清除测量',exact:true}).click();
    await page.getByRole('button',{name:'重置视角',exact:true}).first().click();
    await page.locator('#export-menu>summary').click();
    const downloadPromise = page.waitForEvent('download'); await page.locator('#download-stl').click();
    const download = await downloadPromise; assert.equal(download.suggestedFilename(),'gyroid-flanged-core.stl');
    const downloaded = await fs.readFile(await download.path()); assert.deepEqual(downloaded,localSTL);
    await page.locator('#export-menu').evaluate(el => {el.open=false;});
    await page.getByRole('button',{name:'收起工具栏',exact:true}).click(); assert.ok(await page.locator('#ribbon-panel').isHidden());
    await page.getByRole('button',{name:'展开工具栏',exact:true}).click();
    await page.setViewportSize({width:1120,height:760}); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth));
    await page.setViewportSize({width:375,height:812}); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth));
    await page.getByRole('tab',{name:'建模',exact:true}).click(); await openPalette();
    const paletteRect = await palette.boundingBox(); assert.ok(paletteRect.x>=0 && paletteRect.y>=0 && paletteRect.x+paletteRect.width<=375 && paletteRect.y+paletteRect.height<=812);
    await page.getByRole('button',{name:'关闭基本体选项',exact:true}).click();
    await page.getByRole('tab',{name:'操作',exact:true}).click();
    await page.getByRole('button',{name:'展开操作选项',exact:true}).click();
    const operationRect=await operations.boundingBox();
    assert.ok(operationRect.x>=0 && operationRect.y>=0 && operationRect.x+operationRect.width<=375 && operationRect.y+operationRect.height<=812);
    await page.keyboard.press('Escape');
    await page.getByRole('tab',{name:'建模',exact:true}).click();
    await page.getByRole('button',{name:'建模步骤',exact:true}).click(); assert.ok(await page.locator('#node-panel').isVisible());
    await page.getByRole('button',{name:'关闭建模步骤',exact:true}).click();
    await page.getByRole('button',{name:'模型信息',exact:true}).first().click(); assert.ok(await page.locator('#info-panel').isVisible());
    await page.getByRole('button',{name:'关闭模型信息',exact:true}).click(); await capture('web-flanged-mobile-dark.png');
    // A corrupt response produces a useful error and a working retry.
    await page.route('**/gyroid_tpms.stl?*',route => route.fulfill({status:200,body:'invalid'}));
    await page.reload(); await page.waitForFunction(() => document.querySelector('#loading-title')?.textContent === '模型加载失败');
    assert.match(await page.locator('#loading-detail').innerText(),/不一致/);
    await page.unroute('**/gyroid_tpms.stl?*'); await page.getByRole('button',{name:'重新加载',exact:true}).click(); await ready();
    await page.emulateMedia({reducedMotion:'reduce'}); assert.equal(await page.locator('#auto-rotate').getAttribute('aria-pressed'),'false');
    assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
    console.log(JSON.stringify({result:'passed',live,url:base,output,faces:metadata.faces,sha256:metadata.sha256,errors,externalRequests:external,
      checks:['Pages subdirectory and local dependency loading','real 19-node / 3-parameter project','theme / axes / zoom / wireframe / auto-rotation','arbitrary section with holes and surface measurement','STL download bytes unchanged','desktop / compact / mobile panels','corrupt model error and retry','reduced motion']},null,2));
  } catch (error) { await page.screenshot({path:path.join(output,'web-failure-dark.png')}); console.error(output); console.error(await page.locator('#loading-title,#loading-detail,#status,#section-message').allTextContents()); throw error; }
  finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
