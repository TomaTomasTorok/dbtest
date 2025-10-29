from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

import polars as pl


DEFAULT_WINDOW_MINUTES = 5.0


class DataNotReady(RuntimeError):
    """Raised when the data source cannot be used."""


@dataclass
class MachineLayout:
    machine: str
    x: float
    y: float
    row: int
    col: int


class SimulationData:
    """Loads and serves simulation data straight from CSV files."""

    def __init__(
        self,
        product_timeline_path: Optional[Path],
        machine_events_path: Optional[Path],
        *,
        window_minutes: float = DEFAULT_WINDOW_MINUTES,
    ) -> None:
        if machine_events_path is None:
            raise DataNotReady("MACHINE_EVENTS_PATH is not configured")
        if not machine_events_path.exists():
            raise DataNotReady(f"Machine events file not found: {machine_events_path}")
        if product_timeline_path is not None and not product_timeline_path.exists():
            raise DataNotReady(f"Product timeline file not found: {product_timeline_path}")

        self._product_timeline_path = product_timeline_path
        self._machine_events_path = machine_events_path
        self._window_minutes = window_minutes

        self._metadata_cache: Optional[Dict[str, Any]] = None
        self._machine_index: Dict[str, MachineLayout] = {}

    # ------------------------------------------------------------------
    # Internal helpers
    def _scan_events(self) -> pl.LazyFrame:
        return pl.scan_csv(
            self._machine_events_path,
            has_header=True,
            try_parse_dates=True,
            ignore_errors=True,
        )

    def _machine_layout(self, machines: List[str]) -> List[MachineLayout]:
        if self._machine_index and len(self._machine_index) == len(machines):
            return list(self._machine_index.values())

        machines_sorted = sorted(machines)
        count = len(machines_sorted)
        grid_cols = max(1, int(count ** 0.5))

        padding_x = 180
        padding_y = 140
        margin_x = 100
        margin_y = 100

        layouts: List[MachineLayout] = []
        for idx, machine in enumerate(machines_sorted):
            row = idx // grid_cols
            col = idx % grid_cols
            x = margin_x + col * padding_x
            y = margin_y + row * padding_y
            layout = MachineLayout(machine=machine, x=x, y=y, row=row, col=col)
            layouts.append(layout)
            self._machine_index[machine] = layout
        return layouts

    # ------------------------------------------------------------------
    # Public API
    def metadata(self) -> Dict[str, Any]:
        if self._metadata_cache is not None:
            return self._metadata_cache

        events = self._scan_events()
        time_stats = events.select(
            [
                pl.min("time_min").alias("start"),
                pl.max("time_min").alias("end"),
            ]
        ).collect()

        start = time_stats[0, "start"] if time_stats.height else 0.0
        end = time_stats[0, "end"] if time_stats.height else 0.0

        machines_df = events.select(pl.col("machine")).unique().collect()
        machines = [row[0] for row in machines_df.iter_rows()]

        layouts = self._machine_layout(machines)

        edges_df = (
            events
            .filter(pl.col("event") == "TRANSPORT_START")
            .select(["machine", "to_machine"])
            .drop_nulls()
            .unique()
            .collect()
        )
        edges = [
            {"from": row[0], "to": row[1]}
            for row in edges_df.iter_rows()
        ]

        metadata: Dict[str, Any] = {
            "time": {"start": float(start), "end": float(end)},
            "machines": [
                {
                    "machine": layout.machine,
                    "x": layout.x,
                    "y": layout.y,
                    "row": layout.row,
                    "col": layout.col,
                }
                for layout in layouts
            ],
            "edges": edges,
            "window_minutes": self._window_minutes,
        }
        self._metadata_cache = metadata
        return metadata

    def iter_events(self, start: float, end: float) -> Iterator[Dict[str, Any]]:
        if end <= start:
            return iter(())

        def _generator() -> Iterator[Dict[str, Any]]:
            lazy = (
                self._scan_events()
                .filter(pl.col("time_min") >= start)
                .filter(pl.col("time_min") < end)
                .sort("time_min")
            )
            df = lazy.collect(streaming=True)
            for row in df.iter_rows(named=True):
                yield row

        return _generator()

    def product_timeline(self, entity_id: int) -> List[Dict[str, Any]]:
        if self._product_timeline_path is None:
            raise DataNotReady("Product timeline data is not configured")

        df = (
            pl.scan_csv(self._product_timeline_path, has_header=True, try_parse_dates=True, ignore_errors=True)
            .filter(pl.col("entity_id") == entity_id)
            .sort("start_min")
            .collect(streaming=True)
        )
        return [row for row in df.iter_rows(named=True)]

    def time_window(self, current: float) -> Dict[str, float]:
        half = self._window_minutes / 2.0
        return {"start": max(0.0, current - half), "end": current + half}
