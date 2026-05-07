/* global Module, Log, L */
"use strict";

// Catmull-Rom spline: given sorted array of {lat,lon} points, returns a denser
// array of interpolated points for smooth visual rendering.
function catmullRomSpline(pts, segmentsPerSpan = 8) {
  if (pts.length < 4) return pts;
  const result = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2];
    for (let j = 0; j < segmentsPerSpan; j++) {
      const t  = j / segmentsPerSpan;
      const t2 = t * t, t3 = t2 * t;
      result.push({
        lat: 0.5 * (
          2*p1.lat + (-p0.lat+p2.lat)*t +
          (2*p0.lat-5*p1.lat+4*p2.lat-p3.lat)*t2 +
          (-p0.lat+3*p1.lat-3*p2.lat+p3.lat)*t3),
        lon: 0.5 * (
          2*p1.lon + (-p0.lon+p2.lon)*t +
          (2*p0.lon-5*p1.lon+4*p2.lon-p3.lon)*t2 +
          (-p0.lon+3*p1.lon-3*p2.lon+p3.lon)*t3),
        speed: p1.speed,
      });
    }
  }
  result.push(pts[pts.length - 2]);
  return result;
}

Module.register("MMM-BMWCarDataMap", {
  defaults: {
    // Use a region with plenty of horizontal space: fullscreen_below, bottom_bar,
    // or bottom_center.
    width:          "100%",
    height:         "480px",
    // Hours of GPS track to display.
    // 0 → no track; map stays centred on the current position at defaultZoom.
    // >0 → show the most recent N hours of track, auto-fitted to fill the map.
    trackHours:  24,
    debugRaw:    false,
    trackColor: "linear-gradient(to right, #1a6bff 0%, #00bbcc 20%, #00cc55 40%, #ffcc00 64%, #ff5500 80%, #dd0000 100%)",
    // vins: list of VINs this map shows. Empty = show all connected cars.
    vins:            [],
    tileUrl:         "/MMM-BMWCarDataInfo/tile/carto-dark/{z}/{x}/{y}.png",
    tileApiKey:      "",
    tileAttribution: "&copy; <a href='https://openstreetmap.org'>OSM</a> &copy; <a href='https://carto.com'>CARTO</a>",
    tileFilter:      "brightness(2.5) contrast(1.2)",
    defaultZoom:      20,
    defaultCenter:    [51, 10],
  },

  getHeader() {
    return this.data.header ?? "";
  },

  getStyles() {
    return [
      this.file("vendor/leaflet/leaflet.css"),
      this.file("css/MMM-BMWCarDataMap.css"),
    ];
  },

  getScripts() {
    return [
      this.file("vendor/leaflet/leaflet.js"),
      this.file("vendor/leaflet-hotline/leaflet.hotline.js"),
    ];
  },

  start() {
    Log.info("[BMW Map] Module started.");
    // Per-car state keyed by VIN (or instanceId as fallback).
    this._cars          = new Map();
    // Payloads buffered until the Leaflet map is initialised.
    this._pendingStates = new Map();
    this._map      = null;
    this._mapReady = false;
    this._wrapper  = null;
  },

  getDom() {
    // Return the same wrapper element every time so Leaflet's container is
    // never detached from the document by a re-render.
    if (this._wrapper) return this._wrapper;

    this._wrapper = document.createElement("div");
    this._wrapper.className = "bmw-map-wrapper";
    // Width is handled by CSS (.MMM-BMWCarDataMap { width: 100% }) so Leaflet
    // reads the real column width.  Only set an explicit width when the user
    // has configured something other than the default "100%".
    if (this.config.width !== "100%") {
      this._wrapper.style.width = this.config.width;
    }
    this._wrapper.style.height = this.config.height;

    const mapDiv = document.createElement("div");
    mapDiv.id        = `bmw-map-${this.identifier}`;
    mapDiv.className = "bmw-map-container";
    mapDiv.style.width  = "100%";
    mapDiv.style.height = "100%";
    this._wrapper.appendChild(mapDiv);

    // Leaflet needs the element in the DOM before init
    setTimeout(() => this._initMap(mapDiv.id), 400);
    return this._wrapper;
  },

  _initMap(containerId) {
    if (this._map) return;
    if (typeof L === "undefined") {
      Log.warn("[BMW Map] Leaflet not loaded yet, retrying…");
      setTimeout(() => this._initMap(containerId), 500);
      return;
    }

    this._map = L.map(containerId, {
      zoomControl:        false,
      attributionControl: true,
      dragging:           false,
      scrollWheelZoom:    false,
      doubleClickZoom:    false,
      boxZoom:            false,
      keyboard:           false,
    });

    const tileUrl = this.config.tileApiKey
      ? `${this.config.tileUrl}?api_key=${this.config.tileApiKey}`
      : this.config.tileUrl;

    L.tileLayer(tileUrl, {
      attribution: this.config.tileAttribution,
    }).addTo(this._map);

    // Remove "Leaflet" prefix – legal attribution is already in the tile layer string.
    this._map.attributionControl.setPrefix(false);

    // Apply contrast filter to the tile pane only so track colours are unaffected.
    if (this.config.tileFilter) {
      const pane = this._map.getPane("tilePane");
      if (pane) pane.style.filter = this.config.tileFilter;
    }

    // Set a view immediately so tiles load. _render() overrides this once GPS arrives.
    this._map.setView(this.config.defaultCenter, this.config.defaultZoom);

    this._mapReady = true;

    // Re-read the actual rendered container size in case the DOM was still
    // being laid out when Leaflet first measured it.
    setTimeout(() => this._map.invalidateSize(), 200);

    for (const [key, data] of this._pendingStates) this._render(data, key);
    this._pendingStates.clear();
  },

  notificationReceived(notification, payload) {
    if (notification !== "BMW_CARDATA") return;
    const { vins } = this.config;
    const vin = payload?.vin;
    if (vins.length > 0 && (!vin || !vins.includes(vin))) return;
    const key = vin ?? payload?.instanceId ?? "default";
    if (this._mapReady) {
      this._render(payload, key);
    } else {
      this._pendingStates.set(key, payload);
    }
  },

  _render(data, key) {
    const cs = this._getOrCreateCarState(key);
    this._renderTrack(data.track ?? [], cs);
    this._renderPosition(data.latest ?? {}, cs);
    this._renderStops(data.charging ?? [], cs.chargingLayer, (s) => this._chargingMarker(s));
    this._renderStops(data.parking  ?? [], cs.parkingLayer,  (s) => this._parkingMarker(s));
    this._updateView();
  },

  _getOrCreateCarState(key) {
    if (!this._cars.has(key)) {
      this._cars.set(key, {
        hotline:       null,
        rawLine:       null,
        trackBounds:   null,
        posMarker:     null,
        chargingLayer: L.layerGroup().addTo(this._map),
        parkingLayer:  L.layerGroup().addTo(this._map),
      });
    }
    return this._cars.get(key);
  },

  _renderTrack(track, cs) {
    if (this.config.trackHours === 0) {
      if (cs.hotline) { this._map.removeLayer(cs.hotline); cs.hotline = null; }
      if (cs.rawLine) { this._map.removeLayer(cs.rawLine); cs.rawLine = null; }
      cs.trackBounds = null;
      return;
    }

    const cutoff     = Date.now() / 1000 - this.config.trackHours * 3600;
    const validTrack = track.filter((p) => p.lat != null && p.lon != null && p.t >= cutoff);

    if (validTrack.length < 2) {
      if (cs.hotline) { this._map.removeLayer(cs.hotline); cs.hotline = null; }
      cs.trackBounds = null;
      return;
    }

    cs.trackBounds = L.latLngBounds(validTrack.map((p) => [p.lat, p.lon]));

    const withSpeed   = this._fillSpeed(validTrack);
    const smoothed    = catmullRomSpline(withSpeed, 6);
    const hotlineData = smoothed.map((p) => [p.lat, p.lon, p.speed ?? 0]);
    const { palette, min, max } = this._parsePalette(this.config.trackColor);

    if (cs.hotline) this._map.removeLayer(cs.hotline);
    cs.hotline = L.hotline(hotlineData, {
      min, max, palette,
      weight:       4,
      outlineWidth: 1,
      outlineColor: "rgba(0,0,0,0.4)",
    }).addTo(this._map);

    if (this.config.debugRaw) {
      if (cs.rawLine) this._map.removeLayer(cs.rawLine);
      cs.rawLine = L.polyline(validTrack.map((p) => [p.lat, p.lon]), {
        color:     "rgba(255,220,50,0.65)",
        weight:    3,
        dashArray: "4 4",
      }).addTo(this._map);
    }
  },

  // For track points with speed === 0, derive speed in km/h from adjacent GPS positions
  // and timestamps. This handles cars that don't transmit speed over MQTT.
  // Points with a real non-zero MQTT speed are left untouched.
  _fillSpeed(track) {
    return track.map((p, i) => {
      if (p.speed > 0) return p;
      const a = track[i - 1] ?? p;
      const b = track[i + 1] ?? p;
      const dtSec = Math.max(b.t - a.t, 1);
      const dLat  = (b.lat - a.lat) * 111_320;
      const dLon  = (b.lon - a.lon) * 111_320 * Math.cos(a.lat * Math.PI / 180);
      const distM = Math.hypot(dLat, dLon);
      return { ...p, speed: (distM / dtSec) * 3.6 };
    });
  },

  // Parse trackColor into a Leaflet hotline palette.
  // Accepts:
  //   - A CSS linear-gradient string with "color pct%" stops  →  gradient palette
  //   - Any other CSS colour string                           →  flat single colour
  // The palette normalises speed over [0, 250] km/h.
  _parsePalette(trackColor) {
    const str = String(trackColor ?? "").trim();

    // Extract "color pct%" stop pairs from anywhere in the string.
    // Handles hex (#rrggbb), rgb/rgba/hsl/hsla functions, and plain colour names.
    // Match "color pct%" stop pairs: function colors, hex, or named colours.
    const stops = [];
    const re = /(\w+\([^)]*\)|#[0-9a-f]{3,8}|[a-z]\w*)\s+(\d+\.?\d*)%/gi;
    let m;
    while ((m = re.exec(str)) !== null) {
      stops.push([Number.parseFloat(m[2]) / 100, m[1]]);
    }

    if (stops.length >= 2) {
      stops.sort((a, b) => a[0] - b[0]);
      const palette = {};
      for (const [pct, color] of stops) palette[pct] = color;
      return { palette, min: 0, max: 250 };
    }

    // Single colour — use raw string; fall back to white if it was an unparseable gradient.
    const single = /gradient/i.test(str) ? "#ffffff" : (str || "#ffffff");
    return { palette: { 0: single, 1: single }, min: 0, max: 250 };
  },

  _renderPosition(latest, cs) {
    if (latest.lat == null) return;

    const heading = latest.heading ?? 0;
    const icon = L.divIcon({
      className: "",
      html:      `<div class="bmw-arrow" style="transform:rotate(${heading}deg)">▲</div>`,
      iconSize:  [24, 24],
      iconAnchor:[12, 12],
    });

    if (cs.posMarker) {
      cs.posMarker.setLatLng([latest.lat, latest.lon]);
      cs.posMarker.setIcon(icon);
    } else {
      cs.posMarker = L.marker([latest.lat, latest.lon], { icon, zIndexOffset: 1000 })
        .addTo(this._map);
    }
  },

  // Recalculate and apply the map view after all per-car rendering is done.
  // Merges track bounds from all cars; falls back to fitting all position markers.
  _updateView() {
    let combined = null;
    for (const cs of this._cars.values()) {
      if (cs.trackBounds) {
        combined = combined
          ? combined.extend(cs.trackBounds)
          : L.latLngBounds(cs.trackBounds);
      }
    }
    if (combined) {
      this._map.invalidateSize();
      this._map.fitBounds(combined, { padding: [20, 20] });
      return;
    }
    const positions = [];
    for (const cs of this._cars.values()) {
      if (cs.posMarker) positions.push(cs.posMarker.getLatLng());
    }
    if (positions.length === 1) {
      this._map.setView(positions[0], this.config.defaultZoom);
    } else if (positions.length > 1) {
      this._map.invalidateSize();
      this._map.fitBounds(L.latLngBounds(positions), { padding: [40, 40] });
    }
  },

  _renderStops(stops, layer, markerFn) {
    layer.clearLayers();
    for (const stop of stops) {
      if (stop.lat == null) continue;
      const { icon, popup } = markerFn(stop);
      L.marker([stop.lat, stop.lon], { icon })
        .bindPopup(popup, { className: "bmw-popup" })
        .addTo(layer);
    }
  },

  _chargingMarker(stop) {
    return {
      icon:  L.divIcon({ className: "bmw-stop-icon bmw-charging-icon", html: "⚡", iconSize: [28, 36], iconAnchor: [14, 36] }),
      popup: this._chargingPopup(stop),
    };
  },

  _parkingMarker(stop) {
    return {
      icon:  L.divIcon({ className: "bmw-stop-icon bmw-parking-icon", html: "P", iconSize: [24, 30], iconAnchor: [12, 30] }),
      popup: this._parkingPopup(stop),
    };
  },

  _fmtTime(unix) {
    if (!unix) return "–";
    return new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  },

  _fmtDuration(startUnix, endUnix) {
    if (!startUnix || !endUnix) return "";
    const min = Math.round((endUnix - startUnix) / 60);
    const h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
  },

  _chargingPopup(s) {
    const div = document.createElement("div");
    div.className = "bmw-popup-charging";

    const title = document.createElement("b");
    title.textContent = "⚡ Charging";
    div.appendChild(title);

    if (s.address) {
      const addr = document.createElement("div");
      addr.className = "bmw-popup-addr";
      addr.textContent = s.address; // textContent — safe against XSS from geocoder
      div.appendChild(addr);
    }

    const arr     = this._fmtTime(s.start);
    const dep     = s.end ? this._fmtTime(s.end) : "ongoing";
    const dur     = this._fmtDuration(s.start, s.end);
    const durPart = dur ? ` (${dur})` : "";
    const timeDiv = document.createElement("div");
    timeDiv.textContent = `${arr} → ${dep}${durPart}`;
    div.appendChild(timeDiv);

    if (s.socStart != null && s.socEnd != null) {
      const socDiv = document.createElement("div");
      let text = `${Math.round(s.socStart)} % → ${Math.round(s.socEnd)} %`;
      if (s.kwh != null) text += ` · ${s.kwh} kWh`;
      socDiv.textContent = text;
      div.appendChild(socDiv);
    }

    return div;
  },

  _parkingPopup(s) {
    const div = document.createElement("div");
    div.className = "bmw-popup-parking";

    const title = document.createElement("b");
    title.textContent = "P Parked";
    div.appendChild(title);

    if (s.address) {
      const addr = document.createElement("div");
      addr.className = "bmw-popup-addr";
      addr.textContent = s.address; // textContent — safe against XSS from geocoder
      div.appendChild(addr);
    }

    const arr     = this._fmtTime(s.start);
    const dep     = s.end ? this._fmtTime(s.end) : "ongoing";
    const dur     = this._fmtDuration(s.start, s.end);
    const durPart = dur ? ` (${dur})` : "";
    const timeDiv = document.createElement("div");
    timeDiv.textContent = `${arr} → ${dep}${durPart}`;
    div.appendChild(timeDiv);

    return div;
  },

  suspend() {
    // Nothing to do — Leaflet renders once and stays valid when hidden
  },

  resume() {
    if (this._map) this._map.invalidateSize();
  },
});
