#!/usr/bin/env node
"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const vendorDir = path.join(root, "MMM-BMWCarDataMap", "vendor");

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  copied ${path.relative(root, dest)}`);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : copyFile(s, d);
  }
}

console.log("[postinstall] Vendoring Leaflet assets into MMM-BMWCarDataMap/vendor/ …");

const nodeModules = path.join(root, "node_modules");

// Leaflet dist
const leafletSrc = path.join(nodeModules, "leaflet", "dist");
if (fs.existsSync(leafletSrc)) {
  copyDir(leafletSrc, path.join(vendorDir, "leaflet"));
} else {
  console.warn("  WARNING: leaflet not found in node_modules (install with --include=dev)");
}

// leaflet-hotline dist
const hotlineSrc = path.join(nodeModules, "leaflet-hotline", "dist");
const hotlineSrcAlt = path.join(nodeModules, "leaflet-hotline");
if (fs.existsSync(hotlineSrc)) {
  copyDir(hotlineSrc, path.join(vendorDir, "leaflet-hotline"));
} else if (fs.existsSync(hotlineSrcAlt)) {
  for (const f of ["leaflet.hotline.js", "leaflet.hotline.min.js"]) {
    const s = path.join(hotlineSrcAlt, f);
    if (fs.existsSync(s)) copyFile(s, path.join(vendorDir, "leaflet-hotline", f));
  }
} else {
  console.warn("  WARNING: leaflet-hotline not found in node_modules (install with --include=dev)");
}

// json-logic-js browser build — append a globalThis fallback so jsonLogic is
// available even in Electron renderers where nodeIntegration causes the library
// to take the CommonJS path (module.exports) instead of setting window.jsonLogic.
const jlSrc  = path.join(nodeModules, "json-logic-js", "logic.js");
const jlDest = path.join(root, "MMM-BMWCarDataInfo", "vendor", "json-logic.js");
if (fs.existsSync(jlSrc)) {
  const content = fs.readFileSync(jlSrc, "utf8") +
    "\nif (typeof globalThis.jsonLogic === 'undefined' && typeof module !== 'undefined') {\n" +
    "  globalThis.jsonLogic = module.exports;\n}\n";
  fs.mkdirSync(path.dirname(jlDest), { recursive: true });
  fs.writeFileSync(jlDest, content);
  console.log(`  written ${path.relative(root, jlDest)} (+ Electron globalThis fallback)`);
} else {
  console.warn("  WARNING: json-logic-js not found in node_modules");
}

console.log("[postinstall] Done.");
