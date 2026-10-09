const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

class PythonBridge {
  constructor(root, onProgress = () => {}) {
    this.root = root;
    this.onProgress = onProgress;
    this.pending = new Map();
    this.serial = 0;
    this.child = null;
    this.transfer = null;
    this.stderr = '';
  }
  async start() {
    if (this.child) return;
    if (!this.transfer) this.transfer = await fs.mkdtemp(path.join(os.tmpdir(), 'tpms-electron-'));
    const python = process.env.TPMS_PYTHON || (process.platform === 'win32' ? 'D:\\anaconda3\\python.exe' : 'python3');
    const child = spawn(python, ['-u', path.join(this.root, 'electron_backend.py'), '--transfer', this.transfer], {
      cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', TPMS_DISABLE_PARALLEL: '1' },
    });
    this.child = child;
    this.stderr = '';
    readline.createInterface({ input: child.stdout }).on('line', line => {
      try {
        const response = JSON.parse(line);
        const pending = this.pending.get(response.id);
        if (!pending) return;
        if (response.progress) { this.onProgress(response.progress); return; }
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(response.error));
        else this.materialize(response.result).then(pending.resolve, pending.reject);
      } catch (error) { this.fail(new Error(`计算进程协议异常：${error.message}`)); }
    });
    child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString('utf8')).slice(-6000); });
    child.stdin.on('error', error => this.fail(new Error(`无法发送计算请求：${error.message}`)));
    child.on('error', error => {
      if (this.child === child) this.child = null;
      this.fail(new Error(`Python 启动失败，请检查 TPMS_PYTHON：${error.message}`));
    });
    child.on('exit', code => {
      if (this.child !== child) return;
      this.child = null;
      this.fail(new Error(`计算进程已退出（${code}），请重新生成模型。${this.stderr}`));
    });
  }
  fail(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
  async materialize(result) {
    if (!result?.geometry) return result;
    const geometry = result.geometry;
    if (!/^[a-f0-9]{32}\.mesh$/.test(geometry.file)) throw new Error('无效的网格传输文件');
    const file = path.join(this.transfer, geometry.file);
    try {
      const bytes = await fs.readFile(file);
      const positionsSize = geometry.vertices * 12;
      const indicesSize = geometry.faces * 12;
      const expected = positionsSize + indicesSize + (geometry.colors ? geometry.vertices * 12 : 0);
      if (bytes.byteLength !== expected) throw new Error('网格数据长度不匹配');
      result.geometry = {
        positions: Uint8Array.from(bytes.subarray(0, positionsSize)),
        indices: Uint8Array.from(bytes.subarray(positionsSize, positionsSize + indicesSize)),
        colors: geometry.colors ? Uint8Array.from(bytes.subarray(positionsSize + indicesSize)) : null,
      };
      return result;
    } finally { await fs.unlink(file).catch(() => {}); }
  }
  async call(method, payload = {}) {
    await this.start();
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, payload }) + '\n', error => {
        if (error) { this.pending.delete(id); reject(error); }
      });
    });
  }
  cancel() {
    const child = this.child;
    this.child = null;
    this.fail(new Error('已取消计算，请重新生成模型'));
    // A worker may use native libraries; terminating the process cancels these too.
    child?.kill();
  }
  async close() {
    this.cancel();
    // Directory is the exact mkdtemp-owned private directory, never a project path.
    if (this.transfer && path.dirname(this.transfer) === os.tmpdir() && path.basename(this.transfer).startsWith('tpms-electron-')) {
      await fs.rm(this.transfer, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    }
    this.transfer = null;
  }
}
module.exports = { PythonBridge };
