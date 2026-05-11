#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

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

// json-logic-js browser build
const jlSrc = path.join(nodeModules, "json-logic-js", "logic.js");
if (fs.existsSync(jlSrc)) {
  copyFile(jlSrc, path.join(root, "MMM-BMWCarDataInfo", "vendor", "json-logic.js"));
} else {
  console.warn("  WARNING: json-logic-js not found in node_modules");
}

console.log("[postinstall] Done.");
