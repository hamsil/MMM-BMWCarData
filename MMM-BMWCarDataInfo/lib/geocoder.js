"use strict";

const { haversine } = require("./detectors");

const DEFAULT_URL = "https://nominatim.openstreetmap.org/reverse";
const VERSION     = require("../../package.json").version;

// Simple LRU cache keyed on ~100 m grid cell
class LRUCache {
  #max;
  #map;

  constructor(max = 50) {
    this.#max = max;
    this.#map = new Map();
  }

  #key(lat, lon) {
    return `${Math.trunc(lat * 1000)},${Math.trunc(lon * 1000)}`;
  }

  get(lat, lon) {
    const k = this.#key(lat, lon);
    if (!this.#map.has(k)) return null;
    const v = this.#map.get(k);
    this.#map.delete(k);
    this.#map.set(k, v); // move to end (most-recently-used)
    return v;
  }

  set(lat, lon, value) {
    const k = this.#key(lat, lon);
    if (this.#map.has(k)) this.#map.delete(k);
    else if (this.#map.size >= this.#max) this.#map.delete(this.#map.keys().next().value);
    this.#map.set(k, value);
  }
}

class Geocoder {
  #enabled; #url; #contact; #minInterval; #minMove; #lang;
  #cache;
  #lastPos     = null;
  #lastTime    = 0;
  #lastAddress = null;

  /**
   * @param {object}  cfg
   * @param {boolean} cfg.enabled
   * @param {string}  cfg.url
   * @param {string}  cfg.contact         For User-Agent (Nominatim policy)
   * @param {number}  cfg.minIntervalSec
   * @param {number}  cfg.minMoveMeters
   * @param {string}  cfg.locale          BCP-47 locale, e.g. "de-DE"
   */
  constructor(cfg = {}) {
    this.#enabled     = cfg.enabled ?? true;
    this.#url         = cfg.url ?? DEFAULT_URL;
    this.#contact     = cfg.contact ?? "unknown";
    this.#minInterval = (cfg.minIntervalSec ?? 60) * 1000;
    this.#minMove     = cfg.minMoveMeters ?? 100;
    // Derive a language tag from a BCP-47 locale string ("de-DE" → "de").
    this.#lang        = (cfg.locale ?? "en").split("-")[0];
    this.#cache       = new LRUCache(50);
  }

  /**
   * Reverse-geocode {lat, lon}. Returns address string, or lat/lon fallback.
   * Rate-limited: only fires when the car has moved >minMove m or >minInterval ms.
   */
  async lookup(lat, lon) {
    if (!this.#enabled) return this.#fallback(lat, lon);

    const cached = this.#cache.get(lat, lon);
    if (cached) { this.#lastAddress = cached; return cached; }

    const now   = Date.now();
    const moved = this.#lastPos ? haversine(this.#lastPos, { lat, lon }) : Infinity;

    if (moved < this.#minMove && now - this.#lastTime < this.#minInterval) {
      return this.#lastAddress ?? this.#fallback(lat, lon);
    }

    try {
      const url = `${this.#url}?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1`;
      const ua  = `MMM-BMWCarData/${VERSION} (${this.#contact})`;
      const res = await fetch(url, {
        headers: { "User-Agent": ua, "Accept-Language": this.#lang },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const addr = this.#format(json.address ?? {});
      this.#cache.set(lat, lon, addr);
      this.#lastPos     = { lat, lon };
      this.#lastTime    = now;
      this.#lastAddress = addr;
      return addr;
    } catch (e) {
      console.warn("[BMW Geocoder]", e.message);
      return this.#lastAddress ?? this.#fallback(lat, lon);
    }
  }

  #fallback(lat, lon) {
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  }

  #format(a) {
    const parts = [
      [a.road, a.house_number].filter(Boolean).join(" "),
      a.postcode,
      a.city ?? a.town ?? a.village ?? a.county,
    ].filter(Boolean);
    return parts.join(", ") || this.#fallback(0, 0);
  }
}

module.exports = { Geocoder };
