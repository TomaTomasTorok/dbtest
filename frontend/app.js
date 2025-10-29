const ORIGIN = window.location.origin;
const DEFAULT_API = ORIGIN.startsWith("file") ? "http://localhost:8000" : ORIGIN;
const API_BASE = window.API_BASE_URL || DEFAULT_API;

const COLORS = {
  queue: 0xffd166,
  processing: 0x06d6a0,
  transport: 0x4cc9f0,
  breakdown: 0xef476f,
};

const MACHINE_SIZE = { width: 120, height: 60 };
const BUFFER_OFFSET = { x: 0, y: -50 };

function formatClock(minutes) {
  const totalSeconds = Math.max(0, Math.floor(minutes * 60));
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0");
  const mins = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const secs = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${hours}:${mins}:${secs}`;
}

async function fetchJson(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  });
  const response = await fetch(url.toString());
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Request failed (${response.status}): ${detail}`);
  }
  return await response.json();
}

class EventStream {
  constructor(metadata) {
    this.start = metadata.time.start;
    this.end = metadata.time.end;
    this.windowSize = metadata.window_minutes || 5;
    this.buffer = [];
    this.fetching = null;
    this.nextFetchStart = this.start;
    this.finished = false;
  }

  async reset(windowMinutes) {
    this.windowSize = windowMinutes ?? this.windowSize;
    this.buffer = [];
    this.fetching = null;
    this.nextFetchStart = this.start;
    this.finished = false;
  }

  async fetchNextChunk() {
    if (this.finished) return;
    if (this.fetching) {
      return this.fetching;
    }
    const start = this.nextFetchStart;
    const end = Math.min(this.end, start + this.windowSize);
    this.fetching = fetchJson("/api/events", { start, end })
      .then((payload) => {
        const events = payload.events || [];
        events.sort((a, b) => a.time_min - b.time_min);
        this.buffer.push(...events);
        this.nextFetchStart = end;
        if (end >= this.end) {
          this.finished = true;
        }
      })
      .finally(() => {
        this.fetching = null;
      });
    return this.fetching;
  }

  async ensureUntil(time) {
    while (true) {
      const lastTime = this.buffer.length ? this.buffer[this.buffer.length - 1].time_min : this.nextFetchStart;
      if (this.finished || lastTime >= time || this.nextFetchStart >= time) {
        return;
      }
      await this.fetchNextChunk();
    }
  }

  async takeUntil(time) {
    await this.ensureUntil(time);
    const result = [];
    while (this.buffer.length && this.buffer[0].time_min <= time) {
      result.push(this.buffer.shift());
    }
    return result;
  }
}

class MachineView {
  constructor(machine, layout, parent, onSelect) {
    this.machine = machine;
    this.layout = layout;
    this.container = new PIXI.Container();
    this.container.eventMode = "static";
    this.container.cursor = "pointer";

    this.body = new PIXI.Graphics();
    this.body.beginFill(0x11263b);
    this.body.lineStyle(2, 0x1f4068, 1);
    this.body.drawRoundedRect(-MACHINE_SIZE.width / 2, -MACHINE_SIZE.height / 2, MACHINE_SIZE.width, MACHINE_SIZE.height, 12);
    this.body.endFill();

    this.label = new PIXI.Text(machine, {
      fontSize: 12,
      fill: 0xffffff,
      fontFamily: "Inter, sans-serif",
      align: "center",
      wordWrap: true,
      wordWrapWidth: MACHINE_SIZE.width - 12,
    });
    this.label.anchor.set(0.5);
    this.label.position.set(0, -5);

    this.statusLabel = new PIXI.Text("Idle", {
      fontSize: 11,
      fill: 0x94a1b2,
      fontFamily: "Inter, sans-serif",
    });
    this.statusLabel.anchor.set(0.5);
    this.statusLabel.position.set(0, 18);

    this.bufferContainer = new PIXI.Container();
    this.bufferContainer.position.set(BUFFER_OFFSET.x, BUFFER_OFFSET.y);

    const bufferGraphic = new PIXI.Graphics();
    bufferGraphic.beginFill(0x243b53, 0.9);
    bufferGraphic.lineStyle(1, 0x4cc9f0, 0.8);
    bufferGraphic.drawRoundedRect(-40, -20, 80, 40, 10);
    bufferGraphic.endFill();

    this.bufferLabel = new PIXI.Text("0", {
      fontSize: 14,
      fill: 0x4cc9f0,
      fontWeight: "bold",
    });
    this.bufferLabel.anchor.set(0.5);

    this.bufferContainer.addChild(bufferGraphic, this.bufferLabel);

    this.container.addChild(this.body, this.label, this.statusLabel, this.bufferContainer);
    this.container.position.set(layout.x, layout.y);

    this.container.on("pointertap", () => onSelect(this));

    parent.addChild(this.container);

    this.queueLength = 0;
    this.lastEvent = null;
    this.activeBreakdown = false;
  }

