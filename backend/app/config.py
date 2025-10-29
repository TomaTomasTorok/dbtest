from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os


@dataclass(frozen=True)
class Settings:
    """Application configuration derived from environment variables."""

    product_timeline_path: Path | None
    machine_events_path: Path | None
    preload_metadata: bool = True

    @staticmethod
    def from_env() -> "Settings":
        base_dir = Path(os.getenv("SIM_DATA_DIR", Path.cwd()))
        product_path = os.getenv("PRODUCT_TIMELINE_PATH")
        events_path = os.getenv("MACHINE_EVENTS_PATH")

        product_timeline_path = Path(product_path).expanduser() if product_path else None
        machine_events_path = Path(events_path).expanduser() if events_path else None

        if product_timeline_path and not product_timeline_path.is_absolute():
            product_timeline_path = base_dir / product_timeline_path
        if machine_events_path and not machine_events_path.is_absolute():
            machine_events_path = base_dir / machine_events_path

        preload_metadata = os.getenv("SIM_PRELOAD_METADATA", "true").lower() in {"1", "true", "yes"}

        return Settings(
            product_timeline_path=product_timeline_path,
            machine_events_path=machine_events_path,
            preload_metadata=preload_metadata,
        )


settings = Settings.from_env()
