"""Real Qt worker, three modeling examples and screenshots at two sizes."""
import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PyQt5.QtWidgets import QApplication
from PyQt5.QtGui import QFontDatabase
from app import MainWindow, STYLE
from solid_model import demo_scene

application = QApplication.instance() or QApplication([])
application.setStyle("Fusion")
for font in ("msyh.ttc", "segoeui.ttf"):
    QFontDatabase.addApplicationFont(str(Path("C:/Windows/Fonts") / font))
application.setStyleSheet(STYLE)
window = MainWindow()
window.modeling_mode.setCurrentIndex(1)
window.show()
artifact_dir = Path(__file__).resolve().parents[1] / "test-output"
artifact_dir.mkdir(exist_ok=True)
for kind in ("sphere_hole", "smooth", "tpms_channel"):
    window.solid_panel.scene = demo_scene(kind)
    window.solid_panel.refresh()
    window.generate()
    ticks = 0
    start = time.monotonic()
    while window.worker_thread is not None:
        application.processEvents()
        ticks += 1
        time.sleep(0.01)
        if time.monotonic() - start > 90:
            raise RuntimeError("Solid generation timed out")
    assert window.current_solid_result is not None, window.solid_panel.message.text()
    assert window.current_solid_result.scene.to_dict() == window.solid_panel.scene.to_dict()
    assert window.export_action.isEnabled()
    assert not window.cfd_export_action.isEnabled()
    assert not window.region_action.isEnabled()
    assert not window.viewport.is_gpu_active()
    assert window.current_result.mesh.is_watertight
    assert window.density_value.text() == "—"
    print(f"{kind}: {len(window.current_result.mesh.faces)} faces, event ticks={ticks}")
for width, height in ((1440, 900), (1120, 720)):
    window.resize(width, height)
    application.processEvents()
    window.grab().save(str(artifact_dir / f"solid-ui-{width}.png"))
    window.solid_panel.grab().save(str(artifact_dir / f"solid-panel-{width}.png"))
window.close()
application.processEvents()