  setQueueLength(value) {
    this.queueLength = value;
    this.bufferLabel.text = String(value ?? 0);
  }

  setStatus(text, color = 0x94a1b2) {
    this.statusLabel.style.fill = color;
    this.statusLabel.text = text;
  }

  setBreakdown(active) {
    this.activeBreakdown = active;
    this.body.tint = active ? COLORS.breakdown : 0xffffff;
  }
}

class ProductView {
  constructor(id, parent) {
    this.id = id;
    this.sprite = new PIXI.Graphics();
    this.sprite.beginFill(COLORS.queue, 0.95);
    this.sprite.drawCircle(0, 0, 6);
    this.sprite.endFill();
    this.sprite.visible = false;
    parent.addChild(this.sprite);

    this.state = "queue";
    this.transport = null;
    this.queueAfterTransport = false;
  }

  setState(state, color) {
    this.state = state;
    this.sprite.tint = color;
  }

  moveTo(x, y) {
    this.sprite.position.set(x, y);
    this.sprite.visible = true;
  }

  beginTransport(fromPos, toPos, startTime) {
    this.transport = {
      fromPos,
      toPos,
      startTime,
      endTime: startTime + 0.05,
    };
    this.queueAfterTransport = false;
    this.setState("transport", COLORS.transport);
    this.moveTo(fromPos.x, fromPos.y);
  }

  finalizeTransport(toPos, endTime) {
    if (!this.transport) {
      this.beginTransport({ x: this.sprite.x, y: this.sprite.y }, toPos, endTime - 0.05);
    }
    this.transport.toPos = toPos;
    this.transport.endTime = Math.max(endTime, this.transport.startTime + 0.05);
    this.queueAfterTransport = true;
  }

  update(currentTime) {
    if (!this.sprite.visible) return;
    if (this.transport) {
      const { fromPos, toPos, startTime, endTime } = this.transport;
      const progress = Math.min(1, Math.max(0, (currentTime - startTime) / Math.max(0.001, endTime - startTime)));
      const ease = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
      const x = fromPos.x + (toPos.x - fromPos.x) * ease;
      const y = fromPos.y + (toPos.y - fromPos.y) * ease;
      this.sprite.position.set(x, y);
      if (progress >= 1) {
        this.transport = null;
        if (this.queueAfterTransport) {
          this.queueAfterTransport = false;
          this.setState("queue", COLORS.queue);
        }
      }
    }
  }

  hide() {
    this.sprite.visible = false;
    this.transport = null;
    this.queueAfterTransport = false;
  }
}

class Scene {
  constructor(metadata) {
    const canvas = document.getElementById("scene");
    this.app = new PIXI.Application({
      view: canvas,
      backgroundAlpha: 0,
      resizeTo: canvas.parentElement,
      antialias: true,
      resolution: window.devicePixelRatio,
    });
    this.metadata = metadata;
    this.machines = new Map();
    this.products = new Map();
    this.machineLayer = new PIXI.Container();
    this.productLayer = new PIXI.Container();
    this.linkLayer = new PIXI.Container();

    this.app.stage.addChild(this.linkLayer, this.machineLayer, this.productLayer);

    this._buildMachines();
    this._buildLinks();
  }

