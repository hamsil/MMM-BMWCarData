"use strict";

// Haversine distance in metres between two {lat,lon} points
function haversine(a, b) {
  const R  = 6_371_000;
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dφ = ((b.lat - a.lat) * Math.PI) / 180;
  const dλ = ((b.lon - a.lon) * Math.PI) / 180;
  const x  = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Charging status values that mean a session is open (MINI values listed first)
const CHARGING_STATES = new Set([
  "CHARGINGACTIVE", "INITIALIZATION", "CHARGINGPAUSED",
  "CHARGING", "CHARGING_ACTIVE", "CHARGE_NOW", "IMMEDIATE_CHARGING",
  "PENDING_FOR_CHARGING", "WAITING_FOR_CHARGING",
]);

// Status values that definitively end a charging session
const CHARGING_ENDED_STATES = new Set([
  "NOCHARGING", "CHARGINGENDED", "CHARGINGERROR",
  "NOT_CHARGING", "ERROR",
]);

class StopDetectors {
  #parkingMinMs;
  #parkingRadiusM;
  #onCharging;
  #onParking;
  #chargingStop = null;
  #parkingStop  = null;
  #lastCoords   = null;

  /**
   * @param {object}   opts
   * @param {number}   opts.parkingMinMs     Minimum stationary time for a parking stop (ms)
   * @param {number}   opts.parkingRadiusM   Max move distance before stop is ended (m)
   * @param {Function} opts.onChargingStop   ({start,end,lat,lon,socStart,socEnd,kwh}) => void
   * @param {Function} opts.onParkingStop    ({start,end,lat,lon}) => void
   */
  constructor(opts) {
    this.#parkingMinMs   = opts.parkingMinMs   ?? 10 * 60 * 1000;
    this.#parkingRadiusM = opts.parkingRadiusM ?? 25;
    this.#onCharging     = opts.onChargingStop ?? (() => {});
    this.#onParking      = opts.onParkingStop  ?? (() => {});
  }

  /**
   * Process a new state patch from the MQTT payload.
   * @param {object} state  Normalized vehicle state (from descriptors + smoother)
   */
  update(state) {
    const now = state.timestamp ?? Date.now();
    const ts  = Math.floor(now / 1000);

    this.#detectCharging(state, ts);
    this.#detectParking(state, now, ts);

    return {
      openCharging: this.#chargingStop ? { ...this.#chargingStop } : null,
      openParking:  this.#parkingStop  ? { ...this.#parkingStop  } : null,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  #detectCharging(state, ts) {
    const cs = state.chargingStatus;
    if (cs == null) return;

    if (CHARGING_STATES.has(cs) && this.#chargingStop == null) {
      this.#openChargingStop(state, ts);
      return;
    }
    if (CHARGING_ENDED_STATES.has(cs) && this.#chargingStop != null) {
      this.#closeChargingStop(state, ts);
    }
  }

  #openChargingStop(state, ts) {
    this.#chargingStop = {
      start:    ts,
      end:      null,
      lat:      state.lat ?? state.coordinates?.lat,
      lon:      state.lon ?? state.coordinates?.lon,
      socStart: state.soc ?? null,
      socEnd:   null,
      kwh:      null,
    };
  }

  #closeChargingStop(state, ts) {
    const stop = this.#chargingStop;
    stop.end    = ts;
    stop.socEnd = state.soc ?? null;

    if (stop.socStart != null && stop.socEnd != null && state.maxEnergy != null) {
      stop.kwh = Number.parseFloat(
        ((stop.socEnd - stop.socStart) / 100 * state.maxEnergy).toFixed(2)
      );
    }

    this.#onCharging(stop);
    this.#chargingStop = null;

    // End any coincident parking stop
    if (this.#parkingStop != null) {
      this.#parkingStop.end = ts;
      this.#onParking(this.#parkingStop);
      this.#parkingStop = null;
    }
  }

  #detectParking(state, now, ts) {
    const coords = state.coordinates
      ?? (state.lat == null ? null : { lat: state.lat, lon: state.lon });
    if (coords == null) return;

    const isMoving      = this.#resolveMoving(state, coords);
    const activeCharging = this.#chargingStop != null
      || CHARGING_STATES.has(state.chargingStatus ?? "");

    if (isMoving) {
      this.#closeOpenParking(now, ts);
    } else if (!activeCharging) {
      this.#maybeOpenParking(coords, now, ts);
    }
    // else: stationary but charging — not a parking stop

    this.#lastCoords = coords;
  }

  #resolveMoving(state, coords) {
    if (state.isMoving != null) return state.isMoving;
    if (state.speed != null && state.speed > 3) return true;
    if (this.#lastCoords != null) {
      return haversine(this.#lastCoords, coords) > this.#parkingRadiusM;
    }
    return false;
  }

  #closeOpenParking(now, ts) {
    if (this.#parkingStop == null) return;
    const elapsed = now - this.#parkingStop.startMs;
    if (elapsed >= this.#parkingMinMs) {
      this.#parkingStop.end = ts;
      this.#onParking(this.#parkingStop);
    }
    this.#parkingStop = null;
  }

  #maybeOpenParking(coords, now, ts) {
    if (this.#parkingStop != null) return;
    this.#parkingStop = {
      start:   ts,
      startMs: now,
      end:     null,
      lat:     coords.lat,
      lon:     coords.lon,
    };
  }
}

module.exports = { StopDetectors, haversine };
