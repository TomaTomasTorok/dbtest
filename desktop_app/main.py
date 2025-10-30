from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional

try:  # pragma: no cover - import guard for optional GUI dependency
    from PySide6.QtCore import QTimer, Qt
    from PySide6.QtGui import QAction
    from PySide6.QtWidgets import (
        QApplication,
        QFileDialog,
        QGraphicsView,
        QHBoxLayout,
        QLabel,
        QMainWindow,
        QMessageBox,
        QPushButton,
        QSlider,
        QVBoxLayout,
        QWidget,
        QComboBox,
    )
except ModuleNotFoundError as exc:  # pragma: no cover - environment issue
    raise RuntimeError(
        "PySide6 is required for the desktop application. Install it with 'pip install PySide6'."
    ) from exc

from .controller import SimulationController
from .model import SimulationData
from .view import SimulationScene


DEFAULT_DATA = Path("data/machine_events_sample.csv")
SLIDER_MULTIPLIER = 100


def format_clock(minutes: float) -> str:
    total_seconds = max(0, int(minutes * 60))
    hours = total_seconds // 3600
    mins = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    return f"{hours:02}:{mins:02}:{secs:02}"


class SimulationWindow(QMainWindow):
    def __init__(self, data: SimulationData, minutes_per_second: float = 1.0):
        super().__init__()
        self.setWindowTitle("Manufacturing Simulation Player")
        self._timer = QTimer(self)
        self._timer.setInterval(16)
        self._timer.timeout.connect(self._tick)
        self._playing = False
        self._updating_slider = False
        self._speed_multiplier = 1.0
        self.minutes_per_second = minutes_per_second

        self.view = QGraphicsView()
        self.view.setRenderHints(self.view.renderHints() | self.view.RenderHint.Antialiasing)

        self.time_label = QLabel()
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.valueChanged.connect(self._on_slider_change)

        self.play_button = QPushButton("Play")
        self.play_button.clicked.connect(self.toggle_playback)
        self.reset_button = QPushButton("Reset")
        self.reset_button.clicked.connect(self.reset)

        self.speed_combo = QComboBox()
        self.speed_combo.addItems(["0.5x", "1x", "2x", "4x"])
        self.speed_combo.setCurrentIndex(1)
        self.speed_combo.currentTextChanged.connect(self._on_speed_changed)

        controls_layout = QHBoxLayout()
        controls_layout.addWidget(self.play_button)
        controls_layout.addWidget(self.reset_button)
        controls_layout.addWidget(QLabel("Speed"))
        controls_layout.addWidget(self.speed_combo)
        controls_layout.addStretch(1)
        controls_layout.addWidget(self.time_label)

        layout = QVBoxLayout()
        layout.addWidget(self.view)
        layout.addWidget(self.slider)
        layout.addLayout(controls_layout)

        container = QWidget()
        container.setLayout(layout)
        self.setCentralWidget(container)

        self._controller: Optional[SimulationController] = None
        self._scene: Optional[SimulationScene] = None

        self._create_actions()
        self.load_data(data)

    def _create_actions(self) -> None:
        file_menu = self.menuBar().addMenu("&File")
        open_action = QAction("Open CSV...", self)
        open_action.triggered.connect(self._open_csv)
        file_menu.addAction(open_action)
        exit_action = QAction("Exit", self)
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)

    def _open_csv(self) -> None:
        dialog = QFileDialog(self, "Select event CSV")
        dialog.setFileMode(QFileDialog.FileMode.ExistingFile)
        dialog.setNameFilters(["CSV Files (*.csv *.tsv)", "All Files (*)"])
        if dialog.exec():
            selected = dialog.selectedFiles()
            if selected:
                self.load_path(Path(selected[0]))

    def load_path(self, path: Path) -> None:
        try:
            data = SimulationData.from_csv(path)
        except Exception as exc:  # pragma: no cover - user-facing guard
            QMessageBox.critical(self, "Failed to load", str(exc))
            return
        self.load_data(data)
        self.statusBar().showMessage(f"Loaded {path}", 5000)

    def load_data(self, data: SimulationData) -> None:
        self._controller = SimulationController(data)
        self._scene = SimulationScene(data)
        self.view.setScene(self._scene)
        self.slider.setRange(int(data.start_time * SLIDER_MULTIPLIER), int(data.end_time * SLIDER_MULTIPLIER))
        self._sync_state()

    def toggle_playback(self) -> None:
        if not self._playing:
            self._timer.start()
            self._playing = True
            self.play_button.setText("Pause")
        else:
            self._timer.stop()
            self._playing = False
            self.play_button.setText("Play")

    def reset(self) -> None:
        if self._controller is None:
            return
        self._controller.reset()
        self._sync_state()
        if self._playing:
            self.toggle_playback()

    def _on_speed_changed(self, text: str) -> None:
        try:
            self._speed_multiplier = float(text.rstrip("x"))
        except ValueError:
            self._speed_multiplier = 1.0

    def _on_slider_change(self, value: int) -> None:
        if self._controller is None or self._updating_slider:
            return
        target = value / SLIDER_MULTIPLIER
        self._controller.seek(target)
        self._sync_scene()
        self._update_time_label()

    def _tick(self) -> None:
        if self._controller is None:
            return
        delta_minutes = (self._timer.interval() / 1000.0) * self.minutes_per_second * self._speed_multiplier
        previous_time = self._controller.current_time
        self._controller.advance(delta_minutes)
        if self._controller.current_time >= self._controller.data.end_time:
            self._controller.seek(self._controller.data.end_time)
            self.toggle_playback()
        if self._controller.current_time != previous_time:
            self._sync_state()

    def _sync_state(self) -> None:
        if self._controller is None:
            return
        self._sync_scene()
        self._update_time_label()
        self._update_slider()

    def _sync_scene(self) -> None:
        if not self._controller or not self._scene:
            return
        self._scene.sync_states(
            self._controller.machine_states,
            self._controller.active_transports,
            self._controller.current_time,
        )

    def _update_slider(self) -> None:
        if self._controller is None:
            return
        self._updating_slider = True
        value = int(self._controller.current_time * SLIDER_MULTIPLIER)
        self.slider.setValue(value)
        self._updating_slider = False

    def _update_time_label(self) -> None:
        if self._controller is None:
            self.time_label.setText("00:00:00")
            return
        current = self._controller.current_time
        remaining = self._controller.data.end_time - current
        self.time_label.setText(f"{format_clock(current)} / {format_clock(remaining)}")


