"use strict";

const path = require("node:path");
const { refreshTokens, saveTokens } = require("./auth");
const { TIMINGS } = require("./constants");

// Decode the JWT exp claim (no signature verification — we only need the
// expiry time to schedule the next refresh).
function _jwtRemainingSeconds(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    return Math.max(payload.exp - Math.floor(Date.now() / 1000), 0);
  } catch {
    return 0;
  }
}

class TokenManager {
  #tokenState;
  #dataDir;
  #onError;
  #timer = null;

  /**
   * @param {object}   tokenState  Shared token state: { tokens, clientId }
   * @param {string}   dataDir     Path to the data directory for token file writes
   * @param {Function} onError     (message: string) => void — forwards errors upstream
   */
  constructor(tokenState, dataDir, onError) {
    this.#tokenState = tokenState;
    this.#dataDir    = dataDir;
    this.#onError    = onError;
  }

  /** Seconds remaining on the current id_token, or 0 if absent/expired. */
  remainingSecs() {
    return _jwtRemainingSeconds(this.#tokenState.tokens?.idToken ?? "");
  }

  /**
   * Perform a token refresh now. Persists the new tokens to disk.
   * Returns true on success, false on failure (error is forwarded via onError).
   */
  async refresh() {
    const { tokens, clientId } = this.#tokenState;
    console.log(`[BMW ${clientId}] Refreshing tokens…`);
    try {
      const newTokens = await refreshTokens(clientId, tokens.refreshToken);
      this.#tokenState.tokens = { ...tokens, ...newTokens };
      saveTokens(this.#tokenState.tokens, path.join(this.#dataDir, `tokens-${clientId}.json`));
      return true;
    } catch (e) {
      console.error(`[BMW ${clientId}] Token refresh failed:`, e.message);
      this.#onError(`Token refresh failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Schedule the next automatic refresh. Calls onRefreshed(newIdToken) on
   * success and reschedules; backs off and retries on failure.
   * @param {number}   expiresInSecs  Seconds until the current id_token expires
   * @param {Function} onRefreshed    (newIdToken: string) => void
   */
  scheduleRefresh(expiresInSecs, onRefreshed) {
    this.cancelRefresh();
    const delay = Math.max(
      expiresInSecs * 1000 - TIMINGS.TOKEN_REFRESH_AHEAD_MS,
      TIMINGS.TOKEN_REFRESH_MIN_DELAY_MS,
    );
    console.log(`[BMW ${this.#tokenState.clientId}] Token refresh in ${Math.round(delay / 60_000)} min.`);
    this.#timer = setTimeout(() => this.#doRefresh(onRefreshed), delay);
  }

  cancelRefresh() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
  }

  async #doRefresh(onRefreshed) {
    const ok = await this.refresh();
    if (ok) {
      onRefreshed(this.#tokenState.tokens.idToken);
      this.scheduleRefresh(this.remainingSecs(), onRefreshed);
    } else {
      this.#timer = setTimeout(
        () => this.#doRefresh(onRefreshed),
        TIMINGS.TOKEN_REFRESH_RETRY_DELAY_MS,
      );
    }
  }
}

module.exports = { TokenManager, _jwtRemainingSeconds };
