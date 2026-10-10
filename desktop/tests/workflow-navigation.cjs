const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../..'), output = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-workflow-nav-ui-'));
  const env = { ...process.env, TPMS_PROJECT_ROOT: root, TPMS_PYTHON: 'D:\\anaconda3\\python.exe' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(root, 'desktop'), `--user-data-dir=${path.join(output, 'profile')}`], env, timeout: 60000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const nav = page.getByRole('navigation', { name: '工作流类别' }), pane = page.locator('.node-workspace .panel-scroll');
  async function active(name) { await page.waitForFunction(n => [...document.querySelectorAll('.workflow-tabs button')].find(b => b.textContent === n)?.getAttribute('aria-current') === 'location', name); assert.equal(await nav.locator('[aria-current="location"]').count(), 1); }
  async function waitDone(text) { await page.waitForFunction(t => document.querySelector('.statusbar')?.textContent.includes(t) && !document.querySelector('.generate')?.textContent.includes('正在计算'), text); }
  async function point(group, distance = 0) {
    await pane.evaluate((el, { group, distance }) => {
      const section = el.querySelector(`#notebook-group-${group}`).parentElement, nav = el.querySelector('.workflow-tabs');
      el.scrollTop += section.getBoundingClientRect().top - nav.getBoundingClientRect().bottom + distance - 8;
    }, { group, distance });
  }
  async function click(name) { await nav.getByRole('button', { name, exact: true }).click(); await active(name); }
  async function capture(file) { await page.screenshot({ path: path.join(output, file), scale: 'css', style: '.statusbar [role="status"] { visibility:hidden; }' }); }
  try {
    await waitDone('模型已生成');
    const fixture = path.join(output, 'workflow.json');
    const scene = { version: 1, root: 'n8', cell_size: 0.6, parameters: {}, value_nodes: [
      { id: 'p1', kind: 'number', name: '共享宽度', symbol: 'width', value: 16 },
      { id: 'p2', kind: 'formula', name: '宽度公式', symbol: 'outer', expression: 'width + 2' },
      { id: 'p3', kind: 'number', name: '共享深度', symbol: 'depth', value: 16 },
      { id: 'p4', kind: 'number', name: '共享高度', symbol: 'height', value: 16 }
    ], nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i + 1}`, kind: 'box', name: `长方体 ${i + 1}`, dimensions: [16,16,16], position: [0,0,0], rotation: [0,0,0], inputs: [], blend: 2, tpms: null, expressions: { 'dimensions.0':'width' }, vector_inputs:{} })) };
    await fs.writeFile(fixture, JSON.stringify({ type:'tpms-electron', version:1, mode:'nodes', parameters:{}, scene, cfd:{} }));
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[file] }); }, fixture);
    await page.getByRole('button', { name:'打开', exact:true }).click(); await waitDone('项目已打开');
    await page.getByRole('button', { name:'生成工作流', exact:true }).click(); await waitDone('模型已生成');
    await page.getByRole('button', { name:'收起所有节点',exact:true }).click();
    await click('设计参数'); await page.locator('[data-value-id="p1"] .notebook-node-select').click();
    await click('建模步骤');
    const selected = await page.locator('.notebook-node-select[aria-pressed="true"]').getAttribute('aria-label');
    const metrics = await page.locator('.metrics').allTextContents();
    const box = await pane.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0,-5000); await active('设计参数');
    // Reproduce a long parameter editor with its title above the viewport, as in the reported screenshot.
    await point('values',240); await active('设计参数');
    assert.equal(await page.locator('.notebook-node-select[aria-pressed="true"]').getAttribute('aria-label'),selected);
    await capture('parameters-dark.png');
    await page.getByRole('button',{name:'切换亮色主题',exact:true}).click(); await page.waitForTimeout(200); await capture('parameters-light.png');
    await page.mouse.move(box.x + box.width / 2,box.y + box.height / 2); await page.mouse.wheel(0,5000); await active('输出设置');
    await point('steps',30); await active('建模步骤');
    const navTop = await nav.evaluate(el=>el.getBoundingClientRect().top); await page.mouse.wheel(0,100); await active('建模步骤'); assert.ok(Math.abs(await nav.evaluate(el=>el.getBoundingClientRect().top)-navTop)<1);
    // Drag the actual scrollbar thumb; highlighting must update without any navigation click.
    await pane.evaluate(el=>{el.scrollTop=0;}); await active('设计参数');
    const scrollbar = await pane.evaluate(el=>({ ...el.getBoundingClientRect().toJSON(), thumb:el.clientHeight*el.clientHeight/el.scrollHeight }));
    await page.mouse.move(scrollbar.right-5,scrollbar.top+scrollbar.thumb/2); await page.mouse.down();
    await page.mouse.move(scrollbar.right-5,scrollbar.bottom-2,{steps:15}); await page.mouse.up(); await active('输出设置');
    for (const label of ['设计参数','建模步骤','输出设置','设计参数']) await click(label);
    // Changing disclosure geometry and native details must recalculate the section positions.
    const group = page.locator('#notebook-group-values').locator('xpath=..').locator('.notebook-group-heading button');
    await group.click(); await click('建模步骤'); await click('设计参数');
    await page.getByRole('button',{name:'收起所有节点',exact:true}).click(); await click('建模步骤');
    await page.locator('[data-node-id="n1"] .notebook-node-select').click(); await active('建模步骤');
    await page.locator('[data-node-id="n1"] .editor-transforms>summary').click(); await active('建模步骤');
    await app.evaluate(({ BrowserWindow })=>BrowserWindow.getAllWindows()[0].setSize(1120,760)); await page.emulateMedia({reducedMotion:'reduce'});
    await click('设计参数'); await page.locator('[data-value-id="p1"] .notebook-node-select').click(); await point('values',200); await active('设计参数');
    await capture('compact.png'); await point('steps',50); await active('建模步骤'); await pane.evaluate(el=>{el.scrollTop=el.scrollHeight;}); await active('输出设置');
    assert.equal(await page.locator('.snapshot-note').count(),0); assert.equal(await page.getByRole('button',{name:'撤销节点修改',exact:true}).isDisabled(),true); assert.deepEqual(await page.locator('.metrics').allTextContents(),metrics); assert.deepEqual(errors,[]);
    // A compact, collapsed workflow fits without scrolling; keep the explicit click in that case.
    await fs.writeFile(fixture, JSON.stringify({type:'tpms-electron',version:1,mode:'nodes',parameters:{},cfd:{},scene:{...scene,root:'n1',value_nodes:[],nodes:[{...scene.nodes[0],expressions:{}}]}}));
    await app.evaluate(({BrowserWindow})=>{ const w=BrowserWindow.getAllWindows()[0]; w.setSize(1520,980); w.webContents.setZoomFactor(0.65); });
    await page.getByRole('button',{name:'打开',exact:true}).click(); await waitDone('项目已打开'); await page.getByRole('button',{name:'收起所有节点',exact:true}).click();
    for(const label of ['设计参数','建模步骤']) {
      for(const id of ['values','steps','output']) { const button=page.locator(`#notebook-group-${id}`).locator('xpath=..').locator('.notebook-group-heading button'); if(await button.getAttribute('aria-expanded')==='true')await button.click(); }
      await click(label); assert.ok(await pane.evaluate(el=>el.scrollHeight-el.clientHeight)<=2);
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'passed',output,checks:['wheel and actual scrollbar drag','long parameter editor current-section highlight','sticky navigation','click jump in all directions','bottom output section','group/node/details resize','1120x760 and reduced motion','dark/light screenshots','view-only state preserves selection, model and history','short content retains explicit navigation'],errors},null,2));
  } catch(error) { await page.screenshot({path:path.join(output,'failure.png')}); console.error(output); console.error(await nav.innerText()); throw error; }
  finally { await app.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
