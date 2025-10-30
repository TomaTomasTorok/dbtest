const ORIGIN = window.location.origin;
const DEFAULT_API = ORIGIN.startsWith("file") ? "http://localhost:8000" : ORIGIN;
const API_BASE = window.API_BASE_URL || DEFAULT_API;

const COLORS = {
  queue: 0xffd166,
  processing: 0x06d6a0,
  transport: 0x4cc9f0,
  breakdown: 0xef476f,
};

const COLOR_MUTED = 0x94a1b2;
const MACHINE_SIZE = { width: 120, height: 60 };
const BUFFER_OFFSET = { x: 0, y: -50 };

function colorToCss(color) {
  return `#${color.toString(16).padStart(6, "0")}`;
}

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

class Ticker {
  constructor() {
    this.callbacks = new Set();
    this.lastTime = performance.now();
    this._running = true;
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  add(callback) {
    this.callbacks.add(callback);
  }

  remove(callback) {
    this.callbacks.delete(callback);
  }

  stop() {
    this._running = false;
  }

  start() {
    if (!this._running) {
      this._running = true;
      this.lastTime = performance.now();
      requestAnimationFrame(this._tick);
    }
  }

  _tick(now) {
    if (!this._running) return;
    const deltaMs = now - this.lastTime;
    this.lastTime = now;
    const delta = deltaMs / (1000 / 60);
    for (const callback of this.callbacks) {
      callback(delta);
    }
    requestAnimationFrame(this._tick);
  }
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
    this.queueLength = 0;
    this.lastEvent = null;
    this.activeBreakdown = false;

    this.element = document.createElement("div");
    this.element.className = "machine";
    this.element.style.left = `${layout.x}px`;
    this.element.style.top = `${layout.y}px`;

    this.bufferElement = document.createElement("div");
    this.bufferElement.className = "buffer";
    this.bufferLabel = document.createElement("span");
    this.bufferLabel.className = "buffer-label";
    this.bufferLabel.textContent = "0";
    this.bufferElement.appendChild(this.bufferLabel);

    this.body = document.createElement("div");
    this.body.className = "body";
    this.label = document.createElement("div");
    this.label.className = "label";
    this.label.textContent = machine;
    this.statusLabel = document.createElement("div");
    this.statusLabel.className = "status";
    this.setStatus("Idle", COLOR_MUTED);

    this.body.appendChild(this.label);
    this.body.appendChild(this.statusLabel);

    this.element.appendChild(this.bufferElement);
    this.element.appendChild(this.body);

    this.element.addEventListener("click", () => onSelect(this));

    parent.appendChild(this.element);
  }

  setQueueLength(value) {
    this.queueLength = value ?? 0;
    this.bufferLabel.textContent = String(this.queueLength);
  }

  setStatus(text, color = COLOR_MUTED) {
    this.statusLabel.textContent = text;
    this.statusLabel.style.color = colorToCss(color);
  }

  setBreakdown(active) {
    this.activeBreakdown = active;
    this.element.classList.toggle("breakdown", active);
  }
}

class ProductView {
  constructor(id, parent) {
    this.id = id;
    this.element = document.createElement("div");
    this.element.className = "product";
    this.element.style.display = "none";
    parent.appendChild(this.element);

    this.state = "queue";
    this.transport = null;
    this.queueAfterTransport = false;
  }

  setState(state, color) {
    this.element.classList.remove("state-queue", "state-processing", "state-transport");
    this.element.classList.add(`state-${state}`);
    this.element.style.background = colorToCss(color);
    this.state = state;
  }

  moveTo(x, y) {
    this.element.style.left = `${x}px`;
    this.element.style.top = `${y}px`;
    this.element.style.display = "block";
    this.element.classList.add("visible");
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
      this.beginTransport({ x: parseFloat(this.element.style.left) || 0, y: parseFloat(this.element.style.top) || 0 }, toPos, endTime - 0.05);
    }
    this.transport.toPos = toPos;
    this.transport.endTime = Math.max(endTime, this.transport.startTime + 0.05);
    this.queueAfterTransport = true;
  }

  update(currentTime) {
    if (this.element.style.display === "none") return;
    if (this.transport) {
      const { fromPos, toPos, startTime, endTime } = this.transport;
      const progress = Math.min(1, Math.max(0, (currentTime - startTime) / Math.max(0.001, endTime - startTime)));
      const ease = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
      const x = fromPos.x + (toPos.x - fromPos.x) * ease;
      const y = fromPos.y + (toPos.y - fromPos.y) * ease;
      this.element.style.left = `${x}px`;
      this.element.style.top = `${y}px`;
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
    this.element.style.display = "none";
    this.element.classList.remove("visible");
    this.transport = null;
    this.queueAfterTransport = false;
  }
}

