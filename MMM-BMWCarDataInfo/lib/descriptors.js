"use strict";

// Maps internal field names to BMW/MINI CarData descriptor paths.
// Only functional fields are listed here — those consumed by the stop detectors,
// GPS smoother, and map module.  All other topics are displayed directly by path
// via rawTopics and topicFormatter.js.
const DESCRIPTORS = {

  // ── Location ──────────────────────────────────────────────────────────────
  lat: {
    aliases: [
      "vehicle.cabin.infotainment.navigation.currentLocation.latitude",   // MINI ✓
      "vehicle.location.latitude",
    ],
    parse: (v) => Number.parseFloat(v),
  },
  lon: {
    aliases: [
      "vehicle.cabin.infotainment.navigation.currentLocation.longitude",  // MINI ✓
      "vehicle.location.longitude",
    ],
    parse: (v) => Number.parseFloat(v),
  },
  heading: {
    aliases: [
      "vehicle.cabin.infotainment.navigation.currentLocation.heading",    // MINI ✓
      "vehicle.location.heading",
      "vehicle.drive.heading",
      "vehicle.location.direction",
    ],
    parse: (v) => Number.parseFloat(v),
  },
  speed: {
    aliases: [
      "vehicle.drive.speed",
      "vehicle.currentSpeed",
      "vehicle.drivetrain.currentSpeed",
    ],
    parse: (v) => Number.parseFloat(v),
  },

  // ── Charging detection (used by stop detectors) ───────────────────────────
  chargingStatus: {
    aliases: [
      "vehicle.drivetrain.electricEngine.charging.status",                // MINI ✓
      "vehicle.powertrain.electric.battery.charging.status",
      "vehicle.drivetrain.batteryManagement.chargingStatus",
    ],
    // MINI values: NOCHARGING, INITIALIZATION, CHARGINGACTIVE,
    //              CHARGINGPAUSED, CHARGINGENDED, CHARGINGERROR
    parse: (v) => String(v).toUpperCase(),
  },
  soc: {
    aliases: [
      "vehicle.drivetrain.batteryManagement.header",                      // MINI ✓
      "vehicle.drivetrain.batteryManagement.stateOfCharge.displayed",
      "vehicle.drivetrain.batteryManagement.stateOfCharge",
      "vehicle.powertrain.electric.battery.stateOfCharge",
    ],
    parse: (v) => Number.parseFloat(v),
  },
  maxEnergy: {
    aliases: [
      "vehicle.drivetrain.batteryManagement.maxEnergy",
      "vehicle.powertrain.electric.battery.maxEnergy",
    ],
    parse: (v) => Number.parseFloat(v),
  },

  // ── Motion detection (used by stop detectors) ─────────────────────────────
  isMoving: {
    aliases: [
      "vehicle.isMoving",                                                  // MINI ✓
      "vehicle.motion.isMoving",
    ],
    parse: (v) => v === true || v === "true" || v === 1,
  },
};

// Build a reverse lookup: signalPath → internalField
const ALIAS_MAP = new Map();
for (const [field, def] of Object.entries(DESCRIPTORS)) {
  for (const alias of def.aliases) {
    ALIAS_MAP.set(alias.toLowerCase(), field);
  }
}

/**
 * Given a raw BMW CarData `data` object (map of signalPath → {value, timestamp}),
 * returns a normalized state patch with only the functional fields that arrived.
 */
function parsePayload(data) {
  const patch = {};
  for (const [signalPath, entry] of Object.entries(data)) {
    const field = ALIAS_MAP.get(signalPath.toLowerCase());
    if (!field) continue;
    const def = DESCRIPTORS[field];
    try {
      const parsed = def.parse(entry.value ?? entry);
      if (parsed != null && !Number.isNaN(parsed)) {
        patch[field] = parsed;
        const ts = entry.timestamp ?? entry.ts;
        if (ts) patch[`${field}At`] = ts;
      }
    } catch (e) {
      const raw = entry?.value ?? entry;
      console.warn(`[BMW descriptors] Could not parse ${field} (raw: ${JSON.stringify(raw)}):`, e.message);
    }
  }
  return patch;
}

/**
 * Returns the list of recommended descriptor paths to enable in the BMW portal.
 */
function recommendedDescriptors() {
  return Object.values(DESCRIPTORS).map((d) => d.aliases[0]);
}

module.exports = { DESCRIPTORS, ALIAS_MAP, parsePayload, recommendedDescriptors };
