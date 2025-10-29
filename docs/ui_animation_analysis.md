# Simulation UI Analysis and Windows Application Proposal

## 1. Reference Experience Breakdown
The reference UI at [bpsimulator.com/run](https://www.bpsimulator.com/run/) focuses on visualizing a factory flow simulation in real time. Its core traits closely mirror the existing web client in this repository (`frontend/app.js`). Key widgets include:

- **Timeline header** – Playback buttons, current simulation clock, speed selector, and slider that scrubs between the scenario start and end minutes. 【F:frontend/app.js†L213-L276】
- **Central canvas** – A 2D scene with fixed machine nodes, buffer indicators, animated product tokens, and thin routing links. Machines expose their current state (Idle, Waiting, Processing) and queue length via overlaid labels. 【F:frontend/app.js†L55-L166】【F:frontend/app.js†L360-L448】
- **Detail panel** – Clicking a machine surfaces the latest event data and breakdown status. 【F:frontend/app.js†L176-L214】
- **KPI summary strip** – Aggregated counters for work-in-progress, finished units, and active breakdowns update during playback. 【F:frontend/app.js†L277-L306】

This layout enables operators to correlate timeline actions with spatial movement of products, aligning with the capabilities showcased on the reference site.

## 2. CSV Event Schema Interpretation
The provided CSV snapshot already matches the event contract consumed by the current frontend and backend:

| Column | Meaning | Usage in UI |
| --- | --- | --- |
| `time_min` / `time_ts` | Absolute simulation minute / timestamp | Drives playback timeline and animation clock. 【F:frontend/app.js†L275-L359】 |
| `machine` | Machine identifier | Node lookup in the scene and KPI attribution. 【F:frontend/app.js†L360-L448】 |
| `event` | Lifecycle marker (`QUEUE_IN`, `PROC_START`, `TRANSPORT_START`, `BREAKDOWN_START`, …) | Triggers state, color, and motion updates. 【F:frontend/app.js†L400-L448】 |
| `product_id`, `entity_id` | Trackable lot identifiers | Bind animated tokens to their history. 【F:frontend/app.js†L116-L173】【F:frontend/app.js†L360-L415】 |
| `from_machine`, `to_machine` | Transport edges | Determine animation trajectories. 【F:frontend/app.js†L402-L435】 |
| `q_len` | Queue length snapshot | Updates buffer labels. 【F:frontend/app.js†L374-L382】 |
| `wait_min`, `proc_min` | Optional durations | Can enrich tooltips or KPIs in the desktop client. |

No extra preprocessing is required besides parsing timestamps and guaranteeing numeric coercion for `time_min`, `q_len`, and durations.

## 3. Target Windows Application Stack
To deliver a Windows desktop equivalent, a Python stack with GPU-accelerated canvas support is appropriate:

- **UI Toolkit**: `PySide6` (Qt for Python) offers a mature scene graph (`QGraphicsScene`) for machine layout and animations, native widgets for controls, and MSIX packaging support.
- **Rendering**: Use `QGraphicsView` to host machine nodes (`QGraphicsRectItem`), queue buffers (`QGraphicsEllipseItem`), and animated products (`QGraphicsEllipseItem` with `QPropertyAnimation`). Alternatively, integrate `PyQtGraph` for higher performance if needed.
- **Data Layer**: `pandas` to ingest CSV, create chronological event queues, and pivot machine metadata (unique machines, edges). `pytz` / `python-dateutil` for timestamp parsing.
- **Simulation Engine**: Reuse the logic embodied by `SimulationController` and `EventStream` in the web code—maintain a timeline pointer, speed multiplier, and event dispatch table.

## 4. UI Layout Proposal
```
┌─────────────────────────────────────────────────────────────────┐
│ Playback Toolbar                                                │
│ [◀◀] [▶/❚❚] [▶▶]  Clock  Slider  Speed Combo  Window Minutes   │
├─────────────────────────────────────────────────────────────────┤
│ ┌───────────── Main Canvas (QGraphicsView) ───────────────────┐ │
│ │ Machines arranged per metadata, linked with faint lines.    │ │
│ │ Each machine shows: name, status label, queue bubble.        │ │
│ │ Product tokens animate between nodes on transport events.    │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ ┌────── Machine Details ──────┐ ┌───── KPI Cards ─────────────┐ │
│ │ Selected machine metadata…  │ │ WIP | Completed | Breakdown │ │
│ └──────────────────────────────┘ └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

Additional components:
- **Event Log (optional)**: Dockable panel listing recent events with filtering by machine or product.
- **Search box**: Focus a machine by identifier.
- **Legend**: Color coding for queue/processing/transport/breakdown states.

## 5. Animation & State Management
1. **Event ingestion**: Sort events by `time_min`. Group by `machine` to pre-compute adjacency (first `TRANSPORT_START` + `to_machine`).
2. **Timeline control**: Maintain `current_time`, `is_playing`, `speed_multiplier`, mirroring the web controller logic. 【F:frontend/app.js†L306-L359】
3. **Dispatch table**: Map each event name to a handler that mutates machine state, queue length, and product token animation, following the switch statement in `SimulationController.processEvent`. 【F:frontend/app.js†L383-L448】
4. **Animations**: For transports, instantiate `QPropertyAnimation` on the product item’s position from source to destination between `startTime` and `endTime`. For queue/processing states, update color/label instantly.
5. **KPI refresh**: Recompute WIP (visible tokens), completed count, and breakdown set whenever relevant events fire.
6. **Seeking**: When the slider jumps backward, reset all state and replay events up to the target time (fast-forward execution without animations, identical to the JavaScript implementation). 【F:frontend/app.js†L321-L359】

## 6. Data & Metadata Requirements
The desktop client needs a lightweight metadata layer similar to `/api/metadata` in the web app:

- **Machines**: Array containing `machine`, `x`, `y` coordinates, optionally `group` or `lane` for layout ordering.
- **Edges**: Derived from `TRANSPORT_START` and `TRANSPORT_END` pairs to draw connectors.
- **Time bounds**: Minimum/maximum `time_min` for slider range.

When metadata is absent in the CSV, auto-generate a grid layout (cluster machines alphabetically in columns) and compute edges by observing `from_machine`/`to_machine` combinations.

## 7. Implementation Roadmap
1. **CSV Parser** – Build a `SimulationDataset` class that loads the CSV, normalizes types, and exposes `events`, `machines`, `products`, and `time_range`.
2. **Metadata Builder** – Determine machine coordinates either from an auxiliary JSON layout (optional) or heuristically (force-directed or grid placement).
3. **Qt Application Skeleton** – Create the main window with toolbar, graphics view, details pane, and KPI cards.
4. **Scene Graph** – Implement `MachineItem`, `QueueBubbleItem`, `ProductItem` classes analogous to `MachineView`/`ProductView`. 【F:frontend/app.js†L55-L173】
5. **Controller** – Translate `SimulationController` logic to Python with timers (`QTimer`) for playback and event dispatch.
6. **Animation Engine** – Use Qt animations for transport, ensuring minimum duration of 0.05 min (3 seconds at real scale) like the web client. 【F:frontend/app.js†L120-L152】
7. **State Reset & Seeking** – Provide a method to rewind the scene by clearing queues and reapplying events up to the selected time.
8. **Packaging** – Bundle dependencies via `PyInstaller` or `fbs` for a Windows-friendly installer. Provide configuration to point at arbitrary CSVs via file dialog.

## 8. Enhancements & Future Work
- Export snapshots or MP4 of the simulation run.
- Integrate filters for product family (`partName`, `technology`, `recipe`).
- Surface utilization charts using `matplotlib` embedded widgets.
- Persist user-defined machine layouts in JSON alongside the CSV for reuse.

This plan mirrors the capabilities of the original browser experience while adapting the workflow to a native Windows Python application powered by the same event semantics.