class Scene {
  constructor(metadata) {
    this.metadata = metadata;
    this.root = document.getElementById("scene");
    this.root.innerHTML = "";
    this.root.classList.add("scene-root");

    this.width = metadata.layout?.width || this.root.clientWidth || 1280;
    this.height = metadata.layout?.height || this.root.clientHeight || 720;

    this.linkLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.linkLayer.classList.add("scene-links");
    this.linkLayer.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
    this.linkLayer.setAttribute("preserveAspectRatio", "xMidYMid meet");

    this.machineLayer = document.createElement("div");
    this.machineLayer.className = "machine-layer";

    this.productLayer = document.createElement("div");
    this.productLayer.className = "product-layer";

    this.root.appendChild(this.linkLayer);
    this.root.appendChild(this.machineLayer);
    this.root.appendChild(this.productLayer);

    this.machines = new Map();
    this.products = new Map();
    this.ticker = new Ticker();

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
    this.linkLayer.innerHTML = "";
    for (const edge of this.metadata.edges || []) {
      const from = this.machines.get(edge.from);
      const to = this.machines.get(edge.to);
      if (!from || !to) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", from.layout.x);
      line.setAttribute("y1", from.layout.y);
      line.setAttribute("x2", to.layout.x);
      line.setAttribute("y2", to.layout.y);
      line.setAttribute("stroke", "rgba(31, 64, 104, 0.35)");
      line.setAttribute("stroke-width", "1");
      this.linkLayer.appendChild(line);
    }
  }

  getMachinePosition(machine) {
    const view = this.machines.get(machine);
    if (!view) return { x: 0, y: 0 };
    return { x: view.layout.x, y: view.layout.y };
  }

  getBufferPosition(machine) {
    const view = this.machines.get(machine);
    if (!view) return { x: 0, y: 0 };
    return {
      x: view.layout.x + BUFFER_OFFSET.x,
      y: view.layout.y + BUFFER_OFFSET.y,
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
      if (view.element.style.display !== "none") {
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

    this.scene.ticker.add((delta) => {
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

  togglePlay() {
    this.isPlaying = !this.isPlaying;
    this.playButton.textContent = this.isPlaying ? "Pause" : "Play";
    if (this.isPlaying) {
      this.scene.ticker.start();
    }
  }

  async seek(time) {
    this.isPlaying = false;
    this.playButton.textContent = "Play";
    this.currentTime = Math.max(this.metadata.time.start, Math.min(time, this.metadata.time.end));
    await this.stream.reset(this.stream.windowSize);
    this.pendingTransports.clear();
    this.completedCount = 0;
    this.breakdownActive.clear();
    this.kpisDirty = true;

    for (const machine of this.scene.machines.values()) {
      machine.setQueueLength(0);
      machine.setStatus("Idle", COLOR_MUTED);
      machine.setBreakdown(false);
      machine.lastEvent = null;
    }
    for (const product of this.scene.products.values()) {
      product.hide();
    }

    await this.advanceTo(this.currentTime, true);
  }

  async advanceTo(targetTime, force = false) {
    await this.stream.ensureUntil(targetTime + this.stream.windowSize * 0.1);

    const events = await this.stream.takeUntil(targetTime);
    for (const event of events) {
      this.handleEvent(event);
      this.currentTime = event.time_min;
      this.scene.updateProductAnimations(this.currentTime);
    }

    this.currentTime = targetTime;
    this.scene.updateProductAnimations(this.currentTime);
    this.updateClock();
    if (this.kpisDirty || force) {
      this.updateKpis();
      this.kpisDirty = false;
    }
  }

  handleEvent(event) {
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
            : { x: parseFloat(product.element.style.left) || 0, y: parseFloat(product.element.style.top) || 0 };
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
