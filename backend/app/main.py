from __future__ import annotations

from typing import Dict, List

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .dependencies import get_data
from .services.data_loader import DataNotReady, SimulationData


def create_app() -> FastAPI:
    app = FastAPI(title="Simulation Animation Backend")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    async def _startup() -> None:  # pragma: no cover - bootstrapping
        if not settings.preload_metadata:
            return
        try:
            data = SimulationData(
                product_timeline_path=settings.product_timeline_path,
                machine_events_path=settings.machine_events_path,
            )
            data.metadata()
            app.state.simulation_data = data
        except DataNotReady:
            pass

    @app.get("/api/metadata")
    def metadata(data: SimulationData = Depends(get_data)) -> Dict[str, object]:
        return data.metadata()

    @app.get("/api/events")
    def events(
        start: float = Query(..., description="Start time in minutes"),
        end: float = Query(..., description="End time in minutes"),
        data: SimulationData = Depends(get_data),
    ) -> Dict[str, List[Dict[str, object]]]:
        if end <= start:
            raise HTTPException(status_code=400, detail="End time must be greater than start time")
        events_iter = data.iter_events(start, end)
        return {"events": list(events_iter)}

    @app.get("/api/products/{entity_id}")
    def product_timeline(entity_id: int, data: SimulationData = Depends(get_data)) -> Dict[str, object]:
        try:
            timeline = data.product_timeline(entity_id)
        except DataNotReady as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        if not timeline:
            raise HTTPException(status_code=404, detail="Product entity not found")
        return {"entity_id": entity_id, "timeline": timeline}

    return app


app = create_app()
