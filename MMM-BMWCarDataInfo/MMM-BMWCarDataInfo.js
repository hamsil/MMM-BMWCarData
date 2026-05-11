"use strict";

// VIN format: 17 chars, no I/O/Q per ISO 3779.
// Intentionally duplicated from node_helper.js — the two files run in
// different environments (browser vs Node) so they cannot share a module.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

Module.register("MMM-BMWCarDataInfo", {
  defaults: {
    clientId:          "",
    vin:               "",
    columns:           4,         // columns in the topic grid (1–6)
    debugLocations:    false,     // set true to write data/locations-{vin}.log (GPS debug log)
    parkingMinMinutes: 10,
    mqttHost:          "customer.streaming-cardata.bmwgroup.com",
    mqttPort:          9000,
    geocoder: {
      enabled:        true,
      url:            "https://nominatim.openstreetmap.org/reverse",
      contact:        "",
      minIntervalSec: 60,
      minMoveMeters:  100,
    },
    // topics: list of topic paths to display.
    // Each entry is either a plain topic path string, or an object:
    //   { path: "vehicle.vehicle.travelledDistance", label: "Mileage" }
    //   { path: "vehicle.chassis.axle.row1.wheel.left.tire.pressure",
    //     label: "FL Tyre", format: "{v/100:.1f} bar" }
    //   { path: "vehicle.location.address", label: "Location", span: 2 }
    // label  – human-readable label; derived from path if omitted
    // format – optional format string; auto-detected from path if omitted
    //          Grammar: "{v} unit"  |  "{v/100:.1f} bar"  (v = raw value,
    //          arithmetic on v allowed, :.Nf controls decimal places)
    // span   – number of columns this entry occupies (default 1)
    // When topics is null/empty the module shows nothing (no default list).
    topics: null,
    // Override or add translations without editing the translation files.
    // Keys follow the same naming as translations/*.json (e.g. "WAITING",
    // or "topic.vehicle.isMoving.true").
    customTranslations: {},
  },

  getStyles() {
    return [this.file("css/MMM-BMWCarDataInfo.css")];
  },

  getTranslations() {
    return {
      en: "translations/en.json",
      de: "translations/de.json",
    };
  },

  getHeader() {
    return this.data.header ?? "";
  },

  start() {
    Log.info(`[BMW Info ${this.identifier}] Module started.`);
    this.state     = null;
    this.connected = false;
    this.error     = null;

    // Validate required config fields before sending anything to the helper.
    if (!this.config.vin || !VIN_RE.test(this.config.vin)) {
      Log.error(`[BMW Info ${this.identifier}] Invalid or missing VIN in config.`);
      this.error = "Invalid or missing VIN in config.";
      return;
    }
    if (!this.config.clientId) {
      Log.error(`[BMW Info ${this.identifier}] Missing clientId in config.`);
      this.error = "Missing clientId in config.";
      return;
    }

    // Normalise topics to [{path, label, format, span}] or null
    this._topics = this._normaliseTopics(this.config.topics);

    // Derive locale: explicit config > MagicMirror global language > "en"
    const locale = this.config.locale
      || (typeof config !== "undefined" && config?.language)
      || "en";

    this.sendSocketNotification("CONFIG", {
      instanceId:        this.identifier,
      clientId:          this.config.clientId,
      vin:               this.config.vin,
      locale,
      debugLocations:    this.config.debugLocations,
      parkingMinMinutes: this.config.parkingMinMinutes,
      mqttHost:          this.config.mqttHost,
      mqttPort:          this.config.mqttPort,
      geocoder:          this.config.geocoder,
    });
  },

  _normaliseTopics(raw) {
    if (!raw || !Array.isArray(raw) || raw.length === 0) return null;
    return raw.map((entry) => {
      if (typeof entry === "string") return { path: entry, label: null, format: null, span: 1, showWhen: null };
      return {
        path:     entry.path,
        label:    entry.label    ?? null,
        format:   entry.format   ?? null,
        span:     Math.max(1, Math.min(6, entry.span ?? 1)),
        showWhen: entry.showWhen ?? null,
      };
    });
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "bmw-info";

    if (this.error) {
      const p = document.createElement("p");
      p.className = "bmw-error small dimmed";
      p.textContent = `⚠ ${this.error}`;
      wrapper.appendChild(p);
      return wrapper;
    }
    if (!this.state) {
      const p = document.createElement("p");
      p.className = "bmw-waiting small dimmed";
      p.textContent = this.customTranslate("WAITING");
      wrapper.appendChild(p);
      return wrapper;
    }

    if (this._topics) {
      wrapper.appendChild(this._buildTopicsGrid(this.state));
    } else {
      const p = document.createElement("p");
      p.className = "bmw-waiting small dimmed";
      p.textContent = this.customTranslate("NO_TOPICS");
      wrapper.appendChild(p);
    }

    return wrapper;
  },

  // ── Configurable-column dynamic topic grid ────────────────────────────────

  _buildTopicsGrid(state) {
    const { formatValue, labelFromPath } = this._getFormatter();
    const rawTopics = state.rawTopics ?? {};
    const cols      = Math.max(1, Math.min(6, this.config.columns ?? 2));

    const table = document.createElement("table");
    table.className = "bmw-topic-table";

    const colgroup = document.createElement("colgroup");
    for (let c = 0; c < cols; c++) {
      const col = document.createElement("col");
      col.style.width = `${(100 / cols).toFixed(2)}%`;
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);

    const grid = { tr: null, colPos: 0 };

    for (const topic of this._topics) {
      if (!this._evalShowWhen(topic.showWhen)) continue;
      const span = Math.max(1, Math.min(cols, topic.span ?? 1));

      if (grid.tr !== null && grid.colPos + span > cols) this._closeGridRow(grid, cols, table);

      if (grid.tr === null) grid.tr = document.createElement("tr");

      const td = this._topicCell(topic, rawTopics, formatValue, labelFromPath);
      if (span > 1) td.colSpan = span;
      if (grid.colPos > 0) td.classList.add("bmw-topic-cell--sep");
      grid.tr.appendChild(td);
      grid.colPos += span;

      if (grid.colPos === cols) this._closeGridRow(grid, cols, table);
    }

    if (grid.tr !== null) this._closeGridRow(grid, cols, table);

    return table;
  },

  _closeGridRow(grid, cols, table) {
    if (grid.colPos < cols) {
      const filler = document.createElement("td");
      filler.colSpan = cols - grid.colPos;
      grid.tr.appendChild(filler);
    }
    table.appendChild(grid.tr);
    grid.tr    = null;
    grid.colPos = 0;
  },

  _topicCell(topicDef, rawTopics, formatValue, labelFromPath) {
    const { path, label, format } = topicDef;

    const rawEntry = rawTopics[path];
    const rawValue = rawEntry?.lastValue ?? null;

    const td = document.createElement("td");
    td.className = "bmw-topic-cell";

    if (path === "image") {
      if (label) {
        const lbl = document.createElement("span");
        lbl.className = "bmw-topic-label dimmed small";
        lbl.textContent = label;
        td.appendChild(lbl);
      }
      if (rawValue) {
        const img = document.createElement("img");
        img.src       = rawValue;
        img.className = "bmw-vehicle-image";
        img.alt       = label ?? "Vehicle";
        td.appendChild(img);
      } else {
        const val = document.createElement("span");
        val.className = "bmw-topic-value";
        val.textContent = "—";
        td.appendChild(val);
      }
      return td;
    }

    const displayLabel = label ?? labelFromPath(path);
    const overrides    = format ? { format } : null;
    const displayValue = rawValue == null
      ? "—"
      : formatValue(path, rawValue, this.config.locale, overrides, (key) => this.customTranslate(key));

    const labelEl = document.createElement("span");
    labelEl.className = "bmw-topic-label dimmed small";
    labelEl.textContent = displayLabel;

    const valueEl = document.createElement("span");
    valueEl.className = "bmw-topic-value bright";
    valueEl.textContent = displayValue;

    td.appendChild(labelEl);
    td.appendChild(valueEl);
    return td;
  },

  // Translate a key: config.customTranslations takes priority over the
  // standard translation files, which fall back to English automatically.
  customTranslate(key) {
    const custom = this.config.customTranslations?.[key];
    return custom == null ? this.translate(key) : custom;
  },

  _getJsonLogic() {
    // Prefer the browser global set by vendor/json-logic.js.
    if (typeof jsonLogic !== "undefined") return jsonLogic;
    // In Electron with nodeIntegration the vendor script sets module.exports
    // instead of window.jsonLogic.  require() reaches it directly.
    try {
      // eslint-disable-next-line no-undef
      if (typeof require !== "undefined") return require("json-logic-js");
    } catch { /* not available in this environment */ }
    return null;
  },

  _evalShowWhen(showWhen) {
    if (!showWhen) return true;
    const jl = this._getJsonLogic();
    if (!jl) return true;
    // Build a nested object so json-logic's dot-notation var access works:
    // { "var": "vehicle.drivetrain.electricEngine.charging.status" }
    // traverses data.vehicle.drivetrain.electricEngine.charging.status
    const data = {};
    for (const [k, v] of Object.entries(this.state?.rawTopics ?? {})) {
      const parts = k.split(".");
      let node = data;
      for (let i = 0; i < parts.length - 1; i++) {
        node[parts[i]] ??= {};
        node = node[parts[i]];
      }
      node[parts.at(-1)] = v.lastValue ?? null;
    }
    return Boolean(jl.apply(showWhen, data));
  },

  _getFormatter() {
    if (globalThis.bmwTopicFormatter) return globalThis.bmwTopicFormatter;
    return {
      formatValue:   (_path, value) => (value == null ? "—" : String(value)),
      labelFromPath: (p) => p.split(".").slice(-1)[0],
    };
  },

  socketNotificationReceived(notification, payload) {
    if (payload?.instanceId && payload.instanceId !== this.identifier) return;

    if (notification === "VEHICLE_STATE") {
      this.state = payload;
      this.error = null;
      this.sendNotification("BMW_CARDATA", { instanceId: this.identifier, vin: this.config.vin, ...payload });
      this.updateDom(300);
    } else if (notification === "ERROR") {
      this.error = payload.message;
      this.updateDom(300);
    } else if (notification === "CONNECTED") {
      this.connected = true;
      this.updateDom(300);
    }
  },

  getScripts() {
    return [
      this.file("vendor/json-logic.js"),
      this.file("lib/topicFormatter.js"),
    ];
  },

  suspend() {},
  resume()  { if (this.state) this.updateDom(0); },
});
