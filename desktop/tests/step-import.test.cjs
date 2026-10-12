const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {PythonBridge} = require('../bridge.cjs');
const root=path.resolve(__dirname,'../..');

test('STEP IPC handles Unicode filenames, native errors and isolated export snapshots', {timeout:60000}, async t=>{
  const bridge=new PythonBridge(root);t.after(()=>bridge.close());
  const info=await bridge.call('init');
  if(!info.step) {t.skip('optional OpenCascade unavailable');return;}
  const source=path.join(bridge.transfer,'开孔.stp');
  execFileSync(process.env.TPMS_PYTHON || 'D:\\anaconda3\\python.exe',[path.join(root,'test_cad_import.py'),source],{cwd:root,env:{...process.env,PYTHONUTF8:'1'}});
  const imported=await bridge.call('import_step',{cad:{source}});
  assert.equal(imported.mode,'cad');assert.equal(imported.stats.watertight,true);
  assert.equal(imported.geometry.positions.byteLength,imported.stats.vertices*12);
  assert.equal(imported.cad_metadata.solids,1);assert.equal(imported.cad.sha256.length,64);
  const stl=path.join(bridge.transfer,'cad.stl');
  await bridge.call('export',{destination:stl});
  const before=await fs.readFile(stl);
  const invalid=path.join(bridge.transfer,'invalid.step');await fs.writeFile(invalid,'invalid');
  await assert.rejects(bridge.call('import_step',{cad:{source:invalid}}),/读取|显示/);
  await bridge.call('export',{destination:stl});
  assert.deepEqual(await fs.readFile(stl),before);
  await assert.rejects(bridge.call('region'),/CFD/);
  const moved=await bridge.call('import_step',{cad:{...imported.cad,position:[10,0,0]}});
  assert.equal(moved.stats.bounds[0][0],-5);
  assert.equal(moved.stats.bounds[1][0],25);
});
