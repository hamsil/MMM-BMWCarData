"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const DATA_DIR  = path.join(__dirname, "..", "data");
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function sortKeys(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort((a, b) => a.localeCompare(b))) sorted[k] = obj[k];
  return sorted;
}

class Store {
  #vin;
  #stateFile;
  #discFile;
  #dirty     = false;
  #saveTimer = null;

  /**
   * @param {string} vin  Namespaces the state file so two cars don't collide.
   */
  constructor(vin) {
    this.#vin       = vin || "default";
    this.#stateFile = path.join(DATA_DIR, `state-${this.#vin}.json`);
    this.#discFile  = path.join(DATA_DIR, `discovered-topics-${this.#vin}.json`);

    this.track     = [];
    this.charging  = [];
    this.parking   = [];
    this.latest    = {};
    this.rawTopics = {};  // path → {lastValue, valueType, firstSeen, lastSeen, count}
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  load() {
    this.#loadState();
    this.#loadDiscovered();
  }

  #loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#stateFile, "utf8"));
      this.track    = raw.track    ?? [];
      this.charging = raw.charging ?? [];
      this.parking  = raw.parking  ?? [];
      this.latest   = raw.latest   ?? {};
      this.#prune();
      this.#pruneLatest();
      console.log(`[BMW Store ${this.#vin}] Loaded – ${this.track.length} track pts`);
    } catch (e) {
      if (e.code === "ENOENT") console.log(`[BMW Store ${this.#vin}] No saved state (first run).`);
      else console.warn(`[BMW Store ${this.#vin}] Could not load state:`, e.message);
    }
  }

  // Remove stale display-only keys that were persisted by earlier versions.
  // Only functional fields used by detectors and the map are retained.
  // ⚠ If a new functional field is added to `latest`, add it here too or it
  //   will be silently dropped when loading a previously-saved state file.
  #pruneLatest() {
    const KEEP = new Set([
      "lat", "lon", "heading", "speed",
      "chargingStatus", "soc", "maxEnergy", "isMoving",
      "address", "updatedAt",
      "latAt", "lonAt", "headingAt", "speedAt",
      "chargingStatusAt", "socAt", "maxEnergyAt", "isMovingAt",
    ]);
    for (const key of Object.keys(this.latest)) {
      if (!KEEP.has(key)) {
        delete this.latest[key];
        this.#dirty = true;
      }
    }
  }

  #loadDiscovered() {
    try {
      this.rawTopics = JSON.parse(fs.readFileSync(this.#discFile, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") console.warn(`[BMW Store ${this.#vin}] Could not load discovered topics:`, e.message);
      this.rawTopics = {};
    }
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  addTrackPoint(pt)     { this.track.push(pt);     this.#dirty = true; }
  addChargingStop(stop) { this.charging.push(stop); this.#dirty = true; }
  addParkingStop(stop)  { this.parking.push(stop);  this.#dirty = true; }

  updateLatest(patch) {
    Object.assign(this.latest, patch);
    this.#dirty = true;
  }

  /**
   * Record every raw topic path/value from MQTT. Written to
   * discovered-topics-{vin}.json so users can see what their car sends and
   * reference paths in their config.topics list.
   */
  observeTopic(topicPath, value, ts) {
    const existing = this.rawTopics[topicPath];
    this.rawTopics[topicPath] = {
      lastValue: value,
      valueType: typeof value,
      firstSeen: existing?.firstSeen ?? new Date(ts).toISOString(),
      lastSeen:  new Date(ts).toISOString(),
      count:     (existing?.count ?? 0) + 1,
    };
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  scheduleSave(debounceMs = 30_000) {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      if (this.#dirty) this.save();
    }, debounceMs);
  }

  save() {
    this.#prune();
    fs.mkdirSync(DATA_DIR, { recursive: true });

    this.#atomicWrite(this.#stateFile, {
      charging: this.charging,
      latest:   sortKeys(this.latest),
      parking:  this.parking,
      track:    this.track,
    });

    this.#atomicWrite(this.#discFile, sortKeys(this.rawTopics));

    this.#dirty = false;
  }

  #atomicWrite(file, data) {
    const tmp = file + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`[BMW Store] Save failed (${file}):`, e.message);
    }
  }

  close() {
    if (this.#saveTimer) { clearTimeout(this.#saveTimer); this.#saveTimer = null; }
    this.save();
  }

  #prune() {
    const cutoff = Date.now() - WINDOW_MS;
    this.track    = this.track.filter((p) => p.t * 1000 >= cutoff);
    this.charging = this.charging.filter((s) => s.end == null || s.end * 1000 >= cutoff);
    this.parking  = this.parking.filter((s) => s.end == null || s.end * 1000 >= cutoff);
  }

  snapshot() {
    return {
      latest:    { ...this.latest },
      rawTopics: { ...this.rawTopics },
      track:     this.track,
      charging:  this.charging,
      parking:   this.parking,
    };
  }
}

module.exports = { Store };
