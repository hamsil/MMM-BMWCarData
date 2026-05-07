# Data Model

## BMW CarData MQTT payload

Each MQTT message arrives on topic `{gcid}/{VIN}` as a JSON object:

```json
{
  "data": {
    "vehicle.drivetrain.batteryManagement.stateOfCharge.displayed": {
      "value": 82,
      "timestamp": 1735987212345
    },
    "vehicle.location.coordinates": {
      "value": { "lat": 48.1372, "lon": 11.5755 },
      "timestamp": 1735987212000
    }
  }
}
```

Multiple descriptors can appear in a single message. Messages arrive whenever a descriptor value changes; some descriptors (e.g. location) update frequently while driving, others (e.g. mileage) update only when the vehicle parks.

---

## Descriptor → internal field mapping

Only the fields below are mapped. All other topics are passed through as raw
values and displayed by path via `topicFormatter.js`.

| Internal field | Primary descriptor path (MINI) | Generic alias(es) |
|---|---|---|
| `lat` | `vehicle.cabin.infotainment.navigation.currentLocation.latitude` | `vehicle.location.latitude` |
| `lon` | `vehicle.cabin.infotainment.navigation.currentLocation.longitude` | `vehicle.location.longitude` |
| `heading` | `vehicle.cabin.infotainment.navigation.currentLocation.heading` | `vehicle.location.heading`, `vehicle.drive.heading`, `vehicle.location.direction` |
| `speed` | `vehicle.drive.speed` | `vehicle.currentSpeed`, `vehicle.drivetrain.currentSpeed` |
| `chargingStatus` | `vehicle.drivetrain.electricEngine.charging.status` | `vehicle.powertrain.electric.battery.charging.status`, `vehicle.drivetrain.batteryManagement.chargingStatus` |
| `soc` | `vehicle.drivetrain.batteryManagement.header` | `…stateOfCharge.displayed`, `…stateOfCharge`, `vehicle.powertrain.electric.battery.stateOfCharge` |
| `maxEnergy` | `vehicle.drivetrain.batteryManagement.maxEnergy` | `vehicle.powertrain.electric.battery.maxEnergy` |
| `isMoving` | `vehicle.isMoving` | `vehicle.motion.isMoving` |

Mapping is handled in [MMM-BMWCarDataInfo/lib/descriptors.js](../MMM-BMWCarDataInfo/lib/descriptors.js). Add new aliases there if BMW updates descriptor names in future firmware.

---

## `chargingStatus` values

| Value | Meaning |
|---|---|
| `CHARGINGACTIVE` | Actively charging (MINI) |
| `INITIALIZATION` | Charging initialising (MINI) |
| `CHARGINGPAUSED` | Charging paused (MINI) |
| `CHARGING` / `CHARGING_ACTIVE` | Actively charging (BMW generic) |
| `CHARGE_NOW` / `IMMEDIATE_CHARGING` | Immediate charge requested |
| `PENDING_FOR_CHARGING` / `WAITING_FOR_CHARGING` | Scheduled / waiting to charge |
| `CHARGINGENDED` | Session complete (MINI) |
| `NOCHARGING` / `NOT_CHARGING` | Not charging |
| `CHARGINGERROR` / `ERROR` | Fault |

---

## Persistent state schema (`data/state.json`)

```json
{
  "track": [
    {
      "t":       1735987212,
      "lat":     48.1372,
      "lon":     11.5755,
      "speed":   87.3,
      "heading": 220
    }
  ],
  "charging": [
    {
      "start":    1735980000,
      "end":      1735982280,
      "lat":      48.1400,
      "lon":      11.5600,
      "socStart": 12,
      "socEnd":   78,
      "kwh":      51.48,
      "address":  "Hauptstraße 10, 80331 München"
    }
  ],
  "parking": [
    {
      "start":   1735983000,
      "end":     1735987200,
      "lat":     48.1372,
      "lon":     11.5755,
      "address": "Maximilianstraße 12, 80539 München"
    }
  ],
  "latest": {
    "soc":            82,
    "maxEnergy":      78.2,
    "chargingStatus": "CHARGINGENDED",
    "lat":            48.1372,
    "latAt":          "2026-01-04T10:00:12Z",
    "lon":            11.5755,
    "lonAt":          "2026-01-04T10:00:12Z",
    "heading":        220,
    "speed":          0,
    "isMoving":       false,
    "address":        "Maximilianstraße 12, 80539 München",
    "updatedAt":      1735987212345
  }
}
```

- **`track`**: Rolling 24 h buffer. Each point is Kalman-smoothed. Points older than 24 h are pruned on save.
- **`charging`**: Completed and in-progress charging stops. `end` is `null` while a session is open.
- **`parking`**: Completed and in-progress parking stops (≥ `parkingMinMinutes` stationary without charging).
- **`latest`**: Most recent snapshot of all known fields. Persists across restarts so the UI is populated immediately.

---

## Token file schema (`data/tokens-{clientId}.json`)

```json
{
  "accessToken":  "eyJ…",
  "refreshToken": "eyJ…",
  "idToken":      "eyJ…",
  "expiresIn":    3600,
  "gcid":         "12345678-1234-1234-1234-123456789012",
  "clientId":     "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

File permissions: `0600`. Excluded from git via `.gitignore`.

Tokens are **per BMW account** (per `clientId`), not per vehicle. A single token file covers all VINs registered under the same BMW ID.

The `idToken` is used as the MQTT password. It is refreshed automatically ~5 minutes before expiry using the `refreshToken`.
