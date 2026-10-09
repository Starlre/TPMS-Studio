"""Launch the Electron UI with this Python interpreter as its local backend."""
from pathlib import Path
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile


def locate_desktop(root: Path) -> Path:
    desktop = root / 'desktop'
    if (desktop / 'package.json').is_file():
        return desktop
    archive = root / 'electron-desktop.zip'
    if not archive.is_file():
        raise SystemExit('找不到 desktop/package.json 或 electron-desktop.zip，请检查项目文件。')
    # Storage-limited portable layout: only the UI/dependencies live in the C cache.
    fingerprint = hashlib.sha256(archive.read_bytes()).hexdigest()[:16]
    cache = Path(os.environ.get('LOCALAPPDATA', tempfile.gettempdir())) / 'TPMSStudio' / 'electron' / fingerprint
    desktop = cache / 'desktop'
    if not (desktop / 'package.json').is_file():
        cache.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                destination = (cache / member.filename).resolve()
                if not destination.is_relative_to(cache.resolve()):
                    raise SystemExit('界面压缩包包含非法路径。')
            bundle.extractall(cache)
    return desktop


def main():
    root = Path(__file__).resolve().parent
    desktop = locate_desktop(root)
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not npm:
        raise SystemExit('请先安装 Node.js 22.12+（含 npm），然后重新启动。')
    if not (desktop / 'node_modules' / 'electron' / 'dist' / ('electron.exe' if os.name == 'nt' else 'electron')).exists():
        print('首次启动：安装 Electron 与界面依赖…', flush=True)
        try:
            subprocess.run([npm, 'ci', '--no-audit', '--no-fund'], cwd=desktop, check=True)
        except subprocess.CalledProcessError:
            if os.environ.get('ELECTRON_MIRROR'):
                raise
            print('默认 Electron 下载失败，尝试 npm 镜像（仅用于此次安装）…', flush=True)
            subprocess.run([npm, 'ci', '--no-audit', '--no-fund'], cwd=desktop, check=True,
                           env={**os.environ, 'ELECTRON_MIRROR': 'https://npmmirror.com/mirrors/electron/'})
    source_files = list((desktop / 'src').glob('*')) + [desktop / 'index.html', desktop / 'package.json']
    built = desktop / 'dist' / 'index.html'
    if not built.exists() or any(file.stat().st_mtime > built.stat().st_mtime for file in source_files):
        subprocess.run([npm, 'run', 'build'], cwd=desktop, check=True)
    environment = {**os.environ, 'TPMS_PYTHON': sys.executable, 'TPMS_PROJECT_ROOT': str(root)}
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    return subprocess.call([npm, 'start'], cwd=desktop, env=environment)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f'Electron 安装或构建失败（{exc.returncode}），请查看上方错误。')
