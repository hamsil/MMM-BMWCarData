"use strict";

const mqtt = require("mqtt");
const { TIMINGS } = require("./constants");

const DEFAULT_HOST = "customer.streaming-cardata.bmwgroup.com";
const DEFAULT_PORT = 9000;

class BMWMqttClient {
  #gcid; #idToken; #host; #port;
  #onConnected; #onError;
  #handlers    = new Map(); // vin → onMessage callback
  #client      = null;
  #connected   = false;
  #intentional = false;
  #retryDelay  = TIMINGS.MQTT_RETRY_INITIAL_MS;
  #retryTimer  = null;

  /**
   * One MQTT connection per BMW account (GCID). BMW's broker allows only one
   * simultaneous session per GCID, so all VINs on the same account share this client.
   *
   * @param {object}   opts
   * @param {string}   opts.gcid          GCID from token response — MQTT username
   * @param {string}   opts.idToken       MQTT password (id_token, rotates ~1 h)
   * @param {string}   [opts.host]        Override broker hostname
   * @param {number}   [opts.port]        Override broker port
   * @param {Function} [opts.onConnected] (vin: string) => void — called once per subscribed VIN
   * @param {Function} [opts.onError]     (err: Error) => void
   */
  constructor(opts) {
    this.#gcid        = opts.gcid;
    this.#idToken     = opts.idToken;
    this.#host        = opts.host ?? DEFAULT_HOST;
    this.#port        = opts.port ?? DEFAULT_PORT;
    this.#onConnected = opts.onConnected ?? (() => {});
    this.#onError     = opts.onError ?? ((e) => console.error("[BMW MQTT]", e));
  }

  /** True when at least one VIN is registered. */
  get hasVins() { return this.#handlers.size > 0; }

  /**
   * Register a VIN. If the connection is already up, subscribes immediately.
   * Safe to call before connect().
   */
  addVin(vin, onMessage) {
    this.#handlers.set(vin, onMessage);
    if (this.#connected && this.#client) {
      this.#client.subscribe(`${this.#gcid}/${vin}`, { qos: 1 }, (err) => {
        if (err) this.#onError(new Error(`Subscribe ${vin} failed: ${err.message}`));
        else this.#onConnected(vin);
      });
    }
  }

  /** Unregister a VIN and unsubscribe from its topic. */
  removeVin(vin) {
    this.#handlers.delete(vin);
    if (this.#client) this.#client.unsubscribe(`${this.#gcid}/${vin}`);
  }

  connect() {
    if (this.#client) {
      this.#client.removeAllListeners();
      this.#client.end(true);
      this.#client = null;
    }

    this.#intentional = false;
    this.#connected   = false;
    this.#client = mqtt.connect(`mqtts://${this.#host}:${this.#port}`, {
      protocolVersion:    5,
      username:           this.#gcid,
      password:           this.#idToken,
      clientId:           `MMM-BMWCarData-${this.#gcid.slice(0, 8)}`,
      rejectUnauthorized: true,
      reconnectPeriod:    0,
      connectTimeout:     30_000,
      keepalive:          30,
    });

    this.#client.on("connect", () => {
      this.#connected  = true;
      this.#retryDelay = TIMINGS.MQTT_RETRY_INITIAL_MS;
      const topics = [...this.#handlers.keys()].map(vin => `${this.#gcid}/${vin}`);
      if (topics.length === 0) return;
      console.log(`[BMW MQTT] Connected – subscribing to ${topics.join(", ")}`);
      this.#client.subscribe(topics, { qos: 1 }, (err) => {
        if (err) { this.#onError(new Error(`Subscribe failed: ${err.message}`)); return; }
        for (const vin of this.#handlers.keys()) this.#onConnected(vin);
      });
    });

    this.#client.on("message", (topic, buf) => {
      const vin     = topic.split("/")[1];
      const handler = this.#handlers.get(vin);
      if (!handler) return;
      try {
        handler(JSON.parse(buf.toString()));
      } catch (e) {
        console.warn("[BMW MQTT] Unparseable message:", e.message);
      }
    });

    this.#client.on("error", (err) => this.#onError(err));

    this.#client.on("close", () => {
      this.#connected = false;
      if (this.#intentional) {
        console.log("[BMW MQTT] Connection closed (intentional).");
        return;
      }
      console.warn(`[BMW MQTT] Unexpected disconnect – retrying in ${this.#retryDelay / 1000} s…`);
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        this.connect();
      }, this.#retryDelay);
      this.#retryDelay = Math.min(this.#retryDelay * 2, TIMINGS.MQTT_RETRY_MAX_MS);
    });
  }

  rotateToken(newIdToken) {
    this.#idToken    = newIdToken;
    this.#retryDelay = TIMINGS.MQTT_RETRY_INITIAL_MS;
    this.disconnect();
    this.connect();
  }

  disconnect() {
    this.#intentional = true;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#client) {
      this.#client.removeAllListeners();
      this.#client.end(true);
      this.#client = null;
    }
  }
}

module.exports = { BMWMqttClient };
