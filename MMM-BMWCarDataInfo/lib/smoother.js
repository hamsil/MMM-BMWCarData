"use strict";

// 2-D constant-velocity Kalman filter for GPS track smoothing.
//
// State vector: [lat, lon, vLat, vLon]
// Observation:  [lat, lon]
//
// The filter removes GPS jitter while preserving real motion and provides
// estimated heading + speed even when those descriptors aren't available.

const DEG_PER_M_LAT = 1 / 111_320; // 1 m in degrees latitude

class KalmanSmoother {
  #q; #r;
  #state = null;   // [lat, lon, vLat, vLon]
  #P     = null;   // 4×4 covariance as Float64Array (row-major)
  #lastT = null;

  constructor({ processNoise = 1e-4, measurementNoise = 1e-5 } = {}) {
    this.#q = processNoise;
    this.#r = measurementNoise;
  }

  // ── Private matrix helpers (operate on Float64Array(16)) ──────────────────

  #I4() {
    const m = new Float64Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  }

  // 4×4 matrix multiply
  #mm(A, B) {
    const C = new Float64Array(16);
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        for (let k = 0; k < 4; k++)
          C[r*4+c] += A[r*4+k] * B[k*4+c];
    return C;
  }

  // 4×4 matrix transpose
  #T(A) {
    const B = new Float64Array(16);
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        B[c*4+r] = A[r*4+c];
    return B;
  }

  // Element-wise addition (returns same typed array type as A)
  #add(A, B) { return A.map((v, i) => v + B[i]); }

  /**
   * Feed a new GPS observation. Returns smoothed {lat, lon, speed, heading}.
   * @param {number} lat
   * @param {number} lon
   * @param {number} timestamp  Unix ms
   */
  update(lat, lon, timestamp) {
    if (this.#state === null) {
      this.#state = [lat, lon, 0, 0];
      this.#P     = this.#I4().map((v) => v * 1e-3);
      this.#lastT = timestamp;
      return { lat, lon, speed: 0, heading: 0 };
    }

    const dt = Math.max((timestamp - this.#lastT) / 1000, 0.001); // seconds
    this.#lastT = timestamp;

    // State transition matrix F (constant-velocity model)
    const F = new Float64Array([
      1, 0, dt, 0,
      0, 1, 0, dt,
      0, 0, 1,  0,
      0, 0, 0,  1,
    ]);

    // Process noise Q — discrete white noise (DWNA) rather than the standard CWNA
    // (which uses dt⁴/4, dt³/2, dt²). Chosen because GPS at typical driving speeds
    // changes direction gradually enough that the higher-order covariance terms
    // provide no benefit while complicating tuning.
    const dt2 = dt * dt;
    const Q = new Float64Array([
      this.#q*dt2, 0, this.#q*dt, 0,
      0, this.#q*dt2, 0, this.#q*dt,
      this.#q*dt, 0, this.#q, 0,
      0, this.#q*dt, 0, this.#q,
    ]);

    // --- Predict ---
    const xPred = [
      this.#state[0] + dt * this.#state[2],
      this.#state[1] + dt * this.#state[3],
      this.#state[2],
      this.#state[3],
    ];
    const PPred = this.#add(this.#mm(this.#mm(F, this.#P), this.#T(F)), Q);

    // Observation matrix H (observe lat & lon only, H is 2×4)
    // Innovation covariance S = H·PPred·Hᵀ + R  (2×2)
    const S = [
      PPred[0] + this.#r, PPred[1],
      PPred[4],           PPred[5] + this.#r,
    ];
    const det  = S[0]*S[3] - S[1]*S[2];
    const Sinv = [S[3]/det, -S[1]/det, -S[2]/det, S[0]/det];

    // Kalman gain K = PPred·Hᵀ·S⁻¹  (4×2)
    // PPred·Hᵀ picks columns 0 and 1 of PPred
    const PHt = [
      PPred[0], PPred[1],
      PPred[4], PPred[5],
      PPred[8], PPred[9],
      PPred[12], PPred[13],
    ];
    const K = new Float64Array(8);
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 2; c++)
        K[r*2+c] = PHt[r*2] * Sinv[c] + PHt[r*2+1] * Sinv[2+c];

    // Innovation y = z − H·xPred
    const y = [lat - xPred[0], lon - xPred[1]];

    // Updated state
    this.#state = [
      xPred[0] + K[0]*y[0] + K[1]*y[1],
      xPred[1] + K[2]*y[0] + K[3]*y[1],
      xPred[2] + K[4]*y[0] + K[5]*y[1],
      xPred[3] + K[6]*y[0] + K[7]*y[1],
    ];

    // Updated covariance P = (I − K·H)·PPred
    const KH = new Float64Array([
      K[0], K[1], 0, 0,
      K[2], K[3], 0, 0,
      K[4], K[5], 0, 0,
      K[6], K[7], 0, 0,
    ]);
    this.#P = this.#mm(this.#I4().map((v, i) => v - KH[i]), PPred);

    // Derive speed (km/h) and heading (°) from velocity components
    const vLat   = this.#state[2];
    const vLon   = this.#state[3];
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const vNorth = vLat / DEG_PER_M_LAT;
    const vEast  = vLon / (DEG_PER_M_LAT * cosLat);
    const speedKmh = Math.hypot(vNorth, vEast) * 3.6;
    const heading  = ((Math.atan2(vEast, vNorth) * 180) / Math.PI + 360) % 360;

    return { lat: this.#state[0], lon: this.#state[1], speed: speedKmh, heading };
  }

  reset() {
    this.#state = null;
    this.#P     = null;
    this.#lastT = null;
  }
}

module.exports = { KalmanSmoother };
