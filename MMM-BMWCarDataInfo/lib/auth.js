"use strict";

const crypto = require("node:crypto");
const https  = require("node:https");
const path   = require("node:path");
const fs     = require("node:fs");

const DEVICE_CODE_URL = "https://customer.bmwgroup.com/gcdm/oauth/device/code";
const TOKEN_URL       = "https://customer.bmwgroup.com/gcdm/oauth/token";
const TOKEN_FILE      = path.join(__dirname, "..", "data", "tokens.json");

// PKCE helpers
function generateVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}
function generateChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function postForm(url, params) {
  const body    = new URLSearchParams(params).toString();
  const urlObj  = new URL(url);

  const options = {
    hostname: urlObj.hostname,
    path:     urlObj.pathname + urlObj.search,
    method:   "POST",
    headers:  {
      "Content-Type":   "application/x-www-form-urlencoded",
      "Accept":         "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        try {
          resolve({ ok, status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ ok, status: res.statusCode, body: raw });
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Start the OAuth2 device-code flow with PKCE.
 * Returns { verificationUri, userCode, deviceCode, expiresIn, interval }.
 */
async function startDeviceFlow(clientId) {
  const verifier   = generateVerifier();
  const challenge  = generateChallenge(verifier);

  const res = await postForm(DEVICE_CODE_URL, {
    client_id:             clientId,
    response_type:         "device_code",
    scope:                 "authenticate_user openid cardata:api:read cardata:streaming:read",
    code_challenge:        challenge,
    code_challenge_method: "S256",
  });

  if (!res.ok) throw new Error(`Device-code request failed ${res.status}: ${JSON.stringify(res.body)}`);

  const b = res.body;
  return {
    verificationUri: b.verification_uri ?? b.verification_url,
    userCode:        b.user_code,
    deviceCode:      b.device_code,
    expiresIn:       b.expires_in ?? 600,
    interval:        (b.interval ?? 5) * 1000,
    verifier,
  };
}

/**
 * Poll the token endpoint until the user approves or the code expires.
 * Resolves with { accessToken, refreshToken, idToken, expiresIn, gcid }.
 */
async function pollForTokens(clientId, deviceCode, verifier, { interval = 5000, expiresIn = 600 } = {}) {
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));

    const res = await postForm(TOKEN_URL, {
      grant_type:    "urn:ietf:params:oauth:grant-type:device_code",
      client_id:     clientId,
      device_code:   deviceCode,
      code_verifier: verifier,
    });

    if (res.ok) return _parseTokenResponse(res.body);
    const err = res.body?.error ?? "";
    // 403 authorization_pending → user hasn't approved yet, keep polling
    // 400 slow_down → we're polling too fast, keep going (interval already respects server value)
    // 403 access_denied → user explicitly denied
    if (err === "authorization_pending" || err === "slow_down") continue;
    if (err === "access_denied") throw new Error("Authorization denied by the user.");
    if (err === "expired_token")  throw new Error("Device code expired – please run login again.");
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
  throw new Error("Device authorization timed out – please try again.");
}

/**
 * Refresh tokens using a stored refresh_token.
 * BMW's refresh endpoint does not accept a scope parameter — omitting it
 * re-grants the same scopes as the original authorization.
 */
async function refreshTokens(clientId, refreshToken) {
  const res = await postForm(TOKEN_URL, {
    grant_type:    "refresh_token",
    client_id:     clientId,
    refresh_token: refreshToken,
  });
  if (!res.ok) throw new Error(`Token refresh failed ${res.status}: ${JSON.stringify(res.body)}`);
  return _parseTokenResponse(res.body);
}

function _parseTokenResponse(body) {
  const idToken = body.id_token;
  // gcid is returned directly in the token response body; fall back to JWT sub if absent
  let gcid = body.gcid ?? null;
  if (!gcid && idToken) {
    try {
      const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
      gcid = payload.gcid ?? payload.sub;
    } catch (e) {
      console.warn("[BMW Auth] Could not parse gcid from id_token:", e.message);
    }
  }
  return {
    accessToken:  body.access_token,
    refreshToken: body.refresh_token,
    idToken,
    expiresIn:    body.expires_in ?? 3600,
    gcid,
  };
}

// ── Persisted token store ──────────────────────────────────────────────────

function loadTokens(file) {
  const target = file ?? TOKEN_FILE;
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("[BMW Auth] Could not load tokens:", e.message);
    return null;
  }
}

function saveTokens(tokens, file) {
  const target = file ?? TOKEN_FILE;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

module.exports = {
  startDeviceFlow,
  pollForTokens,
  refreshTokens,
  loadTokens,
  saveTokens,
  TOKEN_FILE,
};
