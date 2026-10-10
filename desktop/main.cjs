const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { PythonBridge } = require('./bridge.cjs');

const root = path.resolve(process.env.TPMS_PROJECT_ROOT || path.join(__dirname, '..'));
let window;
const bridge = new PythonBridge(root, message => {
  if (window && !window.isDestroyed()) window.webContents.send('tpms:progress', message);
});
const allowed = new Set(['init', 'generate_tpms', 'generate_solid', 'preview_node', 'evaluate_values', 'preset', 'region', 'quality', 'low_quality']);
let busy = false;
ipcMain.handle('tpms:request', async (_event, method, payload = {}) => {
  if (method === 'cancel') { bridge.cancel(); return {}; }
  if (busy) throw new Error('已有计算任务，请等待完成或点击取消');
  busy = true;
  try {
    if (allowed.has(method)) {
      // Diagnostic files stay in the worker-owned temp directory. Exports require a native dialog.
      const { destination, ...safePayload } = payload;
      return await bridge.call(method, safePayload);
    }
    if (method === 'export' || method === 'cfd') {
      const filters = method === 'cfd' ? [{ name: 'COMSOL 流体网格', extensions: ['msh'] }] : [
        { name: 'STL 三角面模型', extensions: ['stl'] },
        { name: 'OBJ 模型', extensions: ['obj'] }, { name: 'PLY 模型', extensions: ['ply'] },
      ];
      const result = await dialog.showSaveDialog(window, { title: method === 'cfd' ? '导出 COMSOL 流体网格' : '导出模型', defaultPath: method === 'cfd' ? 'tpms-fluid.msh' : 'tpms-model.stl', filters });
      if (result.canceled) return { canceled: true };
      return await bridge.call(method, { ...payload, destination: result.filePath });
    }
    if (method === 'save_project') {
      await bridge.call('validate_project', { project: payload.project });
      const result = await dialog.showSaveDialog(window, { title: '保存建模项目', defaultPath: 'tpms-project.json', filters: [{ name: 'TPMS 项目', extensions: ['json'] }] });
      if (result.canceled) return { canceled: true };
      const temporary = result.filePath + `.tpms-${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(payload.project, null, 2), { encoding: 'utf8', flag: 'wx' });
        await fs.rename(temporary, result.filePath);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      return { path: result.filePath };
    }
    if (method === 'open_project') {
      const result = await dialog.showOpenDialog(window, { title: '打开建模项目', filters: [{ name: 'TPMS / 实体组合项目', extensions: ['json'] }], properties: ['openFile'] });
      if (result.canceled) return { canceled: true };
      const file = result.filePaths[0];
      if ((await fs.stat(file)).size > 2_000_000) throw new Error('项目超过 2 MB');
      const project = JSON.parse(await fs.readFile(file, 'utf8'));
      return await bridge.call('validate_project', { project });
    }
    throw new Error('不支持的操作');
  } finally { busy = false; }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({ width: 1520, height: 980, minWidth: 1100, minHeight: 720,
    title: 'TPMS Studio · 隐式建模工作台', backgroundColor: '#141a21',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(path.join(__dirname, 'dist', 'index.html'));
  window.on('closed', () => { window = null; });
});
app.on('window-all-closed', async () => { await bridge.close(); app.quit(); });
