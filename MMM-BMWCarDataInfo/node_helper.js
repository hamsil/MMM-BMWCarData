"use strict";

const NodeHelper = require("node_helper");
const crypto     = require("node:crypto");
const https      = require("node:https");
const fs         = require("node:fs");
const path       = require("node:path");
const { loadTokens }                = require("./lib/auth");
const { BMWMqttClient }             = require("./lib/mqttClient");
const { Store }                     = require("./lib/store");
const { KalmanSmoother }            = require("./lib/smoother");
const { StopDetectors }             = require("./lib/detectors");
const { parsePayload }              = require("./lib/descriptors");
const { Geocoder }                  = require("./lib/geocoder");
const { TokenManager }              = require("./lib/tokenManager");
const { TIMINGS, SOCKET_NOTIF }     = require("./lib/constants");

const DATA_DIR       = path.join(__dirname, "data");
const BMW_API_HOST   = "api-cardata.bmwgroup.com";
const BMW_API_PREFIX = "/customers/vehicles";

// VIN format: 17 chars, no I/O/Q per ISO 3779.
// Intentionally duplicated from MMM-BMWCarDataInfo.js — the two files run in
// different environments (Node vs browser) so they cannot share a module.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

// Factory for per-vehicle state.  Multiple front-end instances pointing at
// the same VIN share one MQTT connection and one Store.
function makeCar(vin) {
  return {
    vin,
    config:      null,
    store:       new Store(vin),
    smoother:    new KalmanSmoother(),
    detectors:   null,
    mqtt:        null,
    geocoder:    null,
    tokens:      null,
    tokenState:  null,   // shared { tokens, clientId } for this car's account
    tokenMgr:    null,   // shared TokenManager for this car's account
    pruneTimer:  null,   // interval that prunes the coord buffer
    instances:   new Set(),  // instanceIds listening to this car
    // Buffers for coordinates that arrive in separate MQTT messages (lat burst
    // then lon burst).  Keyed by exact GPS timestamp (ms); pruned on a timer.
    coordBuffer: { lats: new Map(), lons: new Map() },
  };
}

