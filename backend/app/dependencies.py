from __future__ import annotations

from fastapi import Request

from .config import settings
from .services.data_loader import SimulationData


def get_data(request: Request) -> SimulationData:
    if not hasattr(request.app.state, "simulation_data"):
        request.app.state.simulation_data = SimulationData(
            product_timeline_path=settings.product_timeline_path,
            machine_events_path=settings.machine_events_path,
        )
    return request.app.state.simulation_data
