"""Capture the export menu and exercise a real asynchronous export."""
import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PyQt5.QtWidgets import QApplication
from PyQt5.QtGui import QFontDatabase
from app import MainWindow, STYLE
from tpms_core import TPMSParameters, generate_tpms

application = QApplication.instance() or QApplication([])
application.setStyle("Fusion")
for font in ("msyh.ttc", "segoeui.ttf"):
    QFontDatabase.addApplicationFont(str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / font))
application.setStyleSheet(STYLE)
window = MainWindow()
window.resize(1440, 900)
window.current_result = generate_tpms(TPMSParameters(
    size_x=10, size_y=10, size_z=10, cells_x=1, cells_y=1, cells_z=1,
    samples_per_cell=24, thickness=1))
window.export_action.setEnabled(True)
window._update_export_quality_defaults()
window.export_backend_combo.setCurrentIndex(1)
window.show()
application.processEvents()
window.export_menu.popup(window.export_tool_button.mapToGlobal(window.export_tool_button.rect().bottomLeft()))
application.processEvents()
artifact_dir = Path(__file__).resolve().parents[1] / "test-output"
artifact_dir.mkdir(exist_ok=True)
window.export_menu.grab().save(str(artifact_dir / "libfive-export-menu.png"))
assert window.export_menu.width() <= 600
window.export_menu.hide()
destination = artifact_dir / "libfive-worker.stl"
window._start_libfive_export(destination)
assert not window.generate_button.isEnabled()
assert not window.export_action.isEnabled()
ticks = 0
start = time.monotonic()
while window.worker_thread is not None:
    application.processEvents()
    ticks += 1
    if time.monotonic() - start > 90:
        raise RuntimeError("Export timed out")
    time.sleep(0.01)
assert destination.is_file()
assert window.generate_button.isEnabled()
assert window.export_action.isEnabled()
assert "libfive" in window.statusBar().currentMessage()
print(f"Actual Qt export finished; event-loop ticks={ticks}; {window.statusBar().currentMessage()}")
window.close()
application.processEvents()