  _buildMachines() {
    const onSelect = (machineView) => {
      const detail = document.getElementById("machineDetails");
      const info = machineView.lastEvent;
      const parts = [
        `<strong>${machineView.machine}</strong>`,
        `Queue: ${machineView.queueLength}`,
      ];
      if (info) {
        parts.push(`Last event: ${info.event} @ ${info.time_min.toFixed(2)} min`);
        if (info.product_id) parts.push(`Product: ${info.product_id}`);
        if (info.entity_id) parts.push(`Entity: ${info.entity_id}`);
      } else {
        parts.push("No events processed yet.");
      }
      if (machineView.activeBreakdown) {
        parts.push(`<span class="alert">BREAKDOWN ACTIVE</span>`);
      }
      detail.innerHTML = parts.join("<br/>");
    };

    for (const machineMeta of this.metadata.machines) {
      const machineView = new MachineView(machineMeta.machine, machineMeta, this.machineLayer, onSelect);
      this.machines.set(machineMeta.machine, machineView);
    }
  }

  _buildLinks() {
    const g = new PIXI.Graphics();
    g.lineStyle(1, 0x1f4068, 0.35);
    for (const edge of this.metadata.edges || []) {
      const from = this.machines.get(edge.from);
      const to = this.machines.get(edge.to);
      if (!from || !to) continue;
      g.moveTo(from.container.x, from.container.y);
      g.lineTo(to.container.x, to.container.y);
    }
    g.alpha = 0.3;
    this.linkLayer.addChild(g);
  }

  getMachinePosition(machine) {
    const view = this.machines.get(machine);
    if (!view) return { x: 0, y: 0 };
    return { x: view.container.x, y: view.container.y };
  }

  getBufferPosition(machine) {
    const view = this.machines.get(machine);
    if (!view) return { x: 0, y: 0 };
    return {
      x: view.container.x + BUFFER_OFFSET.x,
      y: view.container.y + BUFFER_OFFSET.y,
    };
  }

  getOrCreateProduct(entityId) {
    let view = this.products.get(entityId);
    if (!view) {
      view = new ProductView(entityId, this.productLayer);
      this.products.set(entityId, view);
    }
    return view;
  }

  removeProduct(entityId) {
    const view = this.products.get(entityId);
    if (view) {
      view.hide();
    }
  }

  updateProductAnimations(currentTime) {
    for (const view of this.products.values()) {
      view.update(currentTime);
    }
  }

  countActiveProducts() {
    let count = 0;
    for (const view of this.products.values()) {
      if (view.sprite.visible) {
        count += 1;
      }
    }
    return count;
  }
}

class SimulationController {
  constructor(metadata) {
    this.metadata = metadata;
    this.scene = new Scene(metadata);
    this.stream = new EventStream(metadata);
    this.currentTime = metadata.time.start;
    this.isPlaying = false;
    this.speed = 1;
    this.pendingTransports = new Map();

    this.playButton = document.getElementById("playToggle");
    this.slider = document.getElementById("timeSlider");
    this.timeLabel = document.getElementById("timeLabel");
    this.timeCurrent = document.getElementById("timeCurrent");
    this.timeEnd = document.getElementById("timeEnd");
    this.speedSelect = document.getElementById("speedControl");
    this.windowInput = document.getElementById("windowSize");
    this.kpiWip = document.getElementById("kpiWip");
    this.kpiCompleted = document.getElementById("kpiCompleted");
    this.kpiBreakdowns = document.getElementById("kpiBreakdowns");

    this.slider.min = metadata.time.start;
    this.slider.max = metadata.time.end;
    this.slider.step = 0.01;
    this.slider.value = metadata.time.start;
    this.timeEnd.textContent = `${metadata.time.end.toFixed(2)} min`;

    this.completedCount = 0;
    this.breakdownActive = new Set();
    this.kpisDirty = true;

    this.playButton.addEventListener("click", () => this.togglePlay());
    this.speedSelect.addEventListener("change", () => {
      this.speed = parseFloat(this.speedSelect.value);
    });
    this.slider.addEventListener("input", () => {
      this.timeCurrent.textContent = `${parseFloat(this.slider.value).toFixed(2)} min`;
    });
    this.slider.addEventListener("change", () => this.seek(parseFloat(this.slider.value)));
    this.windowInput.addEventListener("change", () => {
      const minutes = Math.max(1, parseFloat(this.windowInput.value));
      this.windowInput.value = String(minutes);
      this.stream.windowSize = minutes;
    });

    this.scene.app.ticker.add((delta) => {
      if (!this.isPlaying) {
        this.scene.updateProductAnimations(this.currentTime);
        if (this.kpisDirty) {
          this.updateKpis();
          this.kpisDirty = false;
        }
        return;
      }
      const deltaMinutes = (delta / 60) * this.speed;
      const targetTime = Math.min(this.metadata.time.end, this.currentTime + deltaMinutes);
      this.advanceTo(targetTime);
    });

    this.updateKpis();
    this.kpisDirty = false;
  }

