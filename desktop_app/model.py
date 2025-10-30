from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
import csv


@dataclass
class MachineEvent:
    time_min: float
    time_ts: str
    machine: str
    event: str
    product_id: str
    entity_id: str
    from_machine: Optional[str] = None
    to_machine: Optional[str] = None
    queue_length: Optional[int] = None


@dataclass
class Transport:
    product_id: str
    entity_id: str
    from_machine: Optional[str]
    to_machine: Optional[str]
    start_time: float
    end_time: Optional[float] = None

    def progress(self, clock: float) -> float:
        if self.end_time is None:
            return 0.0
        duration = self.end_time - self.start_time
        if duration <= 0:
            return 1.0
        return max(0.0, min(1.0, (clock - self.start_time) / duration))


@dataclass
class MachineState:
    machine: str
    queue: int = 0
    status: str = "idle"
    last_event: Optional[str] = None
    transports_out: Dict[Tuple[str, str], Transport] = field(default_factory=dict)

    def color_key(self) -> str:
        if self.status == "breakdown":
            return "breakdown"
        if self.status == "processing":
            return "processing"
        if self.queue > 0:
            return "queue"
        return "idle"


class SimulationData:
    """Holds parsed events and derived metadata."""

    def __init__(self, events: Iterable[MachineEvent]):
        self.events: List[MachineEvent] = sorted(events, key=lambda e: e.time_min)
        if not self.events:
            raise ValueError("No events available in the dataset")
        self.start_time = self.events[0].time_min
        self.end_time = self.events[-1].time_min
        self.machines = sorted({event.machine for event in self.events if event.machine})
        self.machine_states: Dict[str, MachineState] = {
            machine: MachineState(machine) for machine in self.machines
        }

    @classmethod
    def from_csv(cls, path: Path) -> "SimulationData":
        events: List[MachineEvent] = []
        with path.open("r", newline="", encoding="utf-8") as handle:
            sample = handle.read(2048)
            handle.seek(0)
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
            except csv.Error:
                dialect = csv.excel
            reader = csv.DictReader(handle, dialect=dialect)
            for row in reader:
                try:
                    time_min = float(row.get("time_min") or row.get("time"))
                except (TypeError, ValueError):
                    continue
                event = MachineEvent(
                    time_min=time_min,
                    time_ts=row.get("time_ts", ""),
                    machine=row.get("machine", ""),
                    event=row.get("event", ""),
                    product_id=row.get("product_id", ""),
                    entity_id=row.get("entity_id", ""),
                    from_machine=row.get("from_machine") or row.get("fromMachine"),
                    to_machine=row.get("to_machine") or row.get("toMachine"),
                    queue_length=_parse_optional_int(row.get("q_len") or row.get("queue_length")),
                )
                events.append(event)
        return cls(events)


def _parse_optional_int(value: Optional[str]) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        return int(float(value))
    except ValueError:
        return None
