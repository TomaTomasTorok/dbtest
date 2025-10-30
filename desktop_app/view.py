from __future__ import annotations

from math import ceil, sqrt
from typing import Dict, Iterable, Tuple

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QBrush, QPen
from PySide6.QtWidgets import (
    QGraphicsEllipseItem,
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsSimpleTextItem,
)

from .model import MachineState, SimulationData, Transport


COLORS = {
    "idle": QColor("#264653"),
    "queue": QColor("#f4a261"),
    "processing": QColor("#2a9d8f"),
    "breakdown": QColor("#e76f51"),
}

MACHINE_SIZE = QRectF(0, 0, 160, 80)
TOKEN_RADIUS = 12


class MachineGraphicsItem(QGraphicsRectItem):
    def __init__(self, machine: str, position: QPointF):
        super().__init__(MACHINE_SIZE)
        self.setPos(position)
        self.setPen(QPen(Qt.GlobalColor.black, 1))
        self.status_brushes: Dict[str, QBrush] = {
            key: QBrush(color) for key, color in COLORS.items()
        }
        self.label = QGraphicsSimpleTextItem(machine, self)
        self.label.setPos(8, 8)
        self.queue_text = QGraphicsSimpleTextItem("Queue: 0", self)
        self.queue_text.setPos(8, 50)
        self.state_indicator = QGraphicsRectItem(0, 0, MACHINE_SIZE.width(), 6, self)
        self.state_indicator.setPos(0, MACHINE_SIZE.height() - 6)
        self.update_state(MachineState(machine))

    def update_state(self, state: MachineState) -> None:
        brush = self.status_brushes.get(state.color_key(), QBrush(COLORS["idle"]))
        self.setBrush(brush)
        self.queue_text.setText(f"Queue: {state.queue}")
        indicator_color = COLORS.get(state.color_key(), COLORS["idle"])
        self.state_indicator.setBrush(QBrush(indicator_color))


class TransportItem(QGraphicsEllipseItem):
    def __init__(self, radius: float = TOKEN_RADIUS):
        super().__init__(-radius, -radius, radius * 2, radius * 2)
        self.setBrush(QBrush(QColor("#4cc9f0")))
        self.setPen(QPen(Qt.GlobalColor.black, 1))
        self.path: Tuple[QPointF, QPointF] | None = None

    def update_progress(self, transport: Transport, positions: Dict[str, QPointF], clock: float) -> None:
        start = positions.get(transport.from_machine)
        end = positions.get(transport.to_machine)
        if start is None and transport.from_machine:
            start = positions.get(transport.from_machine, QPointF())
        if end is None:
            end = positions.get(transport.to_machine or transport.from_machine, QPointF())
        if start is None:
            start = QPointF()
        if end is None:
            end = start
        progress = transport.progress(clock)
        pos = QPointF(
            start.x() + (end.x() - start.x()) * progress,
            start.y() + (end.y() - start.y()) * progress,
        )
        pos += QPointF(MACHINE_SIZE.width() / 2, MACHINE_SIZE.height() / 2)
        self.setPos(pos)


class SimulationScene(QGraphicsScene):
    def __init__(self, data: SimulationData):
        super().__init__()
        self._machine_items: Dict[str, MachineGraphicsItem] = {}
        self._transport_items: Dict[Tuple[str, str], TransportItem] = {}
        self.machine_positions: Dict[str, QPointF] = self._build_layout(data.machines)
        for machine, position in self.machine_positions.items():
            item = MachineGraphicsItem(machine, position)
            self._machine_items[machine] = item
            self.addItem(item)
        self.setSceneRect(self.itemsBoundingRect().adjusted(-50, -50, 50, 50))

    def sync_states(
        self,
        states: Dict[str, MachineState],
        transports: Dict[Tuple[str, str], Transport],
        clock: float,
    ) -> None:
        for machine, state in states.items():
            if machine in self._machine_items:
                self._machine_items[machine].update_state(state)
        existing_keys = set(self._transport_items.keys())
        active_keys: set[Tuple[str, str]] = set()
        for key, transport in transports.items():
            active_keys.add(key)
            token = self._transport_items.get(key)
            if token is None:
                token = TransportItem()
                self._transport_items[key] = token
                self.addItem(token)
            token.update_progress(transport, self.machine_positions, clock)
        for key in existing_keys - active_keys:
            token = self._transport_items.pop(key, None)
            if token:
                self.removeItem(token)

    @staticmethod
    def _build_layout(machines: Iterable[str]) -> Dict[str, QPointF]:
        machines = list(machines)
        if not machines:
            return {}
        columns = max(1, int(ceil(sqrt(len(machines)))))
        positions: Dict[str, QPointF] = {}
        spacing_x = MACHINE_SIZE.width() + 80
        spacing_y = MACHINE_SIZE.height() + 80
        for index, machine in enumerate(sorted(machines)):
            row = index // columns
            column = index % columns
            positions[machine] = QPointF(column * spacing_x, row * spacing_y)
        return positions