  updateKpis() {
    this.kpiWip.textContent = String(this.scene.countActiveProducts());
    this.kpiCompleted.textContent = String(this.completedCount);
    this.kpiBreakdowns.textContent = String(this.breakdownActive.size);
  }

  updateClock() {
    this.timeLabel.textContent = formatClock(this.currentTime);
    this.timeCurrent.textContent = `${this.currentTime.toFixed(2)} min`;
    this.slider.value = this.currentTime;
  }

  async advanceTo(targetTime) {
    if (targetTime < this.currentTime) {
      await this.seek(targetTime);
      return;
    }
    const events = await this.stream.takeUntil(targetTime);
    for (const event of events) {
      this.applyEvent(event);
    }
    this.currentTime = targetTime;
    this.scene.updateProductAnimations(this.currentTime);
    if (this.kpisDirty) {
      this.updateKpis();
      this.kpisDirty = false;
    }
    this.updateClock();
    if (this.currentTime >= this.metadata.time.end) {
      this.isPlaying = false;
      this.playButton.textContent = "Play";
    }
  }

  async seek(time) {
    this.isPlaying = false;
    this.playButton.textContent = "Play";
    await this.stream.reset(this.stream.windowSize);
    this.pendingTransports.clear();
    this.completedCount = 0;
    this.breakdownActive.clear();
    this.kpisDirty = true;
    for (const view of this.scene.products.values()) {
      view.hide();
    }
    for (const machine of this.scene.machines.values()) {
      machine.setQueueLength(0);
      machine.setStatus("Idle");
      machine.setBreakdown(false);
      machine.lastEvent = null;
    }
    this.currentTime = this.metadata.time.start;
    this.updateClock();
    if (time <= this.metadata.time.start) {
      if (this.kpisDirty) {
        this.updateKpis();
        this.kpisDirty = false;
      }
      return;
    }
    const chunkSize = this.stream.windowSize;
    let cursor = this.metadata.time.start;
    while (cursor < time) {
      const next = Math.min(time, cursor + chunkSize);
      const events = await this.stream.takeUntil(next);
      for (const event of events) {
        this.applyEvent(event);
      }
      cursor = next;
    }
    this.currentTime = time;
    this.scene.updateProductAnimations(this.currentTime);
    if (this.kpisDirty) {
      this.updateKpis();
      this.kpisDirty = false;
    }
    this.updateClock();
  }

  togglePlay() {
    this.isPlaying = !this.isPlaying;
    this.playButton.textContent = this.isPlaying ? "Pause" : "Play";
  }