def run_app(
    path: Optional[Path] = None,
    autoplay: bool = False,
    snapshot: Optional[Path] = None,
    minutes_per_second: float = 1.0,
) -> int:
    app = QApplication(sys.argv)
    data_path = path or DEFAULT_DATA
    data = SimulationData.from_csv(data_path)
    window = SimulationWindow(data, minutes_per_second=minutes_per_second)
    window.resize(1200, 800)
    window.show()

    if autoplay:
        window.toggle_playback()

    if snapshot:
        def _capture() -> None:
            pixmap = window.grab()
            pixmap.save(str(snapshot))
            QApplication.instance().quit()

        QTimer.singleShot(3000, _capture)

    return app.exec()


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Manufacturing simulation desktop player")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="Path to the machine events CSV")
    parser.add_argument("--autoplay", action="store_true", help="Start playback immediately")
    parser.add_argument("--snapshot", type=Path, help="Capture a screenshot to the given path and exit")
    parser.add_argument("--minutes-per-second", type=float, default=1.0, help="Simulation minutes advanced per real second")
    args = parser.parse_args(argv)

    try:
        return run_app(
            args.data,
            autoplay=args.autoplay or bool(args.snapshot),
            snapshot=args.snapshot,
            minutes_per_second=args.minutes_per_second,
        )
    except FileNotFoundError:
        print(f"Data file not found: {args.data}", file=sys.stderr)
        return 1
    except Exception as exc:  # pragma: no cover - startup guard
        print(f"Failed to start application: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
