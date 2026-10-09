const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tpms', {
  request: (method, payload) => ipcRenderer.invoke('tpms:request', method, payload),
  onProgress: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('tpms:progress', listener);
    return () => ipcRenderer.removeListener('tpms:progress', listener);
  },
});