module.exports = NodeHelper.create({
  start() {
    console.log("[BMW] node_helper started.");
    this._cars          = new Map();  // vin → CarState
    this._vinByInstance = new Map();  // instanceId → vin
    this._tokenStates   = new Map();  // clientId → { tokens, clientId }
    this._tokenMgrs     = new Map();  // clientId → TokenManager
    this._mqttClients   = new Map();  // clientId → BMWMqttClient (one per account)
    this._injectToken   = this._generateInjectToken();
    this._registerTileProxy();
    this._registerImageProxy();
    this._registerTrackInjector();
  },

  stop() {
    for (const car of this._cars.values()) this._stopCar(car);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === SOCKET_NOTIF.INJECT_TEST_TRACK) {
      let track = payload?.track;
      const vin = payload?.vin;
      if (!Array.isArray(track) || track.length === 0) return;
      const car = vin ? this._cars.get(vin) : [...this._cars.values()][0];
      if (!car) return;
      // Derive absolute timestamps from per-point dt offsets when absent.
      if (track[0].t == null) track = _assignTimestamps(track);
      car.store.track = track;
      this._broadcastSnapshot(car);
      return;
    }

    if (notification !== SOCKET_NOTIF.CONFIG) return;

    const { instanceId, vin, clientId } = payload ?? {};
    if (!instanceId) return;

    // Validate required config fields early so errors surface with a clear message.
    if (!vin || !VIN_RE.test(vin)) {
      console.warn(`[BMW] Invalid or missing VIN in CONFIG from ${instanceId}`);
      this.sendSocketNotification(SOCKET_NOTIF.ERROR, {
        instanceId, message: "Invalid or missing VIN in config.",
      });
      return;
    }
    if (!clientId) {
      console.warn(`[BMW] Missing clientId in CONFIG from ${instanceId}`);
      this.sendSocketNotification(SOCKET_NOTIF.ERROR, {
        instanceId, message: "Missing clientId in config.",
      });
      return;
    }

    this._vinByInstance.set(instanceId, vin);

    if (this._cars.has(vin)) {
      this._cars.get(vin).instances.add(instanceId);
      // Send existing state immediately to the late-joining instance.
      this._broadcastTo(vin, this._cars.get(vin).store.snapshot());
      return;
    }

    const car = makeCar(vin);
    this._cars.set(vin, car);
    car.config = payload;
    car.instances.add(instanceId);
    this._initCar(car).catch((e) => console.error(`[BMW ${vin}] Init failed:`, e.message));
  },

  // ── Per-car lifecycle ──────────────────────────────────────────────────────

  async _initCar(car) {
    const cfg = car.config;
    car.store.load();
    this._pruneCoordLog(car);

    const geoEnabled = cfg.geocoder?.enabled ?? true;
    const geoContact = cfg.geocoder?.contact ?? "";
    if (geoEnabled && !geoContact) {
      console.warn(`[BMW ${car.vin}] Geocoder disabled — geocoder.contact (your email) is required by Nominatim policy. Add it to your config to enable reverse geocoding.`);
      car.geocoder = new Geocoder({ enabled: false });
    } else {
      car.geocoder = new Geocoder({ ...cfg.geocoder, locale: cfg.locale });
    }

    car.detectors = new StopDetectors({
      parkingMinMs:   (cfg.parkingMinMinutes ?? 10) * 60 * 1000,
      parkingRadiusM: 25,
      onChargingStop: async (stop) => {
        if (car.geocoder && stop.lat != null) {
          stop.address = await car.geocoder.lookup(stop.lat, stop.lon)
            .catch(() => undefined);
        }
        car.store.addChargingStop(stop);
        car.store.scheduleSave();
        this._broadcastSnapshot(car);
      },
      onParkingStop: async (stop) => {
        if (car.geocoder && stop.lat != null) {
          stop.address = await car.geocoder.lookup(stop.lat, stop.lon)
            .catch(() => undefined);
        }
        car.store.addParkingStop(stop);
        car.store.scheduleSave();
        this._broadcastSnapshot(car);
      },
    });

    const clientId = cfg.clientId;
    let tokenState = this._tokenStates.get(clientId);
    if (!tokenState) {
      const tokens = loadTokens(path.join(DATA_DIR, `tokens-${clientId}.json`));
      if (!tokens) {
        console.warn(`[BMW] No tokens for clientId ${clientId}. Run \`node tools/login.js\` first.`);
        this._sendError(car, "No tokens. Run `node tools/login.js` first.");
        return;
      }
      tokenState = { tokens, clientId };
      this._tokenStates.set(clientId, tokenState);
      this._tokenMgrs.set(clientId,
        new TokenManager(tokenState, DATA_DIR, (msg) => this._sendErrorForClient(clientId, msg)));
    }
    car.tokenState = tokenState;
    car.tokens     = tokenState.tokens;
    car.tokenMgr   = this._tokenMgrs.get(clientId);

    // Prune the coordinate match-buffer on a timer instead of on every message.
    car.pruneTimer = setInterval(() => {
      const cutoff = Date.now() - TIMINGS.COORD_BUFFER_MAX_AGE_MS;
      for (const k of car.coordBuffer.lats.keys()) if (k < cutoff) car.coordBuffer.lats.delete(k);
      for (const k of car.coordBuffer.lons.keys()) if (k < cutoff) car.coordBuffer.lons.delete(k);
    }, TIMINGS.COORD_BUFFER_PRUNE_INTERVAL_MS);

    await this._connectCar(car);
    await this._fetchVehicleData(car);
    this._broadcastSnapshot(car);
  },

  async _connectCar(car) {
    const tok = car.tokens;
    if (!tok?.gcid || !tok?.idToken) {
      console.error(`[BMW ${car.vin}] Token data incomplete.`);
      return;
    }

    // If the id_token is already expired (or expires within the refresh-ahead
    // window), do a token refresh now before attempting to connect.  This
    // handles the common case where MagicMirror is restarted with a stale
    // token file.
    const remaining = car.tokenMgr.remainingSecs();
    if (remaining < TIMINGS.TOKEN_REFRESH_AHEAD_MS / 1000) {
      console.log(`[BMW ${car.vin}] Token expires in ${remaining}s — refreshing before connecting…`);
      const ok = await car.tokenMgr.refresh();
      if (!ok) return; // error already reported by tokenMgr
      this._syncTokensForClient(car.config.clientId);
      console.log(`[BMW ${car.vin}] Token refreshed proactively.`);
    }

    const activeTok = car.tokens;
    const clientId  = car.config.clientId;

    // BMW's broker allows only one MQTT session per GCID. All VINs on the same
    // account share one BMWMqttClient; each VIN gets its own topic subscription.
    let mqttClient = this._mqttClients.get(clientId);
    if (!mqttClient) {
      mqttClient = new BMWMqttClient({
        gcid:    activeTok.gcid,
        idToken: activeTok.idToken,
        host:    car.config.mqttHost || undefined,
        port:    car.config.mqttPort || undefined,
        onConnected: (vin) => {
          const c = this._cars.get(vin);
          if (!c) return;
          console.log(`[BMW ${vin}] Connected.`);
          this._sendToInstances(c, SOCKET_NOTIF.CONNECTED, {});
        },
        onError: (err) => {
          console.error(`[BMW ${clientId}] MQTT error:`, err.message);
          this._sendErrorForClient(clientId, err.message);
        },
      });
      this._mqttClients.set(clientId, mqttClient);
      mqttClient.connect();
    }

    mqttClient.addVin(car.vin, (msg) => this._handleMessage(car, msg));
    car.mqtt = mqttClient;

    // scheduleRefresh is called only once per account — the first car sets up the
    // timer; subsequent VINs reuse it.  One rotateToken call reconnects all VINs.
    const alreadyScheduled = this._carsForClientId(clientId)
      .some(c => c !== car && c.mqtt);
    if (!alreadyScheduled) {
      car.tokenMgr.scheduleRefresh(car.tokenMgr.remainingSecs(), (newIdToken) => {
        this._syncTokensForClient(clientId);
        this._mqttClients.get(clientId)?.rotateToken(newIdToken);
      });
    }
  },

  _stopCar(car) {
    if (car.pruneTimer) { clearInterval(car.pruneTimer); car.pruneTimer = null; }

    const clientId   = car.config?.clientId;
    const mqttClient = clientId ? this._mqttClients.get(clientId) : null;
    if (mqttClient) {
      mqttClient.removeVin(car.vin);
      if (!mqttClient.hasVins) {
        mqttClient.disconnect();
        this._mqttClients.delete(clientId);
      }
    }

    const isLastForClient = clientId
      && !this._carsForClientId(clientId).some(c => c !== car);
    if (isLastForClient) {
      this._tokenMgrs.get(clientId)?.cancelRefresh();
      this._tokenMgrs.delete(clientId);
      this._tokenStates.delete(clientId);
    }

    car.store.close();
  },

  // ── Message handling ───────────────────────────────────────────────────────

  _handleMessage(car, payload) {
    const rawData = payload?.data;
    if (!rawData || typeof rawData !== "object") return;

    const now = Date.now();

    // Record ALL topic paths for discovery
    for (const [topicPath, entry] of Object.entries(rawData)) {
      const val = (entry && typeof entry === "object") ? (entry.value ?? entry) : entry;
      car.store.observeTopic(topicPath, val, now);
    }

    const patch = parsePayload(rawData);

    this._smoothGps(car, patch);

    car.store.updateLatest({ ...patch, updatedAt: now });
    this._handlePosition(car, patch, now);
    car.detectors.update({ ...car.store.latest, timestamp: now });
    car.store.scheduleSave();
    this._broadcastSnapshot(car);
  },

  _smoothGps(car, patch) {
    const patchCoords = patch.coordinates;
    delete patch.coordinates;

    const rawLat = patchCoords?.lat ?? patch.lat ?? null;
    const rawLon = patchCoords?.lon ?? patch.lon ?? null;
    const latTs  = _tsMs(patch.coordinatesAt ?? patch.latAt)  ?? (rawLat === null ? null : Date.now());
    const lonTs  = _tsMs(patch.coordinatesAt ?? patch.lonAt)  ?? (rawLon === null ? null : Date.now());

    // Clear coordinates from patch — they will only be set back if a matched
    // lat+lon pair is found (directly or via the buffer).
    delete patch.lat;
    delete patch.lon;

    const wallMs = Date.now();
    if (rawLat !== null) this._appendCoordLog(car, "lat", wallMs, latTs, rawLat);
    if (rawLon !== null) this._appendCoordLog(car, "lon", wallMs, lonTs, rawLon);

    if (rawLat !== null) car.coordBuffer.lats.set(latTs, rawLat);
    if (rawLon !== null) car.coordBuffer.lons.set(lonTs, rawLon);

    // Use the most recently arrived coordinate as the trigger; search the
    // opposite buffer for the nearest timestamp within the tolerance window.
    // This prevents the "stranded + wrong-bucket match" bug: at high speeds a
    // 3-second bucket would allow matching a lat from one GPS fix with a lon
    // from a fix ~3 s (and ~160 m) later.  With exact timestamps and a 500 ms
    // window that error is ≤ 28 m at 200 km/h.
    const triggerTs = lonTs ?? latTs;
    if (triggerTs === null) return;

    const tol    = TIMINGS.COORD_MATCH_TOLERANCE_MS;
    const latKey = rawLon === null ? latTs : _findNearest(car.coordBuffer.lats, triggerTs, tol);
    const lonKey = rawLon === null ? _findNearest(car.coordBuffer.lons, triggerTs, tol) : lonTs;

    if (latKey !== null && lonKey !== null) {
      const lat = car.coordBuffer.lats.get(latKey);
      const lon = car.coordBuffer.lons.get(lonKey);
      car.coordBuffer.lats.delete(latKey);
      car.coordBuffer.lons.delete(lonKey);
      this._applyCoordPair(car, patch, lat, lon, Math.round((latKey + lonKey) / 2));
    }
    // Buffer pruning is handled by car.pruneTimer (set in _initCar).
  },

  _applyCoordPair(car, patch, lat, lon, ts) {
    const smoothed = car.smoother.update(lat, lon, ts);
    if (Number.isFinite(smoothed.lat) && Number.isFinite(smoothed.lon)) {
      patch.lat = smoothed.lat;
      patch.lon = smoothed.lon;
      const state = car.store.latest;
      if (!Object.hasOwn(patch, "speed")   && state.speed   == null) patch.speed   = smoothed.speed;
      if (!Object.hasOwn(patch, "heading") && state.heading == null) patch.heading = smoothed.heading;
    } else {
      // Filter diverged — reset and fall back to raw coordinates
      car.smoother.reset();
      patch.lat = lat;
      patch.lon = lon;
    }
  },

  _handlePosition(car, patch, now) {
    const state   = car.store.latest;
    const fullLat = patch.lat ?? null;
    const fullLon = patch.lon ?? null;

    if (fullLat == null || fullLon == null) return;

    car.store.addTrackPoint({
      t:       Math.floor(now / 1000),
      lat:     fullLat,
      lon:     fullLon,
      speed:   patch.speed   ?? state.speed   ?? 0,
      heading: patch.heading ?? state.heading ?? 0,
    });

    if (car.geocoder) {
      car.geocoder.lookup(fullLat, fullLon)
        .then((address) => {
          car.store.updateLatest({ address });
          car.store.observeTopic("vehicle.location.address", address, Date.now());
          this._broadcastSnapshot(car);
        })
        .catch((err) => console.warn(`[BMW ${car.vin}] Geocoding failed:`, err.message));
    }
  },

  // ── Broadcast helpers ──────────────────────────────────────────────────────

  _broadcastSnapshot(car) {
    this._broadcastTo(car.vin, car.store.snapshot());
  },

  _broadcastTo(vin, snapshot) {
    const car = this._cars.get(vin);
    if (!car) return;
    for (const instanceId of car.instances) {
      this.sendSocketNotification(SOCKET_NOTIF.VEHICLE_STATE, { instanceId, ...snapshot });
    }
  },

  _sendToInstances(car, notification, payload) {
    for (const instanceId of car.instances) {
      this.sendSocketNotification(notification, { instanceId, ...payload });
    }
  },

  _sendError(car, message) {
    this._sendToInstances(car, SOCKET_NOTIF.ERROR, { message });
  },

  _carsForClientId(clientId) {
    return [...this._cars.values()].filter(c => c.config?.clientId === clientId);
  },

  _syncTokensForClient(clientId) {
    const ts = this._tokenStates.get(clientId);
    if (!ts) return;
    for (const c of this._carsForClientId(clientId)) c.tokens = ts.tokens;
  },

  _sendErrorForClient(clientId, msg) {
    for (const car of this._carsForClientId(clientId)) this._sendError(car, msg);
  },

  // ── Vehicle data (basicData + image + capabilities) — fetched once, cached ─

  async _fetchVehicleData(car) {
    await Promise.allSettled([
      this._fetchBasicData(car),
      this._fetchVehicleImage(car),
      this._fetchCapabilities(car),
    ]);
  },

  async _fetchCapabilities(car) {
    const dataFile = path.join(DATA_DIR, `capabilities-${car.vin}.json`);
    if (fs.existsSync(dataFile)) {
      console.log(`[BMW ${car.vin}] Capabilities already cached.`);
      return;
    }
    try {
      const { body } = await this._apiGet(
        this._vehicleApiPath(car.vin, "capabilities"),
        car.tokens.accessToken,
      );
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify(body, null, 2));
      console.log(`[BMW ${car.vin}] Capabilities cached.`);
    } catch (e) {
      const msg = e.message ?? "";
      if (msg.includes("HTTP 403") || msg.includes("CU-403")) {
        console.warn(`[BMW ${car.vin}] Vehicle capabilities not available.`);
      } else {
        console.warn(`[BMW ${car.vin}] Could not fetch capabilities:`, msg);
      }
    }
  },

  async _fetchBasicData(car) {
    const dataFile = path.join(DATA_DIR, `basic-data-${car.vin}.json`);
    let data;
    if (fs.existsSync(dataFile)) {
      try {
        data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
        console.log(`[BMW ${car.vin}] Loaded basic data from cache.`);
      } catch (e) {
        console.warn(`[BMW ${car.vin}] Could not read cached basicData:`, e.message);
        return;
      }
    } else {
      try {
        const { body } = await this._apiGet(
          this._vehicleApiPath(car.vin, "basicData"),
          car.tokens.accessToken,
        );
        data = body;
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
        console.log(`[BMW ${car.vin}] Fetched and cached basic data (${Object.keys(data).length} fields).`);
      } catch (e) {
        console.warn(`[BMW ${car.vin}] Could not fetch basicData:`, e.message);
        return;
      }
    }
    this._injectBasicData(car, data);
  },

  _injectBasicData(car, data) {
    if (!data || typeof data !== "object") return;
    const now = Date.now();
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && value !== undefined) {
        car.store.observeTopic(`basicdata.${key}`, value, now);
      }
    }
  },

  async _fetchVehicleImage(car) {
    let existing;
    try {
      existing = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith(`image-${car.vin}.`));
    } catch {
      existing = [];
    }
    if (existing.length > 0) {
      console.log(`[BMW ${car.vin}] Using cached vehicle image: ${existing[0]}`);
      car.store.observeTopic("image", `/MMM-BMWCarDataInfo/vehicle-image/${car.vin}`, Date.now());
      return;
    }
    try {
      const { body, contentType } = await this._apiGetBinary(
        this._vehicleApiPath(car.vin, "image"),
        car.tokens.accessToken,
      );
      let ext = "jpg";
      if (contentType?.includes("png")) ext = "png";
      else if (contentType?.includes("gif")) ext = "gif";
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, `image-${car.vin}.${ext}`), body);
      car.store.observeTopic("image", `/MMM-BMWCarDataInfo/vehicle-image/${car.vin}`, Date.now());
      console.log(`[BMW ${car.vin}] Vehicle image saved (${body.length} bytes, .${ext}).`);
    } catch (e) {
      const msg = e.message ?? "";
      if (msg.includes("HTTP 403") || msg.includes("CU-403")) {
        console.warn(`[BMW ${car.vin}] Vehicle image not available.`);
      } else {
        console.warn(`[BMW ${car.vin}] Could not fetch vehicle image:`, msg);
      }
    }
  },

  // ── API helpers ────────────────────────────────────────────────────────────

  _vehicleApiPath(vin, endpoint) {
    return `${BMW_API_PREFIX}/${vin}/${endpoint}`;
  },

  // Lightweight GET returning a parsed JSON body.
  _apiGet(apiPath, accessToken, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: BMW_API_HOST, path: apiPath, method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "x-version": "v1",
            ...extraHeaders,
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => { raw += c; });
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`BMW API GET ${apiPath} → HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
              return;
            }
            try { resolve({ body: JSON.parse(raw), headers: res.headers }); }
            catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  },

  // GET returning a raw Buffer (for binary downloads such as images).
  _apiGetBinary(apiPath, accessToken, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: BMW_API_HOST, path: apiPath, method: "GET",
          headers: { Authorization: `Bearer ${accessToken}`, ...extraHeaders },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`BMW API GET ${apiPath} → HTTP ${res.statusCode}`));
              return;
            }
            resolve({ body: Buffer.concat(chunks), contentType: res.headers["content-type"] });
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  },

  // ── Inject-track authentication ────────────────────────────────────────────
  // Generates a random bearer token once and persists it to data/inject-token.json
  // (mode 0600).  The same token is reused across restarts.

  _generateInjectToken() {
    const tokenFile = path.join(DATA_DIR, "inject-token.json");
    let token;
    try {
      token = JSON.parse(fs.readFileSync(tokenFile, "utf8")).token;
    } catch {
      token = crypto.randomBytes(32).toString("base64url");
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = tokenFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ token }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, tokenFile);
      console.log(`[BMW] Inject-track token generated → ${tokenFile}`);
    }
    console.log(`[BMW] Inject-track bearer token: ${token}`);
    return token;
  },

  // ── Track injection HTTP endpoints ────────────────────────────────────────

  _registerTrackInjector() {
    const EXAMPLE_DIR = path.join(__dirname, "..", "tools", "example");

    // Auth middleware for mutating endpoints.
    const requireInjectToken = (req, res, next) => {
      const auth = (req.headers.authorization ?? "").trim();
      if (auth === `Bearer ${this._injectToken}`) return next();
      res.status(401).json({ error: "Unauthorized" });
    };

    // Serve example track files so the browser can fetch them directly (read-only).
    this.expressApp.get("/MMM-BMWCarDataInfo/example/:file", (req, res) => {
      const file = path.basename(req.params.file); // prevent path traversal
      const filePath = path.join(EXAMPLE_DIR, file);
      if (!fs.existsSync(filePath)) { res.status(404).end(); return; }
      res.setHeader("Content-Type", "application/json");
      fs.createReadStream(filePath).pipe(res);
    });

    // POST { exampleFile?, track?, vin? } — inject a track (or [] to clear).
    this.expressApp.post("/MMM-BMWCarDataInfo/inject-track", requireInjectToken, (req, res) => {
      const process = (payload) => {
        const vin = payload?.vin;
        const car = vin ? this._cars.get(vin) : [...this._cars.values()][0];
        if (!car) { res.status(503).json({ error: "No car initialised yet" }); return; }

        let track;
        if (payload?.exampleFile) {
          const file = path.join(EXAMPLE_DIR, path.basename(payload.exampleFile));
          try {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            track = parsed?.track ?? parsed;
          } catch (e) {
            res.status(404).json({ error: `Cannot read example file: ${e.message}` }); return;
          }
        } else {
          track = payload?.track;
        }
        if (!Array.isArray(track)) { res.status(400).json({ error: "track must be an array" }); return; }

        if (track.length > 0 && track[0].t == null) track = _assignTimestamps(track);

        car.store.track = track;
        this._broadcastSnapshot(car);
        res.json({ ok: true, points: track.length });
      };

      if (req.body === undefined) {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          let payload;
          try { payload = JSON.parse(raw); }
          catch { res.status(400).json({ error: "Invalid JSON" }); return; }
          process(payload);
        });
      } else {
        process(req.body);
      }
    });
  },

  // ── Image proxy — serves cached vehicle images ─────────────────────────────

  _registerImageProxy() {
    this.expressApp.get("/MMM-BMWCarDataInfo/vehicle-image/:vin", (req, res) => {
      const { vin } = req.params;
      if (!VIN_RE.test(vin)) { res.status(400).end(); return; }
      try {
        const files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith(`image-${vin}.`));
        if (files.length === 0) { res.status(404).end(); return; }
        const ext = files[0].split(".").pop().toLowerCase();
        const MIME = { png: "image/png", gif: "image/gif" };
        const ct   = MIME[ext] ?? "image/jpeg";
        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "public, max-age=86400");
        fs.createReadStream(path.join(DATA_DIR, files[0])).pipe(res);
      } catch (e) {
        console.warn("[BMW image proxy]", e.message);
        res.status(500).end();
      }
    });
  },

  // ── Coordinate log ────────────────────────────────────────────────────────
  // Appends every raw lat/lon as it arrives from MQTT to a plain-text file in
  // data/locations-{vin}.log. Format per line:
  //   {wallMs} {field} {gpsTsMs} {value}
  // wallMs   = Date.now() when the message was processed
  // field    = "lat" or "lon"
  // gpsTsMs  = GPS timestamp from BMW (or wallMs if BMW did not provide one)
  // value    = raw coordinate value

  _appendCoordLog(car, field, wallMs, gpsTsMs, value) {
    const ts = gpsTsMs ?? wallMs;
    try {
      fs.appendFileSync(
        path.join(DATA_DIR, `locations-${car.vin}.log`),
        `${wallMs} ${field} ${ts} ${value}\n`,
      );
    } catch { /* non-critical debug log */ }
  },

  // Prune log entries older than 24 h on startup so the file stays bounded.
  _pruneCoordLog(car) {
    const logFile = path.join(DATA_DIR, `locations-${car.vin}.log`);
    const cutoff  = Date.now() - (car.config.trackHours ?? 24) * 60 * 60 * 1000;
    try {
      const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
      const kept  = lines.filter((l) => {
        const wallMs = Number(l.split(" ")[0]);
        return Number.isFinite(wallMs) && wallMs >= cutoff;
      });
      if (kept.length < lines.length) {
        fs.writeFileSync(logFile, kept.length > 0 ? `${kept.join("\n")}\n` : "");
        console.log(`[BMW ${car.vin}] Pruned coord log: ${lines.length - kept.length} old entries removed.`);
      }
    } catch (e) {
      if (e.code !== "ENOENT") console.warn(`[BMW ${car.vin}] Could not prune coord log:`, e.message);
    }
  },

  // ── Tile proxy ─────────────────────────────────────────────────────────────

  _registerTileProxy() {
    const PROVIDERS = {
      "osm":         { base: "https://%s.tile.openstreetmap.org",          subs: ["a","b","c"] },
      "carto-dark":  { base: "https://%s.basemaps.cartocdn.com/dark_all",  subs: ["a","b","c","d"] },
      "carto-light": { base: "https://%s.basemaps.cartocdn.com/light_all", subs: ["a","b","c","d"] },
    };

    this.expressApp.get("/MMM-BMWCarDataInfo/tile/:provider/:z/:x/:y.png", (req, res) => {
      const { provider, z, x, y } = req.params;
      const entry = PROVIDERS[provider];
      if (!entry) { res.status(404).end(); return; }

      const sub = entry.subs[(Number(x) + Number(y)) % entry.subs.length];
      const url = `${entry.base.replace("%s", sub)}/${z}/${x}/${y}.png`;
      https.get(url, { headers: { "User-Agent": "MMM-BMWCarData/1.0" } }, (upstream) => {
        if (upstream.statusCode !== 200) {
          res.status(upstream.statusCode).end();
          upstream.resume();
          return;
        }
        res.setHeader("Content-Type", upstream.headers["content-type"] ?? "image/png");
        res.setHeader("Cache-Control", "public, max-age=86400");
        upstream.pipe(res);
      }).on("error", (e) => {
        console.warn("[BMW tile proxy]", e.message);
        res.status(502).end();
      });
    });
  },
});

// ── Shared helpers (used in both socketNotificationReceived and HTTP handler) ─

// Normalise a timestamp to milliseconds.  BMW sends GPS timestamps as ISO-8601
// strings ("2026-05-08T12:49:55Z"); other sources may already be numeric ms.
function _tsMs(v) {
  if (v == null)             return null;
  if (typeof v === "number") return v;
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? null : ms;
}

// Return the key in `map` whose numeric value is closest to `ts` and within
// `toleranceMs`, or null if no such entry exists.
function _findNearest(map, ts, toleranceMs) {
  let bestKey  = null;
  let bestDiff = Infinity;
  for (const k of map.keys()) {
    const diff = Math.abs(k - ts);
    if (diff <= toleranceMs && diff < bestDiff) { bestDiff = diff; bestKey = k; }
  }
  return bestKey;
}

// Assign absolute timestamps to track points that carry dt offsets instead of t.
// The trip ends at now; dt=0 on the first point, subsequent points store elapsed
// seconds since the previous point.
function _assignTimestamps(track) {
  const now        = Math.floor(Date.now() / 1000);
  const totalSec   = track.reduce((s, p) => s + (p.dt ?? 0), 0);
  const tStart     = now - Math.round(totalSec);
  let   cumulative = 0;
  return track.map((p) => {
    const t = tStart + Math.round(cumulative);
    cumulative += p.dt ?? 0;
    return { t, lat: p.lat, lon: p.lon, speed: p.speed, heading: p.heading };
  });
}
