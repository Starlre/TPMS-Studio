"""Package the versioned Electron source and renderer; exclude node_modules."""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
desktop = root / 'desktop'
destination = root / 'electron-desktop.zip'
if not (desktop / 'dist' / 'index.html').is_file():
    raise SystemExit('Run npm run build in desktop first.')
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(desktop.rglob('*')):
        if file.is_file() and 'node_modules' not in file.parts:
            archive.write(file, file.relative_to(root).as_posix())
    archive.write(Path(__file__), 'scripts/package_electron.py')
print(destination)
