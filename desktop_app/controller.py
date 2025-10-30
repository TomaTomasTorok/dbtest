from __future__ import annotations

from dataclasses import replace
from typing import Dict, Iterator, List, Tuple

from .model import MachineEvent, MachineState, SimulationData, Transport

TransportKey = Tuple[str, str]


class SimulationController:
    """Playback controller that advances machine states over time."""

    def __init__(self, data: SimulationData):
        self.data = data
        self.reset()

    def reset(self) -> None:
        self.current_time = self.data.start_time
        self.pointer = 0
        self.machine_states: Dict[str, MachineState] = {
            name: MachineState(name) for name in self.data.machines
        }
        self.transports: Dict[TransportKey, Transport] = {}
        self._active_transports: Dict[TransportKey, Transport] = {}

    def seek(self, target_time: float) -> None:
        if target_time < self.current_time:
            self.reset()
        self.advance_to(target_time)

    def advance(self, delta_minutes: float) -> None:
        self.advance_to(self.current_time + delta_minutes)

    def advance_to(self, target_time: float) -> None:
        target_time = min(max(target_time, self.data.start_time), self.data.end_time)
        while self.pointer < len(self.data.events) and self.data.events[self.pointer].time_min <= target_time:
            event = self.data.events[self.pointer]
            self._apply_event(event)
            self.pointer += 1
        self.current_time = target_time
        self._refresh_active_transports()

    def _apply_event(self, event: MachineEvent) -> None:
        state = self.machine_states.get(event.machine)
        if state is None:
            state = MachineState(event.machine)
            self.machine_states[event.machine] = state
        state.last_event = event.event
        if event.queue_length is not None:
            state.queue = max(0, event.queue_length)
        if event.event == "QUEUE_IN":
            state.queue = max(0, state.queue + 1)
        elif event.event == "QUEUE_OUT":
            state.queue = max(0, state.queue - 1)
        elif event.event == "PROC_START":
            state.status = "processing"
        elif event.event in {"PROC_END", "PROC_COMPLETE"}:
            state.status = "idle"
        elif event.event == "BREAKDOWN_START":
            state.status = "breakdown"
        elif event.event in {"BREAKDOWN_END", "BREAKDOWN_CLEAR"}:
            state.status = "idle"
        elif event.event.startswith("TRANSPORT_"):
            self._handle_transport(event)

    def _handle_transport(self, event: MachineEvent) -> None:
        key = (event.product_id or event.entity_id, event.entity_id or event.product_id)
        transport = self.transports.get(key)
        if event.event == "TRANSPORT_START":
            transport = Transport(
                product_id=event.product_id,
                entity_id=event.entity_id,
                from_machine=event.from_machine or event.machine,
                to_machine=event.to_machine,
                start_time=event.time_min,
            )
            self.transports[key] = transport
        elif event.event == "TRANSPORT_END" and transport:
            if not transport.to_machine:
                transport.to_machine = event.machine or event.to_machine
            transport.end_time = event.time_min
        elif event.event == "TRANSPORT_CANCEL" and transport:
            self.transports.pop(key, None)

    def _refresh_active_transports(self) -> None:
        self._active_transports.clear()
        to_remove: List[TransportKey] = []
        for key, transport in self.transports.items():
            if transport.end_time is not None and self.current_time > transport.end_time + 0.1:
                to_remove.append(key)
            else:
                clone = replace(transport)
                if clone.to_machine is None:
                    clone.to_machine = transport.to_machine or transport.from_machine
                self._active_transports[key] = clone
        for key in to_remove:
            self.transports.pop(key, None)

    @property
    def active_transports(self) -> Dict[TransportKey, Transport]:
        return self._active_transports

    def iter_states(self) -> Iterator[MachineState]:
        return iter(self.machine_states.values())
