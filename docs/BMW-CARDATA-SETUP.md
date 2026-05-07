# BMW/MINI CarData Setup Guide

This guide walks you through registering with BMW CarData, selecting the right data points, and authorizing the MagicMirror module to connect to the live MQTT stream.

The guide is written for a BMW, but it works exactly the same way for a MINI if not noted otherwise.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| BMW/MINI ConnectedDrive account | Active subscription. |
| Eligible vehicle | CarData is available for most models from ~2019 onwards in the EU and selected other regions. |
| Node.js ≥ 18 | Installed on the MagicMirror host (check: `node --version`) |
| OpenSSL ≥ 1.1.1 (TLS 1.2+) | Already present on Raspberry Pi OS Bullseye / any modern Linux or macOS |


---

## Step 1 — Access the BMW CarData portal

1. Open **My BMW** on your phone or visit [www.bmw.de/de-de/mybmw/vehicle-overview](https://www.bmw.de/de-de/mybmw/vehicle-overview) (adjust the country in the URL if outside Germany).
2. Select your vehicle.
3. Scroll to **"BMW CarData"** and tap/click it.
4. If you haven't used CarData before, accept the terms of service.

Alternatively go directly to [bmw-cardata.bmwgroup.com](https://bmw-cardata.bmwgroup.com) and sign in with your BMW ID.

For MINI the links are similar, e.g. [www.mini.de/de-de/mymini/vehicle-overview](https://www.mini.de/de-de/mymini/vehicle-overview)

---

## Step 2 — Create a CarData Client and note your credentials

1. In the CarData portal, open the **"Clients"** tab (or follow "Create CarData Client").
2. Click **"New Client"**.
3. Give it a name (e.g. `MagicMirror`).
4. Copy the generated **Client ID** — it looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.  
   This is used for the OAuth2 device-code login flow, MQTT streaming, and the REST API.

5. In the portal, navigate to the **streaming credentials** section.  
   Note the **Host** and **Port** for the MQTT broker — they are customer-specific.  
   The **Username** shown there is your **GCID** (received from the OAuth token exchange).

> **MQTT connection summary (from BMW CarData documentation chapter 4):**
>
> | Field | Value |
> |---|---|
> | Host | From portal streaming credentials |
> | Port | From portal streaming credentials |
> | Username | Your **GCID** (returned in the OAuth token response) |
> | Password | Your **id\_token** (from Device Code Flow — rotates ~1 h, refreshed automatically) |
> | SSL/TLS | On |
> | SSL Secure | On |
> | Certificates | CA signed server certificate |
>
> The GCID and id\_token are obtained automatically by `node tools/login.js`.

---

## Step 3 — Select data points (descriptors)

BMW CarData gives you control over which signals are streamed to your client. You **must** enable signals before they appear in the MQTT stream.

In the portal, go to your vehicle → **"Data points"** (or "Descriptors") and enable at minimum:

- `vehicle.drivetrain.batteryManagement.header`
- `vehicle.drivetrain.electricEngine.charging.status`
- `vehicle.cabin.infotainment.navigation.currentLocation.heading`
- `vehicle.cabin.infotainment.navigation.currentLocation.latitude`
- `vehicle.cabin.infotainment.navigation.currentLocation.longitude`
- `vehicle.vehicle.travelledDistance`

> **Tip:** The portal lists over 200 possible signals. You can safely enable all of them — the module ignores signals it doesn't recognize, and BMW only streams descriptors that your car actually supports.

> **Note:** Descriptor names can vary slightly between BMW model years and firmware versions. The module includes aliases for known variants and degrades gracefully when a signal isn't present.

---

## Step 4 — Run the login tool

Once you have your **Client ID**, run the one-time authorization:

```bash
cd ~/MagicMirror/modules/MMM-BMWCardata
node tools/login.js
```

You will be prompted for:
- **Client ID** (from Step 2)

> **Multiple vehicles on the same account:** Run `login.js` only **once** per BMW account — tokens are per account, not per vehicle. The same token file covers all VINs registered under the same BMW ID.

The tool will print something like:

```
┌───────────────────────────────────────────────────────┐
│  Open this URL on your phone (or any browser):         │
│  https://customer.bmwgroup.com/gcdm/oauth/activate     │
│                                                         │
│  Enter code:  ABCD-1234                                 │
└───────────────────────────────────────────────────────┘
Waiting for approval (do NOT press Enter until BMW confirms)…
```

1. Open the URL shown on your phone.
2. Sign in with your BMW ID if prompted.
3. Enter the displayed code.
4. BMW will ask you to confirm granting data access.
5. **Wait for the portal to show a success message**, then the terminal will automatically detect the approval and save the tokens.

> **Important:** Do NOT press Enter or close the terminal until BMW confirms the approval. The tool polls automatically — you just wait.

Tokens are saved to `MMM-BMWCarDataInfo/data/tokens-{clientId}.json` (permissions: 0600, not committed to git).

---

## Step 5 — Add modules to MagicMirror config

Edit `~/MagicMirror/config/config.js` and add both modules. See the [README](../README.md#configuration).

---

## Step 6 — Start MagicMirror

Check the log for entries with `[MMM-BMWCarDataInfo]`

The map and info panel will populate as soon as the first MQTT messages arrive. If your car is parked and not moving, you may only receive occasional heartbeat updates.

---

## Troubleshooting

### `No tokens found. Run node tools/login.js first.`

Run `node tools/login.js` and complete the flow.

### `Token refresh failed`

Your `refresh_token` may have expired (this happens if MagicMirror was offline for several weeks). Re-run `node tools/login.js` to get fresh tokens.

### Map shows no track

- The car needs to have been driven since the module started (or since `data/state.json` was last written).
- Run `node tools/probe.js` to verify signals are arriving. If the output shows empty `data:` objects, revisit Step 3 and enable the location descriptors in the BMW portal.

### `vehicle.location.coordinates` not arriving

This descriptor must be explicitly enabled in the BMW portal. See Step 3. Some older BMW models do not expose live GPS via CarData.

### Vehicle image or capabilities return 403

The module fetches static vehicle data (model name, image, capabilities list) from the BMW CarData REST API on first startup. Whether these are available depends on BMW's back-end database — **there is no portal setting you can change to enable them**:

- **basicdata fields** (`basicdata.brand`, `basicdata.modelName`, …) — available for all VINs if the CarData client is set up correctly.
- **image** — BMW stores rendered vehicle images for most current models, but not for all VINs. If your VIN returns 403, the image simply isn't in the database.
- **capabilities** — availability varies by market and model year.

When a 403 is returned the module logs an informational message and continues normally — it does not affect MQTT streaming or any other feature. You can safely ignore those log lines.

### TLS / SSL errors on Raspberry Pi

```
Error: unable to get local issuer certificate
```

Update the CA certificates:

```bash
sudo apt update && sudo apt install -y ca-certificates
```

Make sure Node.js was installed via NodeSource, not the very old version in the Raspberry Pi OS repository.

### MQTT error: `Connection refused`

- Verify your `id_token` hasn't expired (tokens rotate hourly; the module refreshes automatically when running).
- Check that `customer.streaming-cardata.bmwgroup.com` is reachable: `ping customer.streaming-cardata.bmwgroup.com`.

---

## Re-authorization

If BMW invalidates your tokens (e.g. you changed your BMW ID password):

```bash
cd ~/MagicMirror/modules/MMM-BMWCardata
node tools/login.js
```

Then restart MagicMirror.

---

## Data privacy

- The MQTT stream is end-to-end TLS encrypted between BMW's broker and your device.
- No data leaves your home network except for the optional Nominatim reverse-geocoding requests (which send only GPS coordinates to OpenStreetMap's servers).
- `tokens.json` is created with mode `0600` and is excluded from git. Never commit it.
