#!/usr/bin/env node
"use strict";

// One-shot CLI to perform the BMW CarData OAuth2 device-code flow with PKCE.
// Run:  node tools/login.js
// Then open the URL shown on your phone and approve the request.
// Tokens are saved to MMM-BMWCarDataInfo/data/tokens-{clientId}.json.

const path     = require("node:path");
const readline = require("node:readline");

const moduleRoot = path.join(__dirname, "..");
process.chdir(moduleRoot);

const {
  startDeviceFlow,
  pollForTokens,
  saveTokens,
} = require("../MMM-BMWCarDataInfo/lib/auth");

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

async function main() {
  console.log("━━━ BMW / MINI CarData – First-time login ━━━\n");

  const clientId = (await ask("Client ID (from BMW CarData portal): ")).trim();
  if (!clientId) { console.error("Client ID is required."); process.exit(1); }

  rl.close();

  console.log("\nStarting device authorization flow…");
  const flow = await startDeviceFlow(clientId);

  console.log("\n┌───────────────────────────────────────────────────────┐");
  console.log("│  Open this URL on your phone (or any browser):         │");
  console.log(`│  ${flow.verificationUri.padEnd(53)}│`);
  console.log("│                                                         │");
  console.log(`│  Enter code:  ${flow.userCode.padEnd(41)}│`);
  console.log("└───────────────────────────────────────────────────────┘\n");
  console.log("Waiting for approval (do NOT press Enter until BMW confirms)…\n");

  const tokens = await pollForTokens(
    clientId,
    flow.deviceCode,
    flow.verifier,
    { interval: flow.interval, expiresIn: flow.expiresIn },
  );

  const tokenFile = path.join(moduleRoot, "MMM-BMWCarDataInfo", "data", `tokens-${clientId}.json`);
  saveTokens({ ...tokens, clientId }, tokenFile);

  console.log(`\n✓ Tokens saved to: ${tokenFile}`);
  console.log(`  GCID:    ${tokens.gcid}  ← this is your MQTT username`);
  console.log(`  Expires: ${tokens.expiresIn} s (refresh is automatic)`);
  console.log(`\nIf you have multiple vehicles on the same BMW account, you are done.`);
  console.log(`One token file covers all VINs on this account. ✓`);
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