  applyEvent(event) {
    const machine = this.scene.machines.get(event.machine);
    if (machine) {
      machine.lastEvent = event;
      if (typeof event.q_len === "number") {
        machine.setQueueLength(event.q_len);
      }
    }

    switch (event.event) {
      case "QUEUE_IN":
        if (machine) {
          machine.setStatus("Waiting", COLORS.queue);
        }
        if (event.entity_id != null) {
          const product = this.scene.getOrCreateProduct(event.entity_id);
          const pos = this.scene.getBufferPosition(event.machine);
          product.setState("queue", COLORS.queue);
          product.moveTo(pos.x, pos.y);
        }
        this.kpisDirty = true;
        break;
      case "QUEUE_OUT":
        if (machine) {
          machine.setStatus("Processing", COLORS.processing);
        }
        if (event.entity_id != null) {
          const product = this.scene.getOrCreateProduct(event.entity_id);
          const pos = this.scene.getMachinePosition(event.machine);
          product.setState("processing", COLORS.processing);
          product.moveTo(pos.x, pos.y);
        }
        break;
      case "PROC_END":
        if (machine) {
          machine.setStatus("Finished", COLORS.processing);
        }
        break;
      case "TRANSPORT_START":
        if (event.entity_id != null) {
          const product = this.scene.getOrCreateProduct(event.entity_id);
          const originMachine = event.from_machine || event.machine;
          const fromPos = originMachine
            ? this.scene.getMachinePosition(originMachine)
            : { x: product.sprite.x, y: product.sprite.y };
          const pending = this.pendingTransports.get(event.entity_id);
          const toMachine = event.to_machine || pending?.toMachine || event.machine;
          const toPos = this.scene.getBufferPosition(toMachine);
          product.beginTransport(fromPos, toPos, event.time_min);
          this.pendingTransports.set(event.entity_id, {
            fromMachine: originMachine,
            toMachine,
            fromPos,
            toPos,
            startTime: event.time_min,
          });
        }
        break;
      case "TRANSPORT_END": {
        if (event.entity_id != null) {
          const product = this.scene.getOrCreateProduct(event.entity_id);
          const pending = this.pendingTransports.get(event.entity_id);
          const destinationMachine = event.to_machine || pending?.toMachine || event.machine;
          const toPos = this.scene.getBufferPosition(destinationMachine);
          if (pending) {
            product.finalizeTransport(toPos, event.time_min);
            this.pendingTransports.delete(event.entity_id);
          } else {
            product.moveTo(toPos.x, toPos.y);
            product.setState("queue", COLORS.queue);
          }
        }
        this.kpisDirty = true;
        break;
      }
      case "BREAKDOWN_START":
        if (machine) {
          machine.setBreakdown(true);
          machine.setStatus("Breakdown", COLORS.breakdown);
        }
        if (event.machine) {
          this.breakdownActive.add(event.machine);
          this.kpisDirty = true;
        }
        break;
      case "BREAKDOWN_END":
        if (machine) {
          machine.setBreakdown(false);
          machine.setStatus("Recovered", COLORS.queue);
        }
        if (event.machine) {
          this.breakdownActive.delete(event.machine);
          this.kpisDirty = true;
        }
        break;
      case "KANBAN_BLOCKED":
        if (machine) {
          machine.setStatus("Kanban blocked", COLORS.breakdown);
        }
        break;
      case "KANBAN_PASS":
        if (machine) {
          machine.setStatus("Kanban pass", COLORS.queue);
        }
        break;
      case "FINISH":
      case "Finish":
        if (event.entity_id != null) {
          this.scene.removeProduct(event.entity_id);
          this.pendingTransports.delete(event.entity_id);
        }
        this.completedCount += 1;
        this.kpisDirty = true;
        break;
      default:
        break;
    }
  }
}

async function bootstrap() {
  try {
    const metadata = await fetchJson("/api/metadata");
    document.getElementById("timeEnd").textContent = `${metadata.time.end.toFixed(2)} min`;
    const controller = new SimulationController(metadata);
    controller.updateClock();
  } catch (error) {
    const container = document.querySelector(".canvas-container");
    container.innerHTML = `<div class="error">Failed to load metadata: ${error}</div>`;
    console.error(error);
  }
}

document.addEventListener("DOMContentLoaded", bootstrap);
