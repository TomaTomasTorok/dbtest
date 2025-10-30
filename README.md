# Manufacturing Flow Animation

This project visualizes large-scale manufacturing simulations driven by CSV exports.
It now ships with a native Windows desktop player written with PySide6 alongside
the FastAPI service that powers the original browser prototype.

## Components

- **Desktop simulator** (`desktop_app/`) – PySide6 application that renders machines,
  queues, transports, and playback controls in a Windows-friendly UI.
- **FastAPI backend** (`backend/`, optional) – streams metadata and event slices
directly from CSV inputs for integrations that still target web clients.
- **Sample data tooling** (`scripts/`) – converts raw TSV excerpts into reproducible
  CSV fixtures so the desktop player and backend can run immediately.

## Features

- Grid layout that automatically positions hundreds of machines with color-coded
  queue, processing, and breakdown states.
- Animated transport tokens that travel between machine nodes using start/end
  metadata from the CSV feed.
- Timeline slider, play/pause controls, and adjustable playback speed similar to
  the BP Simulator reference experience.
- CSV loader with file picker so you can switch datasets without restarting.
- Optional headless snapshot mode for automated verification during development.

## Prerequisites

- Windows 10/11 with Python 3.11+ (the app also runs on other desktop platforms
  with Qt support).
- GPU is optional; rendering uses Qt's vector scene graph rather than WebGL.

Create a virtual environment and install dependencies:

```bash
python -m venv .venv
. .venv/Scripts/activate  # PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```



```bash
python scripts/generate_sample_events.py
```

## Run the Windows desktop application

```bash
python -m desktop_app --data data/machine_events_sample.csv --autoplay
```

Key bindings:

- **Play/Pause** – toggle playback.
- **Reset** – jump back to the simulation start.
- **Speed selector** – adjust how quickly simulation minutes advance.
- **Timeline slider** – scrub to any timestamp.

To capture a screenshot without a visible window (useful for CI), combine the
`--snapshot` flag with an offscreen Qt backend:

```bash
set QT_QPA_PLATFORM=offscreen
python -m desktop_app --data data/machine_events_sample.csv --snapshot out.png
```

The command renders three seconds of animation, writes `out.png`, and exits.

## Optional: Run the REST API backend

If you still need the FastAPI endpoints (for example, to compare against the
previous browser UI), start the server after setting the CSV paths:

```bash
export MACHINE_EVENTS_PATH=data/machine_events_sample.csv
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

Available endpoints:

- `GET /api/metadata` – simulation duration and machine layout.
- `GET /api/events?start=0&end=5` – event batch within the requested time range.

## Development tips

- The desktop scene graph lives in `desktop_app/view.py`; tweak colors or
  geometry there.
- Playback and state transitions are coordinated in
  `desktop_app/controller.py`.
- `desktop_app/main.py` wires everything into a Qt window and exposes CLI flags.
- Use the snapshot mode described above to validate layout tweaks without a GUI.
