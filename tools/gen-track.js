#!/usr/bin/env node
"use strict";

/**
 * Generate a realistic GPS track from a routed road path.
 *
 * Geocodes start/end address strings via Nominatim, routes them with OSRM,
 * then outputs { meta, track } where track points have no timestamps — the
 * INJECT_TEST_TRACK handler assigns fresh timestamps at inject time so the
 * file never expires and can be committed to version control.
 *
 * Usage:
 *   node tools/gen-track.js
 *   node tools/gen-track.js --from "Augsburg Hbf" --to "München Hbf"
 *   node tools/gen-track.js --output tools/example/my-route.json
 *
 * Inject into a running MagicMirror from the browser console:
 *   const d = await fetch('/path/to/route.json').then(r => r.json());
 *   MM.getModules().withClass('MMM-BMWCarDataInfo')[0]
 *     .sendSocketNotification('INJECT_TEST_TRACK', { track: d.track });
 */

const https = require("node:https");
const fs    = require("node:fs");
const path  = require("node:path");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

const FROM_ADDR   = arg("--from")   ?? "München Hauptbahnhof, Bayern";
const TO_ADDR     = arg("--to")     ?? "Nürnberg Hauptbahnhof, Bayern";
const OUTPUT_FILE = arg("--output") ?? null;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "MMM-BMWCarData/gen-track" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
      });
    }).on("error", reject);
  });
}

// ── Geo helpers ───────────────────────────────────────────────────────────────

function haversineM(a, b) {
  const R  = 6_371_000;
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dφ = ((b.lat - a.lat) * Math.PI) / 180;
  const dλ = ((b.lon - a.lon) * Math.PI) / 180;
  const x  = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function bearing(a, b) {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dλ = ((b.lon - a.lon) * Math.PI) / 180;
  const y   = Math.sin(dλ) * Math.cos(φ2);
  const x   = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function geocode(address) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const results = await get(url);
  if (!results.length) throw new Error(`Geocode failed for: "${address}"`);
  const { lat, lon } = results[0];
  process.stderr.write(`  geocoded "${address}" → ${lat}, ${lon}\n`);
  return { lat: Number.parseFloat(lat), lon: Number.parseFloat(lon) };
}

async function route(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
  const data = await get(url);
  if (data.code !== "Ok") throw new Error(`OSRM error: ${data.code}`);
  const leg = data.routes[0];
  process.stderr.write(`  route: ${(leg.distance / 1000).toFixed(1)} km, ${Math.round(leg.duration / 60)} min, ${leg.geometry.coordinates.length} points\n`);
  return { coords: leg.geometry.coordinates, distanceM: leg.distance, durationSec: leg.duration };
}

function buildTrack(coords, durationSec) {
  const n = coords.length;

  // Cumulative distances between consecutive points
  const dist = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    dist[i] = dist[i-1] + haversineM(
      { lat: coords[i-1][1], lon: coords[i-1][0] },
      { lat: coords[i][1],   lon: coords[i][0]   }
    );
  }
  const totalDist  = dist[n - 1];
  const avgSpeedMs = totalDist / durationSec;

  // Speed in m/s at each point (sinusoidal variation ±25% over 3 cycles)
  const speedMs = coords.map((_, i) => {
    const phase = (dist[i] / totalDist) * 6 * Math.PI;
    return avgSpeedMs * (1 + 0.25 * Math.sin(phase));
  });

  const track = [];
  for (let i = 0; i < n; i++) {
    const lat = coords[i][1];
    const lon = coords[i][0];

    let hdg;
    if (i < n - 1) {
      hdg = bearing({ lat, lon }, { lat: coords[i+1][1], lon: coords[i+1][0] });
    } else {
      hdg = track.at(-1)?.heading ?? 0;
    }

    // dt: seconds since the previous point, derived from segment distance and local speed.
    // First point is always 0. This is what makes timing accurate across dense city segments
    // and sparse highway segments — rather than distributing total duration evenly.
    const segDistM = i === 0 ? 0 : dist[i] - dist[i-1];
    const dt       = i === 0 ? 0 : Math.round((segDistM / speedMs[i-1]) * 10) / 10;

    track.push({ lat, lon, speed: Math.round(speedMs[i] * 3.6 * 10) / 10, heading: Math.round(hdg), dt });
  }
  return track;
}

(async () => {
  try {
    process.stderr.write(`Generating track: "${FROM_ADDR}" → "${TO_ADDR}"\n`);
    const [from, to]                   = await Promise.all([geocode(FROM_ADDR), geocode(TO_ADDR)]);
    const { coords, distanceM, durationSec } = await route(from, to);
    const track                        = buildTrack(coords, durationSec);
    process.stderr.write(`  generated ${track.length} track points\n`);

    const output = {
      meta: {
        from: FROM_ADDR,
        to: TO_ADDR,
        distanceKm: Math.round(distanceM / 100) / 10,
        durationSec: Math.round(durationSec),
        points: track.length,
      },
      track,
    };

    const json = JSON.stringify(output, null, 2);
    if (OUTPUT_FILE) {
      fs.mkdirSync(path.dirname(path.resolve(OUTPUT_FILE)), { recursive: true });
      fs.writeFileSync(OUTPUT_FILE, json);
      process.stderr.write(`  written to ${OUTPUT_FILE}\n`);
    } else {
      process.stdout.write(json + "\n");
    }
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
})();
