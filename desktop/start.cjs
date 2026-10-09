const { spawn } = require('node:child_process');
const electron = require('electron');
const environment = { ...process.env };
// VS Code/Codex terminals can inherit this flag; the desktop app must not run as Node.
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [__dirname], { env: environment, stdio: 'inherit', windowsHide: false });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
