"use strict";

/**
 * Smart formatter for BMW CarData MQTT topic values.
 *
 * Given a full topic path and its raw value, infers the appropriate format
 * from keywords in the path, then formats it for display.
 * No hardcoded topic list — works with any descriptor the car sends.
 *
 * Format strings use the pattern:  { <expr> [: .<N>f] } <suffix>
 *   v         — raw value
 *   v/100     — raw value divided by 100 (any +−×÷ arithmetic on v is valid)
 *   :.1f      — 1 decimal place  (:.0f = integer, :.2f = 2 decimals)
 *
 * Examples:
 *   "{v/100:.1f} bar"  →  240  → "2.4 bar"
 *   "{v:.1f} °C"       →  21.5 → "21.5 °C"
 *   "{v:.0f} km"       →  42850 → "42850 km"
 */

// Path-based rules for numeric formatting only.
// Boolean, enum, and timestamp detection is value-based (see autoFormat).
// Each entry: test – RegExp matched against the last 3 path segments joined with "."
//             format – format string (see grammar above)
const RULES = [
  // Tyre pressure: raw kPa → bar
  { test: /[Pp]ressure[Tt]arget/,                                     format: "{v/100:.1f} bar" },
  { test: /[Pp]ressure(?!Target)/,                                    format: "{v/100:.1f} bar" },

  // Temperature
  { test: /[Tt]emperature/,                                           format: "{v:.1f} °C" },

  // Speed
  { test: /[Ss]peed/,                                                 format: "{v:.0f} km/h" },

  // Energy capacity / consumption
  { test: /[Mm]ax[Ee]nergy/,                                          format: "{v:.1f} kWh" },
  { test: /[Cc]onsumption/,                                           format: "{v:.1f} kWh/100km" },
  { test: /[Rr]ecuperation/,                                          format: "{v:.1f} kWh/100km" },
  { test: /[Cc]harging.[Pp]ower/,                                     format: "{v/1000:.0f} kW" },

  // State of charge / battery level (%, must come before generic "range")
  { test: /[Ss]tate[Oo]f[Cc]harge|header$|hvSoc|[Bb]attery[Ll]evel/, format: "{v:.0f} %" },
  { test: /(?:[Ff]uel[Ll]evel.*[Pp]ercentage|fuelLevel$)/,            format: "{v:.0f} %" },

  // Range, distance, mileage (km)
  { test: /[Rr]ange|[Dd]istance|[Mm]ileage|[Tt]ravelled/,             format: "{v:.0f} km" },

  // Litres
  { test: /[Ll]itres|[Ll]iters|[Ff]uelLevel\.litre/,                  format: "{v:.1f} l" },
];

// Recursive-descent arithmetic evaluator for format expressions.
// Handles +  −  ×  ÷  parentheses with correct operator precedence.
// Returns NaN if the string contains anything that isn't a number or operator.
function _evalArith(str) {
  str = str.replaceAll(/\s/g, "");
  let pos = 0;

  function peek() { return str[pos]; }
  function consume() { return str[pos++]; }

  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      const op = peek();
      if (op !== "+" && op !== "-") break;
      consume();
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  function parseTerm() {
    let v = parseFactor();
    for (;;) {
      const op = peek();
      if (op !== "*" && op !== "/") break;
      consume();
      const r = parseFactor();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }

  function parseFactor() {
    if (peek() === "(") {
      consume();
      const v = parseExpr();
      if (peek() === ")") consume();
      return v;
    }
    let sign = 1;
    if      (peek() === "-") { consume(); sign = -1; }
    else if (peek() === "+")   consume();
    const start = pos;
    while (pos < str.length && (str[pos] === "." || (str[pos] >= "0" && str[pos] <= "9"))) pos++;
    if (pos === start) return Number.NaN;
    return sign * Number(str.slice(start, pos));
  }

  const result = parseExpr();
  return pos === str.length ? result : Number.NaN;
}

/**
 * Apply a format string to a raw numeric value.
 * Grammar:  { <expr> [: .<N>f] } <suffix>
 *   expr may contain: v, digits, whitespace, +  -  *  /  .  ( )
 */
function applyFormat(format, rawValue) {
  return format.replaceAll(/\{([^}]+)\}/g, (_, expr) => {
    const colonIdx = expr.lastIndexOf(":");
    let valueExpr = expr;
    let decimals  = null;
    if (colonIdx > -1 && /^\.\d+f$/.test(expr.slice(colonIdx + 1))) {
      valueExpr = expr.slice(0, colonIdx);
      decimals  = Number.parseInt(expr.slice(colonIdx + 2), 10);
    }
    const v    = Number(rawValue);
    const safe = valueExpr.replaceAll(/\bv\b/g, String(v));
    if (/[^\d\s+\-*/.()]/.test(safe)) return "?";
    const computed = _evalArith(safe);
    if (!Number.isFinite(computed)) return "?";
    if (decimals != null) return computed.toFixed(decimals);
    return Number.isInteger(computed) ? String(computed) : computed.toFixed(2);
  });
}

