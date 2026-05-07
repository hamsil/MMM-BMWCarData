"use strict";

/** Timing constants — all values in milliseconds. */
const TIMINGS = {
  TOKEN_REFRESH_AHEAD_MS:         5 * 60_000,  // refresh this far before expiry
  TOKEN_REFRESH_MIN_DELAY_MS:     30_000,       // floor for the scheduled-refresh delay
  TOKEN_REFRESH_RETRY_DELAY_MS:   2 * 60_000,  // retry delay after a failed refresh
  COORD_BUFFER_PRUNE_INTERVAL_MS: 10_000,       // how often to prune the coord buffer
  COORD_BUFFER_MAX_AGE_MS:        30_000,       // discard coord entries older than this
  MQTT_RETRY_INITIAL_MS:          5_000,
  MQTT_RETRY_MAX_MS:              5 * 60_000,
};

/**
 * Socket notification names shared between the front-end modules and node_helper.
 * Centralising them here prevents silent breakage from typos.
 */
const SOCKET_NOTIF = {
  CONFIG:            "CONFIG",
  VEHICLE_STATE:     "VEHICLE_STATE",
  ERROR:             "ERROR",
  CONNECTED:         "CONNECTED",
  INJECT_TEST_TRACK: "INJECT_TEST_TRACK",
};

module.exports = { TIMINGS, SOCKET_NOTIF };