// Cache of topicPath → matched RULE (or null if no rule matched).
// Avoids re-testing all 20+ regexes for paths we have seen before.
const _ruleCache = new Map();

/**
 * Format a topic value for display.
 *
 * @param {string} topicPath  Full descriptor path, e.g. "vehicle.chassis.axle.row1.wheel.left.tire.pressure"
 * @param {*}      value      Raw value from MQTT
 * @param {string} [locale]   BCP-47 locale for timestamp/number formatting
 * @param {object} [overrides] Optional per-topic override: { format: "{v/100:.1f} bar" }
 * @returns {string}          Human-readable string
 */
function formatValue(topicPath, value, locale = "en-US", overrides = null, translate = null) {
  if (value === null || value === undefined) return "—";

  if (overrides?.format != null) return applyFormat(overrides.format, value);

  // Cache lookup: undefined = not yet cached, null = no rule matched
  let rule = _ruleCache.get(topicPath);
  if (rule === undefined) {
    const tail = topicPath.split(".").slice(-3).join(".");
    rule = RULES.find((r) => r.test.test(tail)) ?? null;
    _ruleCache.set(topicPath, rule);
  }

  if (rule) return applyRule(rule, value);
  return autoFormat(value, locale, translate, topicPath);
}

function applyRule(rule, rawValue) {
  return applyFormat(rule.format, rawValue);
}

// Shared translation lookup for enum strings and booleans.
// Returns the translated string, or null if no translation is registered.
function _translateEnum(value, translate, topicPath) {
  if (translate && topicPath) {
    const key = `topic.${topicPath}.${value}`;
    const t = translate(key);
    if (t !== key) return t;
  }
  return null;
}

function autoFormat(value, locale, translate, topicPath) {
  if (typeof value === "boolean") return formatBoolean(value, translate, topicPath);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    return Number.isInteger(value)
      ? value.toLocaleString(locale)
      : value.toFixed(2);
  }

  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return formatTimestamp(value, locale);
    // ALL_CAPS_WITH_UNDERSCORES → translation lookup (enum values like CHARGINGACTIVE)
    if (/^[A-Z][A-Z0-9_]*$/.test(value)) {
      const t = _translateEnum(value, translate, topicPath);
      if (t !== null) return t;
    }
    return value;
  }

  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatBoolean(v, translate, topicPath) {
  const b = v === true || v === "true" || v === 1 || v === "1";
  return _translateEnum(b ? "true" : "false", translate, topicPath) ?? (b ? "Yes" : "No");
}

function formatTimestamp(v, locale) {
  const d = new Date(typeof v === "number" ? v * 1000 : v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString(locale ?? [], { dateStyle: "short", timeStyle: "short" });
}

/**
 * Generate a short human-readable label from a topic path.
 * e.g. "vehicle.chassis.axle.row1.wheel.left.tire.pressure" → "Row1 Left Pressure"
 */
function labelFromPath(topicPath) {
  const segments = topicPath.split(".");
  // Drop boring namespace segments
  const skip = new Set(["vehicle", "cabin", "infotainment", "navigation",
    "powertrain", "drivetrain", "chassis", "body", "currentLocation"]);
  const kept = segments.filter((s) => !skip.has(s));
  // Take the last 3 meaningful segments
  return kept.slice(-3).map(titleCase).join(" ");
}

function titleCase(s) {
  return s
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^[\s\S]/, (c) => c.toUpperCase());
}

// Works in Node.js (module.exports) AND in the browser (globalThis),
// because MagicMirror loads this file as a plain <script> tag.
if (typeof module === "undefined") {
  globalThis.bmwTopicFormatter = { formatValue, labelFromPath };
} else {
  module.exports = { formatValue, labelFromPath };
}
