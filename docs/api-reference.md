# Reolink WUI API reference

Use the WUI HTTP API for actions performed as a signed-in user. The browser receives live events over SSE at `/api/v1/events`. The WUI server connects to the bridge over its configured transports. The examples pair each request with its response and use fictional IDs and credentials. Use the IDs returned by your WUI. Binary examples show the media type, bytes or signature. A `HEAD` request on a `GET` resource returns headers without a body.

For direct camera integration, see the bridge reference. [Bridge HTTP and WebSocket API](https://github.com/Slyke/reolink-bridge/blob/master/docs/api-reference.md)

- [WUI sessions and status](#wui-sessions-and-status)
- [WUI cameras and events](#wui-cameras-and-events)
- [WUI controls and settings](#wui-controls-and-settings)
- [WUI live view and talk](#wui-live-view-and-talk)
- [WUI recordings and retention](#wui-recordings-and-retention)
- [WUI enrollment and camera users](#wui-enrollment-and-camera-users)
- [WUI instance administration](#wui-instance-administration)
- [WUI calls to the bridge](#wui-calls-to-the-bridge)
- [Implementation sources](#implementation-sources)

## WUI sessions and status

The examples use the default browser API base `/api/v1`. In browser mode replace `/api` with `httpApi.browserBasePath` if configured. In proxy mode the browser uses `httpApi.proxy.basePath` (default `/api-proxy`) and SvelteKit forwards to `httpApi.proxy.upstreamBasePath` (default `/api`). `/livez` and `/readyz` stay at the root.

Use the WUI’s UUIDv4 camera `id` from `GET /api/v1/cameras` in `{camera}`. A bridge ID such as `home` identifies a configured WUI connection. The bridge’s own public camera ID, hardware UID, WUI camera UUID, and a recording’s opaque 64-hex ID have distinct uses.

Sign in through a configured method, keep the `__Host-reolink_session` cookie, and take `csrf` from the login response or `GET /api/v1/session`. Authenticated writes require the public `Origin` and `X-CSRF-Token`. Local and proxy sign-in require the public `Origin` before a session exists. Example headers for a signed-in JSON write follow.

```http
Cookie: __Host-reolink_session=<session>
Origin: https://wui.example
X-CSRF-Token: <csrf from this session>
Content-Type: application/json
```

An operation write takes a fresh UUIDv4 `operationId` where shown. Reuse it for a retry of the same intent. The ordinary result carries `id`, `outcome`, `correlationId` and optionally `bridgeCorrelationId`, `data`, `reason` or `cameraStatus`. The status endpoint and replay return the durable outcome without the original `data` or image. The usual operation responses are `200` for `confirmed` and `unverified`, `202` for `pending`, `422` for `rejected`, and `504` for `unknown`. Individual handlers below also return binary, empty, or plain JSON responses.

#### `GET /livez`

Available on the UI and API listeners.

```http
GET /livez HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "service": "reolink-wui",
  "version": "0.1.0",
  "buildHash": "unknown",
  "buildDate": "unknown",
  "ok": true,
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

#### `GET /readyz`

The Fastify API tests its dependencies and returns `500` with `ok: false` when unready. In proxy mode the UI forwards readiness to that API. In browser mode the UI’s own probe reports its local status.

```http
GET /readyz HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "service": "reolink-wui",
  "version": "0.1.0",
  "buildHash": "unknown",
  "buildDate": "unknown",
  "ok": true,
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

#### `GET /api/v1/session`

Anonymous example. A signed-in response also includes `user` and `csrf` as in the next call. `methods.proxy` depends on verified ingress identity.

```http
GET /api/v1/session HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"methods": {"local": true, "oidc": false, "proxy": false}}
```

#### `POST /api/v1/session/local`

Local login sets a Secure, HttpOnly, SameSite=Lax session cookie.

```http
POST /api/v1/session/local HTTP/1.1
Origin: https://wui.example
Content-Type: application/json

{"username": "operator", "password": "Example-login-password"}

HTTP/1.1 200 OK
Set-Cookie: __Host-reolink_session=<session>; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax
Content-Type: application/json

{
  "user": {"id": "22222222-2222-4222-8222-222222222222", "label": "Operator", "admin": false},
  "csrf": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

#### `POST /api/v1/session/proxy`

Call through the configured identity-aware ingress when the session endpoint advertises `methods.proxy`.

```http
POST /api/v1/session/proxy HTTP/1.1
Origin: https://wui.example

HTTP/1.1 200 OK
Set-Cookie: __Host-reolink_session=<session>; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax
Content-Type: application/json

{
  "user": {"id": "22222222-2222-4222-8222-222222222222", "label": "Operator", "admin": false},
  "csrf": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

#### `GET /api/v1/session/oidc/start`

The browser follows the redirect to the configured identity provider. Optional `next` can carry a same-origin `/recordings` link and its query string. The flow cookie lasts five minutes.

```http
GET /api/v1/session/oidc/start?next=%2Frecordings HTTP/1.1

HTTP/1.1 303 See Other
Set-Cookie: __Host-reolink_oidc=<flow>; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax
Location: https://login.example/authorize?client_id=wui&response_type=code&redirect_uri=https%3A%2F%2Fwui.example%2Fapi%2Fv1%2Fsession%2Foidc%2Fcallback&scope=openid&state=example-state&nonce=example-nonce&code_challenge=example-challenge&code_challenge_method=S256
```

#### `GET /api/v1/session/oidc/callback`

The identity provider returns the code and matching state to this URL. Success redirects to the saved recordings path or `/`.

```http
GET /api/v1/session/oidc/callback?code=example-code&state=example-state HTTP/1.1
Cookie: __Host-reolink_oidc=<flow>

HTTP/1.1 303 See Other
Set-Cookie: __Host-reolink_session=<session>; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax
Location: /recordings
```

#### `DELETE /api/v1/session`

Send the session cookie, origin and CSRF header. The response expires the cookie.

```http
DELETE /api/v1/session HTTP/1.1

HTTP/1.1 204 No Content
Set-Cookie: __Host-reolink_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax
```

#### `GET /api/v1/operations/{operation}`

Only the account that submitted the operation can look up its outcome. Example for the PTZ status read below.

```http
GET /api/v1/operations/77777777-7777-4777-8777-000000000006 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000006",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

#### `GET /api/v1/appearance-defaults`

Public instance appearance defaults.

```http
GET /api/v1/appearance-defaults HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"appearance": {"palette": "d4rk", "theme": "dark", "font": "system-stack", "contentWidth": "standard"}}
```

#### `GET /api/v1/status`

Signed-in connection status. Entries are scoped to the caller. Each connection reports its uses, transport and state. Failover configurations may also report `feed` as `active` or `standby`.

```http
GET /api/v1/status HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "upstreams": [
    {
      "id": "home",
      "label": "Home",
      "connections": [
        {"id": "http", "transport": "HTTPS", "uses": ["api", "commands"], "state": "online"},
        {"id": "ws", "transport": "WSS", "uses": ["events"], "state": "online"}
      ]
    }
  ]
}
```

An authenticated write with a missing or mismatched CSRF token returns `403`. The `X-Correlation-Id` response header and JSON `correlationId` identify the request. Upstream failures may also include `details.upstreamStatus`, `details.bridgeCorrelationId` or `details.playbackReason`.

```json
{
  "error": "CSRF_DENIED",
  "errorKey": "CSRF_DENIED",
  "errorCode": "4889513A86A7F990",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

## WUI cameras and events

#### `GET /api/v1/cameras`

Lists cameras visible to the account, in its saved order. Each entry includes permission-filtered capabilities. Administrators also receive `inventory` (`no-bridge`, `waiting`, `empty` or `discovered`). Example for a viewer.

```http
GET /api/v1/cameras HTTP/1.1
Host: wui.example
Cookie: __Host-reolink_session=<session>

HTTP/1.1 200 OK
Content-Type: application/json

{
  "cameras": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Front door",
      "deviceUid": "952700EXAMPLE123",
      "availability": {"stale": false, "online": true, "updatedAt": "2026-11-23T17:30:00.000Z"},
      "previewIntervalMs": 5000,
      "previewPush": true,
      "refreshOnAlert": "off",
      "capabilities": {
        "discovered": true,
        "talk": false,
        "detectionZones": {"available": true, "types": []},
        "ftpDestination": false,
        "events": true,
        "recordings": false,
        "storageFormat": false,
        "recordingExport": false,
        "timeLapsePhotos": false,
        "timeLapsePhotoExport": false,
        "recordingMetadata": false,
        "recordingPreview": false,
        "recordingPlayback": false,
        "capture": false,
        "presetSnapshot": false,
        "mediaAllowed": true,
        "preview": true,
        "previewState": "configured",
        "bridgePreview": true,
        "viaProxy": false,
        "media": ["main", "sub"],
        "alerts": {"read": false, "write": false},
        "encoding": {"read": false, "write": false, "available": true},
        "clock": {"read": false, "write": false, "available": true},
        "options": {},
        "display": {"read": false, "write": false, "available": true},
        "network": {"read": false, "write": false, "available": true, "rtsp": true},
        "cameraUsers": false,
        "rotate": false,
        "freshSettings": true,
        "settings": {}
      }
    }
  ]
}
```

#### `PUT /api/v1/cameras/order`

Give two adjacent, visible camera UUIDs in the desired order. The change applies to the signed-in account.

```http
PUT /api/v1/cameras/order HTTP/1.1
Content-Type: application/json

{"earlier": "11111111-1111-4111-8111-111111111111", "later": "11111111-1111-4111-8111-222222222222"}

HTTP/1.1 200 OK
Content-Type: application/json

{"order": ["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-222222222222"]}
```

#### `GET /api/v1/cameras/{camera}`

Requires `view`. Identity, position, coordinate stream, detection and setting readbacks depend on the device and grants.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "Front door",
  "deviceUid": "952700EXAMPLE123",
  "availability": {"stale": false, "online": true, "updatedAt": "2026-11-23T17:30:00.000Z"},
  "coordinateStream": {},
  "settings": {},
  "detections": []
}
```

#### `GET /api/v1/cameras/{camera}/capabilities`

Requires `view`. This viewer can receive events and watch two live profiles. A camera operator can see additional PTZ and settings permissions.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/capabilities HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "discovered": true,
  "talk": false,
  "detectionZones": {"available": true, "types": []},
  "ftpDestination": false,
  "events": true,
  "recordings": false,
  "storageFormat": false,
  "recordingExport": false,
  "timeLapsePhotos": false,
  "timeLapsePhotoExport": false,
  "recordingMetadata": false,
  "recordingPreview": false,
  "recordingPlayback": false,
  "capture": false,
  "presetSnapshot": false,
  "mediaAllowed": true,
  "preview": true,
  "previewState": "configured",
  "bridgePreview": true,
  "viaProxy": false,
  "media": ["main", "sub"],
  "alerts": {"read": false, "write": false},
  "encoding": {"read": false, "write": false, "available": true},
  "clock": {"read": false, "write": false, "available": true},
  "options": {},
  "display": {"read": false, "write": false, "available": true},
  "network": {"read": false, "write": false, "available": true, "rtsp": true},
  "cameraUsers": false,
  "rotate": false,
  "freshSettings": true,
  "settings": {}
}
```

#### `GET /api/v1/cameras/{camera}/events`

Requires `events`. Returns retained events, oldest first. `observedAt` is a WUI timestamp in Unix milliseconds. The nested event can have `receivedAt`, `cameraTime`, `active`, `ruleId`, `source`, `vendorTopic` and tracked objects.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/events HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "limit": 100,
  "events": [
    {
      "id": "66666666-6666-4666-8666-666666666666",
      "observedAt": 1795455000000,
      "event": {
        "type": "doorbell",
        "vendorTopic": "HaCfg/wake",
        "source": "reolink_webhook",
        "receivedAt": "2026-11-23T17:30:00.000Z"
      }
    }
  ]
}
```

### Browser event stream and the upstream WebSocket

Browser clients open an HTTP `EventSource` on `/api/v1/events`. WebSocket is an outbound connection from the WUI server. It can open the bridge’s `/ws` using the bearer token, send `subscribe` with the configured camera IDs and `snapshot` to refresh, and receive `event`, `snapshot` and `gap`. It sends protocol ping frames every eight seconds. Ordinary WUI camera commands go upstream over the configured HTTP or MQTT command channel. On-demand PNG capture uses MQTT. Callback management uses bridge HTTP. [Bridge WebSocket requests and responses](https://github.com/Slyke/reolink-bridge/blob/master/docs/api-reference.md#bridge-websocket-and-events)

#### `GET /api/v1/events`

Optional `camera` is a WUI UUID. Optional `type` matches the normalized event topic or vendor topic. Each SSE `data:` field contains one JSON object. Load retained events through the camera events endpoint.

```http
GET /api/v1/events?camera=11111111-1111-4111-8111-111111111111&type=doorbell HTTP/1.1
Accept: text/event-stream

HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8

data: {"kind":"connected"}

data: {"kind":"event","camera":"11111111-1111-4111-8111-111111111111","id":"66666666-6666-4666-8666-666666666666","observedAt":1795455000000,"event":{"type":"doorbell","vendorTopic":"HaCfg/wake","source":"reolink_webhook","receivedAt":"2026-11-23T17:30:00.000Z"}}

: keep-alive
```

Other WUI SSE messages are shown one per line. `state` asks the client to reread a camera, `preview` identifies a changed image, `feed` signals a connection change, and `access-changed` is sent before the stream closes when the user or grants change. A `gap` describes an interruption or dropped events. Its details depend on the cause.

```jsonl
{"kind":"state","camera":"11111111-1111-4111-8111-111111111111"}
{"kind":"preview","camera":"11111111-1111-4111-8111-111111111111","etag":"\"0101010101010101010101010101010101010101010101010101010101010101\""}
{"kind":"feed"}
{"kind":"gap","details":{"id":"66666666-6666-4666-8666-666666666666","cause":"bridge-connection","detectedAt":1795455000000,"bridge":"home","transport":"WSS","failure":"heartbeat"}}
{"kind":"gap","details":{"id":"11111111-1111-4111-8111-222222222222","cause":"bridge-backlog","detectedAt":1795455000000,"bridge":"home","transport":"WSS"}}
{"kind":"gap","details":{"id":"22222222-2222-4222-8222-222222222222","cause":"delivery-backlog","detectedAt":1795455000000,"firstObservedAt":1795455000000,"lastObservedAt":1795455000000,"droppedEvents":1,"samples":[{"camera":"11111111-1111-4111-8111-111111111111","observedAt":1795455000000,"type":"doorbell"}]}}
{"kind":"access-changed"}
```

## WUI controls and settings

The WUI checks grants per camera. Ordinary setting groups use `settings.<group>.read` and `.write`. Display fields use `settings.image.*`, FTP uses `settings.delivery.*`, network and clock use their corresponding groups, and PTZ uses `ptz.read` or `ptz.write`. The [bridge command catalog](https://github.com/Slyke/reolink-bridge/blob/master/docs/api-reference.md#typed-camera-commands) gives the available setting values and PTZ action shapes.

#### `POST /api/v1/cameras/{camera}/ptz`

`status` and `list_presets` require `ptz.read`. Other actions require `ptz.write`. Use `interrupts` on `stop` to reference the movement’s operation UUID. `list_presets` returns `data.presets` and saved `data.preferences` to permitted readers.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/ptz HTTP/1.1
Host: wui.example
Cookie: __Host-reolink_session=<session>
Origin: https://wui.example
X-CSRF-Token: <csrf from this session>
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000006", "action": {"op": "status"}}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000006",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {
    "position": {"pan": 725, "tilt": 110, "zoom": {"position": 12, "range": {"min": 0, "max": 27}}},
    "receivedAt": "2026-11-23T17:30:00.000Z"
  }
}
```

#### `PUT /api/v1/cameras/{camera}/ptz/preferences`

Requires preset support plus PTZ read and write grants. `order` contains unique slots, `returnPreset` can be null, and `returnSeconds` is 1–86400. This write returns the preferences directly.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/ptz/preferences HTTP/1.1
Content-Type: application/json

{"order": [1, 2], "returnPreset": 1, "returnSeconds": 10}

HTTP/1.1 200 OK
Content-Type: application/json

{"order": [1, 2], "returnPreset": 1, "returnSeconds": 10}
```

#### `POST /api/v1/cameras/{camera}/ptz/preset-snapshot`

Requires `ptz.read`, `ptz.write` and `capture`. Moves to the preset, verifies arrival and returns PNG for on-demand capture or JPEG for a bridge preview. If there is no image the response is an operation outcome.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/ptz/preset-snapshot HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000007", "presetId": 1}

HTTP/1.1 200 OK
Content-Disposition: inline; filename="preset-1.png"
Content-Type: image/png

[PNG bytes, beginning 89 50 4E 47 0D 0A 1A 0A]
```

#### `GET /api/v1/cameras/{camera}/settings/{group}`

Without `fresh=true` this returns cached values and `fresh: false`. Fresh reads go to the bridge. Supported groups are `leds`, `spotlight`, `motion`, `ai`, `image`, `recording_schedule` and `time_lapse`.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/settings/motion?fresh=true HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "values": {"motion_detection": {"enabled": true, "sensitivity": 40}},
  "fresh": true,
  "availability": {"stale": false, "online": true, "updatedAt": "2026-11-23T17:30:00.000Z"}
}
```

#### `PATCH /api/v1/cameras/{camera}/settings/{group}`

The change must belong to the path group. The WUI returns filtered readback in `data` when the caller also has the read grant. For a weekly schedule the WUI requires both `enable_hours` and `disable_hours`.

```http
PATCH /api/v1/cameras/11111111-1111-4111-8111-111111111111/settings/motion HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000008",
  "change": {"setting": "motion_detection", "enabled": true, "sensitivity": 40}
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000008",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"motion_detection": {"enabled": true, "sensitivity": 40}}
}
```

#### `GET /api/v1/cameras/{camera}/alerts`

Requires `alerts.read`. Optional `?fresh=true` refreshes motion settings. Rule discovery and the list of supported live writes are separate fields.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/alerts HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "values": {"motion_detection": {"enabled": true, "sensitivity": 40}},
  "fresh": false,
  "availability": {"stale": false, "online": true, "updatedAt": "2026-11-23T17:30:00.000Z"},
  "rules": [{"id": "000", "type": "CellMotionDetector", "name": "Motion", "source": "onvif", "enabled": true}],
  "liveWrites": ["motion"]
}
```

#### `PATCH /api/v1/cameras/{camera}/alerts/{ruleId}`

The implemented live write target is `motion`. Requires `alerts.write`.

```http
PATCH /api/v1/cameras/11111111-1111-4111-8111-111111111111/alerts/motion HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000009",
  "change": {"setting": "motion_detection", "enabled": true}
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000009",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"motion_detection": {"enabled": true, "sensitivity": 40}}
}
```

#### `GET /api/v1/cameras/{camera}/options/{group}`

Use the [device option group list](https://github.com/Slyke/reolink-bridge/blob/master/docs/api-reference.md#device-option-groups) for public names and fields. FTP destination has its own WUI endpoint below. An unsupported group on the camera may return an empty `fields` object.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/options/sound HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"fields": {"speakerVolume": {"value": 65, "min": 0, "max": 100}}}
```

#### `PUT /api/v1/cameras/{camera}/options/{group}`

Zone edits send `fields: {expectedRevision,cells}`. Rectangle edits send `fields: {maskEnabled,maskAreas,expectedRevision}`. Use the latest values from the read. Tracking also requires PTZ permission.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/options/sound HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000010", "fields": {"speakerVolume": 65}}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000010",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"fields": {"speakerVolume": {"value": 65, "min": 0, "max": 100}}}
}
```

#### `GET /api/v1/cameras/{camera}/ftp`

A supported response exposes the public FTP settings and password status. A camera without FTP destination support may return `{"supported":false}`.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/ftp HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "supported": true,
  "fields": {
    "server": "files.example",
    "port": 21,
    "username": "camera",
    "remoteDirectory": "/images",
    "anonymous": false,
    "ftpsOnly": true
  },
  "passwordStored": true,
  "passwordMaxLength": 16
}
```

#### `PUT /api/v1/cameras/{camera}/ftp`

Maps to the bridge’s `options/ftpDestination`. Changing the server or port with a stored password requires supplying the password. A masked credential readback can produce `unverified`.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/ftp HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000011", "fields": {"remoteDirectory": "/images"}}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000011",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {
    "fields": {
      "server": "files.example",
      "port": 21,
      "username": "camera",
      "remoteDirectory": "/images",
      "anonymous": false,
      "ftpsOnly": true
    },
    "passwordStored": true,
    "passwordMaxLength": 16
  }
}
```

#### `GET /api/v1/cameras/{camera}/encoding`

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/encoding HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "profiles": [
    {
      "stream": "sub",
      "current": {"width": 640, "height": 360, "fps": 10, "bitrate": 256},
      "options": [{"width": 640, "height": 360, "fps": [5, 10], "bitrates": [128, 256]}],
      "gopRange": null,
      "bitrateMode": "cbr",
      "encoderProfile": null
    }
  ]
}
```

#### `PUT /api/v1/cameras/{camera}/encoding`

Write one stream and check `data.profiles` for its observed settings.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/encoding HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000012", "stream": "sub", "settings": {"fps": 10, "bitrate": 256}}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000012",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {
    "profiles": [
      {
        "stream": "sub",
        "current": {"width": 640, "height": 360, "fps": 10, "bitrate": 256},
        "options": [{"width": 640, "height": 360, "fps": [5, 10], "bitrates": [128, 256]}],
        "gopRange": null,
        "bitrateMode": "cbr",
        "encoderProfile": null
      }
    ]
  }
}
```

#### `GET /api/v1/cameras/{camera}/display`

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/display HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"fields": {"watermark": false}}
```

#### `PUT /api/v1/cameras/{camera}/display`

The read wraps the fields in `fields`. In a confirmed write the observed fields appear directly in `data`.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/display HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000013", "fields": {"watermark": false}}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000013",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"watermark": false}
}
```

#### `GET /api/v1/cameras/{camera}/clock`

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/clock HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "cameraTime": "2026-11-23T09:30:00",
  "editableOptions": ["daylightSavingEnabled", "ntpEnabled"],
  "settings": {"utcOffsetMinutes": -480, "daylightSavingEnabled": false, "ntpEnabled": false}
}
```

#### `PUT /api/v1/cameras/{camera}/clock`

To set the time, use the bridge’s wall-time and `timeZone` fields alongside `operationId`. A switch-only write must target an editable option.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/clock HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000014", "ntpEnabled": false}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000014",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {
    "cameraTime": "2026-11-23T09:30:00",
    "editableOptions": ["daylightSavingEnabled", "ntpEnabled"],
    "settings": {"utcOffsetMinutes": -480, "daylightSavingEnabled": false, "ntpEnabled": false}
  }
}
```

#### `GET /api/v1/cameras/{camera}/network`

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/network HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "link": {"address": "192.168.10.24", "netmask": "255.255.255.0", "gateway": "192.168.10.1", "dhcp": true},
  "wifi": {"ssid": "CameraLAN", "nearby": ["CameraLAN"], "configurable": true},
  "interfaces": {
    "ethernet": {"addresses": ["192.168.10.24"], "active": true, "enabled": true, "dhcp": true},
    "wifi": {"addresses": [], "active": false, "enabled": true, "dhcp": null}
  },
  "wifiSignal": null,
  "wifiSwitchAvailable": true
}
```

#### `PUT /api/v1/cameras/{camera}/network`

Configure the Wi-Fi profile. Open networks accept an empty password.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/network HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000015",
  "ssid": "CameraLAN",
  "password": "example-only-passphrase",
  "open": false,
  "confirmation": true
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000015",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"ssidVerified": true}
}
```

#### `PUT /api/v1/cameras/{camera}/network/wifi`

Use `wifiSwitchAvailable` from the network read to discover the toggle.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/network/wifi HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000016", "enabled": false, "confirmation": true}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000016",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"enabled": false}
}
```

#### `GET /api/v1/cameras/{camera}/network/rtsp`

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/network/rtsp HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"supported": true, "enabled": true, "port": 554}
```

#### `PUT /api/v1/cameras/{camera}/network/rtsp`

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/network/rtsp HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000017", "enabled": true}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000017",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"enabled": true, "port": 554}
}
```

## WUI live view and talk

#### `GET /api/v1/cameras/{camera}/playback`

Reading or changing playback settings requires an instance administrator with camera live-media access. Direct playback uses the bridge media profile. A proxy configuration also includes its `proxyUrl`.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/playback HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"source": "direct", "previewIntervalMs": 5000, "refreshOnAlert": "off"}
```

#### `PUT /api/v1/cameras/{camera}/playback`

Set `source` to `direct` or `proxy`. For `proxy`, include an RTSP `proxyUrl` with a host and without embedded credentials, query or fragment. Optional `previewIntervalMs` ranges from 50 to 2147483647. `refreshOnAlert` accepts `off`, `any`, `motion` or an AI class.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/playback HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000018",
  "source": "direct",
  "previewIntervalMs": 5000,
  "refreshOnAlert": "off"
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000018",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"source": "direct", "previewIntervalMs": 5000, "refreshOnAlert": "off"}
}
```

#### `GET /api/v1/cameras/{camera}/preview`

Requires `media.live`. Optional `refresh=true` requests a fresh bridge preview. An `If-None-Match` header matching its ETag yields `304` with an empty body.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/preview?refresh=true HTTP/1.1

HTTP/1.1 200 OK
ETag: "0101010101010101010101010101010101010101010101010101010101010101"
X-Preview-Captured-At: 2026-11-23T17:30:00.000Z
Content-Type: image/jpeg

[JPEG bytes, beginning FF D8 FF]
```

#### `HEAD /api/v1/cameras/{camera}/preview`

Example of the automatically registered `HEAD` form.

```http
HEAD /api/v1/cameras/11111111-1111-4111-8111-111111111111/preview HTTP/1.1
If-None-Match: "0101010101010101010101010101010101010101010101010101010101010101"

HTTP/1.1 304 Not Modified
ETag: "0101010101010101010101010101010101010101010101010101010101010101"
```

#### `POST /api/v1/cameras/{camera}/snapshots`

Requires `capture` and the MQTT capture channel. A successful capture returns raw PNG bytes. Replaying the completed operation can return its stored JSON outcome.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/snapshots HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000019"}

HTTP/1.1 200 OK
Content-Disposition: inline; filename="snapshot.png"
X-Bridge-Correlation-Id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
Content-Type: image/png

[PNG bytes, beginning 89 50 4E 47 0D 0A 1A 0A]
```

#### `POST /api/v1/cameras/{camera}/media-sessions`

Requires `media.live`. Choose an advertised `main`, `sub` or `third` stream. The `url` is a logical `/api` URL. Apply the configured public API base when opening it. The session expires at the earlier of two minutes or the login expiry.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/media-sessions HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000020", "stream": "sub"}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000020",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {
    "url": "/api/v1/media/55555555-5555-4555-8555-555555555555",
    "expiresAt": "2026-11-23T17:32:00.000Z",
    "transport": "mjpeg"
  }
}
```

#### `GET /api/v1/media/{media}`

Use the creating session’s cookie. Opening the URL claims the stream. The WUI sends each JPEG with the `wui` multipart boundary.

```http
GET /api/v1/media/55555555-5555-4555-8555-555555555555 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: multipart/x-mixed-replace; boundary=wui

--wui
Content-Type: image/jpeg
Content-Length: 12980

[JPEG frame bytes]
[more parts follow]
```

#### `DELETE /api/v1/media/{media}`

Cancels the caller’s media session.

```http
DELETE /api/v1/media/55555555-5555-4555-8555-555555555555 HTTP/1.1

HTTP/1.1 204 No Content
```

#### `GET /api/v1/cameras/{camera}/talk`

Requires `audio.talk`. Read the format for each camera. An unavailable speaker can return `{"available":false}`.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/talk HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"available": true, "sampleRate": 16000, "blockSamples": 65}
```

#### `POST /api/v1/cameras/{camera}/talk/{session}`

The client chooses a UUIDv4. The WUI binds it to the logged-in session and camera when opening the upstream bridge speaker.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/talk/44444444-4444-4444-8444-444444444444 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"available": true, "sampleRate": 16000, "blockSamples": 65}
```

#### `PUT /api/v1/cameras/{camera}/talk/{session}`

This is one silent 65-sample block. Use the rate and size from the open response, Base64 signed 16-bit little-endian mono data and sequential chunk numbers starting at 0. The WUI forwards each chunk over HTTP.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/talk/44444444-4444-4444-8444-444444444444 HTTP/1.1
Content-Type: application/json

{
  "sequence": 0,
  "pcm": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
}

HTTP/1.1 204 No Content
```

#### `DELETE /api/v1/cameras/{camera}/talk/{session}`

Close the speaker session.

```http
DELETE /api/v1/cameras/11111111-1111-4111-8111-111111111111/talk/44444444-4444-4444-8444-444444444444 HTTP/1.1

HTTP/1.1 204 No Content
```

## WUI recordings and retention

Recording reads use `recordings.view`. Downloading or exporting also requires `recordings.export`. The storage-format grant is `storage.format`. Dates and time-of-day queries refer to the camera’s local clock. Recording and photo IDs come from their respective list endpoints.

#### Camera firmware

`GET /api/v1/cameras/{camera}/firmware?check=true` requires `device.firmware.read`. It returns the model, exact hardware revision, installed version, update permission, current source identifier and the camera's online update offer. Omit `check` to read the installed state without contacting the update service.

`POST /api/v1/cameras/{camera}/firmware` requires `device.firmware.update` and the usual origin and CSRF token. Supply `operationId`, the last read's `source`, and `confirm=true` as query parameters. For a local package also set `file` to the original filename and send the package as an octet-stream body of at most 128 MiB. An empty body starts the camera's offered online upgrade. The WUI verifies the installed version on reconnect. In proxy deployments, configure the external proxy and the Node UI's `BODY_SIZE_LIMIT` to allow the package size. The container defaults to 128 MiB.

#### `GET /api/v1/cameras/{camera}/storage`

`format=true` explicitly requests format-capable cards. `format=false` omits the formatting reference. With no query, the WUI includes it when the user has the format grant.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/storage?format=true HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "cards": [
    {
      "number": 0,
      "kind": "sd",
      "mounted": true,
      "formatted": true,
      "totalBytes": 64000000000,
      "usedBytes": 1000000000,
      "freeBytes": 63000000000,
      "formatSource": "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4"
    }
  ],
  "playbackAvailable": true,
  "cameraTime": "2026-11-23T09:30:00",
  "refreshedAt": "2026-11-23T17:30:00.000Z",
  "streams": ["main", "sub"]
}
```

#### `POST /api/v1/cameras/{camera}/storage/format`

Pass the selected card’s `number` and `formatSource`. When the bridge acknowledges formatting, the WUI returns HTTP 200 with `unverified` and `STORAGE_FORMAT_ACCEPTED`. Refresh storage to check the card.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/storage/format HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000021",
  "slot": 0,
  "source": "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
  "confirm": true
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000021",
  "outcome": "unverified",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "reason": "STORAGE_FORMAT_ACCEPTED"
}
```

#### `GET /api/v1/cameras/{camera}/recordings`

`date` is required. Optional `stream` is `main` or `sub` (default).

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/recordings?date=2026-11-23&stream=sub HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "recordings": [
    {
      "id": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      "start": "2026-11-23T09:30:00",
      "end": "2026-11-23T09:31:00",
      "stream": "sub",
      "sizeBytes": 1920000,
      "kind": "MD"
    }
  ],
  "truncated": false,
  "date": "2026-11-23",
  "stream": "sub"
}
```

#### `GET /api/v1/cameras/{camera}/recordings/{recording}/video`

Use `Range` to seek (`200`, `206` or `416`). Optional `download=1` and `name` request an MP4 attachment. Supply a filename stem with 1–160 letters, digits, underscores or hyphens.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/recordings/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/video?download=1&name=front-door-0930 HTTP/1.1
Range: bytes=0-15

HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 0-15/1920000
Content-Length: 16
Content-Disposition: attachment; filename="front-door-0930.mp4"
Content-Type: video/mp4

[16 MP4 bytes, hex: 00 00 00 20 66 74 79 70 69 73 6F 6D 00 00 02 00]
```

#### `GET /api/v1/cameras/{camera}/recordings/{recording}/preview`

Optional `offsetMs` is 0–86400000. Use the returned offset header when placing the JPEG on a timeline.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/recordings/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/preview?offsetMs=3000 HTTP/1.1

HTTP/1.1 200 OK
X-Preview-Offset-Ms: 3000
Content-Type: image/jpeg

[JPEG bytes, beginning FF D8 FF]
```

#### `GET /api/v1/cameras/{camera}/recordings/{recording}/metadata`

The first page is 0. Follow non-null `nextPage` values. Object boxes can use `normalized_top_left` or `pixels_top_left` coordinates.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/recordings/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/metadata?page=0 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "source": "recording",
  "frames": [{"offsetMs": 1000, "objects": [{"class": "person", "tracking_id": "1", "confidence": 0.9}]}],
  "truncated": false,
  "nextPage": null
}
```

#### `GET /api/v1/cameras/{camera}/time-lapse/photos`

Returns dated photos on the requested day plus a count of entries without a time.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/time-lapse/photos?date=2026-11-23 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "date": "2026-11-23",
  "undatedCount": 0,
  "photos": [
    {
      "id": "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
      "capturedAt": "2026-11-23T09:30:00"
    }
  ]
}
```

#### `GET /api/v1/cameras/{camera}/time-lapse/photos/nearest`

For an undated capture, search around `second` (seconds since local midnight) within `radius` seconds. Both allow 0–86399. Returns `{"photo":null}` when there is no match.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/time-lapse/photos/nearest?date=2026-11-23&second=34200&radius=60 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "photo": {
    "id": "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    "capturedAt": "2026-11-23T09:30:00"
  }
}
```

#### `GET /api/v1/cameras/{camera}/time-lapse/photos/{photo}/preview`

`date` is required so the WUI can renew an expired photo reference.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/time-lapse/photos/b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2/preview?date=2026-11-23 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: image/jpeg

[JPEG bytes, beginning FF D8 FF]
```

#### `GET /api/v1/cameras/{camera}/recordings/export`

Without `download=1` the response counts matching entries. `kind=videos` searches both main and sub. `kind=photos` supports paired, inclusive `from` and `to` in `HH:MM:SS`.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/recordings/export?kind=videos&date=2026-11-23 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"count": 2}
```

#### `GET /api/v1/cameras/{camera}/recordings/export` · download

With `download=1` a nonempty selection returns a ZIP of MP4 clips or PNG photos. An empty selection returns `404`.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/recordings/export?kind=photos&date=2026-11-23&from=09:00:00&to=10:00:00&download=1 HTTP/1.1

HTTP/1.1 200 OK
Content-Disposition: attachment; filename="front-door_2026-11-23_09-00-00_10-00-00_photos.zip"
Content-Type: application/zip

[ZIP archive bytes, beginning 50 4B 03 04]
```

#### `GET /api/v1/cameras/{camera}/media-retention`

Instance administrators can inspect cleanup rules. An unreachable or unsupported camera can yield `support: null` and an `unavailable` flag.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/media-retention HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "rules": [
    {
      "kind": "video",
      "days": 30,
      "last_checked": null,
      "last_deleted": 0,
      "last_skipped": 0,
      "last_error": null,
      "last_reference": null
    }
  ],
  "support": {"video": true, "timeLapse": true}
}
```

#### `PUT /api/v1/cameras/{camera}/media-retention`

Instance administrators set both kinds. Each value is a day count from 1 to 36500 or null to disable that rule. The retention worker deletes eligible original files on the camera. This write returns rules directly.

```http
PUT /api/v1/cameras/11111111-1111-4111-8111-111111111111/media-retention HTTP/1.1
Content-Type: application/json

{"video": 30, "timeLapse": null}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "rules": [
    {
      "kind": "video",
      "days": 30,
      "last_checked": null,
      "last_deleted": 0,
      "last_skipped": 0,
      "last_error": null,
      "last_reference": null
    }
  ]
}
```

## WUI enrollment and camera users

Enrollment routes require instance administrator access. Per-camera `/users` and `/rotation` require the camera’s `device.rotate` grant. WUI instance accounts have their own `/admin/accounts` endpoints.

#### `GET /api/v1/admin/bridges/{bridge}/enrollment-targets`

```http
GET /api/v1/admin/bridges/home/enrollment-targets HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"addressLookup": true, "enableRtsp": true, "targets": ["staging"]}
```

#### `GET /api/v1/admin/bridges/{bridge}/enrollment-targets/identify`

Pass the configured private IPv4 address, optional port, and `method=initialize` or `method=import`. Use the returned target and identity when enrolling.

```http
GET /api/v1/admin/bridges/home/enrollment-targets/identify?address=192.168.10.24&port=9000&method=import HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "target": "front-door",
  "address": "192.168.10.24",
  "port": 9000,
  "uid": "952700EXAMPLE123",
  "serial": null,
  "model": "Lumus E430"
}
```

#### `GET /api/v1/enrollments`

Lists the latest 100 WUI enrollment records.

```http
GET /api/v1/enrollments HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "enrollments": [{"id": "33333333-3333-4333-8333-333333333333", "bridge_id": "home", "created": 1795455000000}]
}
```

#### `POST /api/v1/enrollments`

`operationId` is also the enrollment ID. The WUI returns its camera UUID in `data.cameraId` once it can map the active device. `address` and `port` travel together for a configured target. An initialization requires `uid`.

```http
POST /api/v1/enrollments HTTP/1.1
Content-Type: application/json

{
  "operationId": "33333333-3333-4333-8333-333333333333",
  "bridge": "home",
  "target": "front-door",
  "uid": "952700EXAMPLE123",
  "address": "192.168.10.24",
  "port": 9000,
  "method": "import",
  "enableRtsp": true,
  "confirmation": true
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "33333333-3333-4333-8333-333333333333",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {
    "status": "active",
    "cameraId": "11111111-1111-4111-8111-111111111111",
    "rtsp": "enabled",
    "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

#### `GET /api/v1/enrollments/{enrollment}`

Reads the saved enrollment’s upstream status.

```http
GET /api/v1/enrollments/33333333-3333-4333-8333-333333333333 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "active",
  "cameraId": "11111111-1111-4111-8111-111111111111",
  "rtsp": "enabled",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

#### `POST /api/v1/enrollments/{enrollment}/resume`

Use a fresh `operationId` for the resume. `method` can be omitted or set to `import`. The URL retains the original enrollment ID.

```http
POST /api/v1/enrollments/33333333-3333-4333-8333-333333333333/resume HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000022", "method": "import"}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000022",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {
    "status": "active",
    "cameraId": "11111111-1111-4111-8111-111111111111",
    "rtsp": "enabled",
    "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

#### `GET /api/v1/cameras/{camera}/users`

User records use `bridgeLogin` in the WUI response. If `requiresUid` is true, include the printed UID in the write.

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/users HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "writable": true,
  "manageAccounts": true,
  "requiresUid": false,
  "users": [{"username": "admin", "administrator": true, "bridgeLogin": true}]
}
```

#### `POST /api/v1/cameras/{camera}/users`

`role` can be `user` or `administrator`. The camera password is 8–31 printable ASCII characters.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/users HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000023",
  "action": "add",
  "username": "patio-user",
  "confirmation": true,
  "role": "user",
  "password": "Example-only-456"
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000023",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"status": "verified", "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
}
```

#### `POST /api/v1/cameras/{camera}/users` · remove

Removes a camera-local account.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/users HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000024",
  "action": "remove",
  "username": "patio-user",
  "confirmation": true
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000024",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"status": "verified", "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
}
```

#### `POST /api/v1/cameras/{camera}/users/password`

Sets the password of the selected camera user.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/users/password HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000025",
  "username": "patio-user",
  "confirmation": true,
  "password": "Example-only-456"
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000025",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"status": "verified", "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
}
```

#### `GET /api/v1/cameras/{camera}/rotation`

```http
GET /api/v1/cameras/11111111-1111-4111-8111-111111111111/rotation HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{"status": "not-started", "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
```

#### `POST /api/v1/cameras/{camera}/rotation`

The two WUI actions share this URL. `rotate` initiates the change. `reconcile` checks staged credentials. Both require a new operation UUID and explicit confirmation.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/rotation HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000026", "action": "rotate", "confirmation": true}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000026",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"status": "restart-required", "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
}
```

#### `POST /api/v1/cameras/{camera}/rotation` · reconcile

Example reconciliation result.

```http
POST /api/v1/cameras/11111111-1111-4111-8111-111111111111/rotation HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000027", "action": "reconcile", "confirmation": true}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000027",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"status": "verified", "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
}
```

## WUI instance administration

All calls in this section require an instance administrator. Use the normal WUI session, origin and CSRF header for writes. An `operationId` is required only on the routes that show one.

#### `GET /api/v1/admin`

Example for a newly bootstrapped local instance. A configured instance also returns discovered camera rows, bridge connection settings, available event sources, grants, and an `oidcGroups` policy when OIDC is enabled. `permissions` and `presets` are the grant vocabulary for this build.

```http
GET /api/v1/admin HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "appearanceDefaults": {"palette": "d4rk", "theme": "dark", "font": "system-stack", "contentWidth": "standard"},
  "inventoryIntervalSeconds": 10,
  "accounts": [
    {
      "id": "88888888-8888-4888-8888-888888888888",
      "label": "Installer",
      "username": "installer",
      "admin": 1,
      "enabled": 1,
      "types": ["local"]
    }
  ],
  "externalTypes": [],
  "grants": [],
  "permissions": [
    "view",
    "events",
    "media.live",
    "capture",
    "recordings.view",
    "recordings.export",
    "storage.format",
    "audio.talk",
    "ptz.read",
    "ptz.write",
    "settings.spotlight.read",
    "settings.spotlight.write",
    "settings.leds.read",
    "settings.leds.write",
    "settings.audio.read",
    "settings.audio.write",
    "settings.privacy.read",
    "settings.privacy.write",
    "settings.delivery.read",
    "settings.delivery.write",
    "settings.motion.read",
    "settings.motion.write",
    "settings.ai.read",
    "settings.ai.write",
    "settings.image.read",
    "settings.image.write",
    "settings.recording_schedule.read",
    "settings.recording_schedule.write",
    "settings.time_lapse.read",
    "settings.time_lapse.write",
    "settings.network.read",
    "settings.network.write",
    "settings.clock.read",
    "settings.clock.write",
    "settings.encoding.read",
    "settings.encoding.write",
    "alerts.read",
    "alerts.write",
    "device.rotate"
  ],
  "presets": {
    "viewer": ["view", "events", "media.live"],
    "operator": [
      "view",
      "events",
      "media.live",
      "capture",
      "recordings.view",
      "recordings.export",
      "audio.talk",
      "ptz.read",
      "ptz.write",
      "settings.spotlight.read",
      "settings.spotlight.write",
      "settings.leds.read",
      "settings.leds.write",
      "settings.audio.read",
      "settings.audio.write",
      "settings.privacy.read",
      "settings.privacy.write",
      "settings.delivery.read",
      "settings.delivery.write",
      "settings.motion.read",
      "settings.time_lapse.read",
      "settings.network.read",
      "settings.clock.read",
      "alerts.read"
    ],
    "camera-admin": [
      "view",
      "events",
      "media.live",
      "capture",
      "recordings.view",
      "storage.format",
      "ptz.read",
      "ptz.write",
      "settings.spotlight.read",
      "settings.spotlight.write",
      "settings.leds.read",
      "settings.leds.write",
      "settings.audio.read",
      "settings.audio.write",
      "settings.privacy.read",
      "settings.privacy.write",
      "settings.delivery.read",
      "settings.delivery.write",
      "settings.motion.read",
      "settings.motion.write",
      "settings.ai.read",
      "settings.ai.write",
      "settings.image.read",
      "settings.image.write",
      "settings.recording_schedule.read",
      "settings.recording_schedule.write",
      "settings.time_lapse.read",
      "settings.time_lapse.write",
      "settings.network.read",
      "settings.network.write",
      "settings.clock.read",
      "settings.clock.write",
      "settings.encoding.read",
      "settings.encoding.write",
      "alerts.read",
      "alerts.write",
      "device.rotate"
    ]
  },
  "external": false,
  "local": true,
  "bridges": [],
  "cameras": []
}
```

### Bridge connections and callbacks

#### `POST /api/v1/admin/bridges/test`

Tests a draft without saving it. `results` has one entry per transport, with `passed`, `failed` or `disabled`, elapsed milliseconds, and an optional failure category. Uses the bridge contract, inventory and feed subscriptions.

```http
POST /api/v1/admin/bridges/test HTTP/1.1
Content-Type: application/json

{
  "configuration": {
    "id": "home",
    "label": "Home",
    "commands": "http",
    "http": {"url": "https://bridge.example", "token": "example-bridge-token-replace-me"},
    "callbacks": {"porchReceiver": "https://receiver.example/camera-events"}
  }
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "results": [
    {"source": "http", "transport": "HTTPS", "status": "passed", "elapsedMs": 27},
    {"source": "ws", "transport": "WSS", "status": "passed", "elapsedMs": 35},
    {"source": "mqtt", "transport": "MQTT", "status": "disabled", "elapsedMs": 0}
  ],
  "cameraCount": 1
}
```

#### `POST /api/v1/admin/bridges`

Creates a bridge connection. Configure `http`, `ws`, `mqtt` or a supported combination. Optional `cameraIds` scopes discovery. `commands` selects `http` or `mqtt`, `capture` can select `mqtt`, and `callbacks` maps destination names to exact receiver URLs.

```http
POST /api/v1/admin/bridges HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000030",
  "configuration": {
    "id": "home",
    "label": "Home",
    "commands": "http",
    "http": {"url": "https://bridge.example", "token": "example-bridge-token-replace-me"},
    "callbacks": {"porchReceiver": "https://receiver.example/camera-events"}
  }
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000030",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"id": "home"}
}
```

#### `PUT /api/v1/admin/bridges/{bridge}`

Supply the replacement configuration. Retained transport entries inherit their saved token or password when omitted. The body ID, if supplied, must match the path.

```http
PUT /api/v1/admin/bridges/home HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000031",
  "configuration": {
    "id": "home",
    "label": "House cameras",
    "commands": "http",
    "http": {"url": "https://bridge.example"},
    "callbacks": {"porchReceiver": "https://receiver.example/camera-events"}
  }
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000031",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"id": "home"}
}
```

#### `POST /api/v1/admin/bridges/{bridge}/sync`

Refresh bridge inventory and synchronize WUI camera records.

```http
POST /api/v1/admin/bridges/home/sync HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000028"}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000028",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"refreshedAt": "2026-11-23T17:30:00.000Z"}
}
```

#### `POST /api/v1/admin/bridges/{bridge}/restart`

`confirmBridge` must match the route ID. Optional `exitCode` (0–255) defaults to 0. `reason` is optional, up to 512 characters. Success confirms that the bridge accepted termination.

```http
POST /api/v1/admin/bridges/home/restart HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000029",
  "confirmBridge": "home",
  "exitCode": 75,
  "reason": "Scheduled maintenance"
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000029",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

#### `PUT /api/v1/admin/bridges/{bridge}/event-sources`

Supply an ordered, nonempty list of distinct available sources from `ws`, `mqtt` and `api`.

```http
PUT /api/v1/admin/bridges/home/event-sources HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000032", "sources": ["ws", "api"]}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000032",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"sources": ["ws", "api"]}
}
```

#### `GET /api/v1/admin/bridges/{bridge}/callbacks`

Returns destination names allowed for writes and callback camera filters mapped to WUI camera UUIDs. The displayed `destination` on an existing rule is the URL origin or `Stored privately`.

```http
GET /api/v1/admin/bridges/home/callbacks HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "callbacks": [
    {
      "id": "porch",
      "destination": "https://receiver.example",
      "cameras": ["11111111-1111-4111-8111-111111111111"],
      "events": ["doorbell"]
    }
  ],
  "destinations": ["porchReceiver"]
}
```

#### `POST /api/v1/admin/bridges/{bridge}/callbacks`

For `add` or `update` send the destination key, WUI camera UUIDs and event filters. The WUI resolves the key and camera IDs before forwarding the rule.

```http
POST /api/v1/admin/bridges/home/callbacks HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000033",
  "action": "add",
  "id": "porch",
  "destination": "porchReceiver",
  "cameras": ["11111111-1111-4111-8111-111111111111"],
  "events": ["doorbell"]
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000033",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": [
    {
      "id": "porch",
      "destination": "https://receiver.example",
      "cameras": ["11111111-1111-4111-8111-111111111111"],
      "events": ["doorbell"]
    }
  ]
}
```

#### `POST /api/v1/admin/bridges/{bridge}/callbacks` · update

Replace the rule’s filters.

```http
POST /api/v1/admin/bridges/home/callbacks HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000034",
  "action": "update",
  "id": "porch",
  "destination": "porchReceiver",
  "cameras": ["11111111-1111-4111-8111-111111111111"],
  "events": ["motion"]
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000034",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": [
    {
      "id": "porch",
      "destination": "https://receiver.example",
      "cameras": ["11111111-1111-4111-8111-111111111111"],
      "events": ["motion"]
    }
  ]
}
```

#### `POST /api/v1/admin/bridges/{bridge}/callbacks` · remove

Removal requires confirmation.

```http
POST /api/v1/admin/bridges/home/callbacks HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000035", "action": "remove", "id": "porch", "confirmation": true}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000035",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bridgeCorrelationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": []
}
```

### Accounts, identities and camera grants

#### `POST /api/v1/admin/accounts`

Supply `local`, `identity` or both. A local username uses 3–64 lowercase letters, digits, dots, underscores or hyphens and starts with a letter or digit. A new WUI password needs 12–512 characters. The external identity form is `{"type":"oauth","subject":"operator-id"}` or type `headers`.

```http
POST /api/v1/admin/accounts HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000036",
  "label": "Operator",
  "local": {"username": "operator", "password": "Example-login-password"}
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000036",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"id": "22222222-2222-4222-8222-222222222222"}
}
```

#### `POST /api/v1/admin/accounts/{account}/identities`

Link a configured external provider identity to this WUI account.

```http
POST /api/v1/admin/accounts/22222222-2222-4222-8222-222222222222/identities HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000037",
  "identity": {"type": "headers", "subject": "operator-id"}
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000037",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

#### `PUT /api/v1/admin/accounts/{account}/local`

Adds local credentials to an existing account that has no local username.

```http
PUT /api/v1/admin/accounts/22222222-2222-4222-8222-222222222222/local HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000038",
  "username": "operator",
  "password": "Example-login-password"
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000038",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

#### `PATCH /api/v1/admin/accounts/{account}`

Enables or disables a non-admin account. Disabling invalidates its sessions.

```http
PATCH /api/v1/admin/accounts/22222222-2222-4222-8222-222222222222 HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000039", "enabled": false, "confirmation": true}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000039",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

#### `PUT /api/v1/admin/accounts/{account}/grants/{camera}`

Target a non-admin account. Choose `none`, `viewer`, `operator` or `camera-admin`, then add or remove explicit grants. Use the current permission list from `GET /admin`. `allow` and `deny` must be disjoint.

```http
PUT /api/v1/admin/accounts/22222222-2222-4222-8222-222222222222/grants/11111111-1111-4111-8111-111111111111 HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000040", "preset": "viewer", "allow": ["capture"], "deny": []}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000040",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"permissions": ["capture", "events", "media.live", "view"]}
}
```

#### `DELETE /api/v1/admin/accounts/{account}`

Supply the confirmation in the JSON body. An administrator can delete another account.

```http
DELETE /api/v1/admin/accounts/22222222-2222-4222-8222-222222222222 HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000041", "confirmation": true}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000041",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

#### `PUT /api/v1/admin/oidc-groups`

The mode is `any` or `all`. This route is available for OIDC when the group policy is managed by the WUI. Changing the policy invalidates existing OIDC sessions.

```http
PUT /api/v1/admin/oidc-groups HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000042",
  "requiredGroups": ["camera-operators"],
  "requiredGroupsMode": "any"
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000042",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

### Instance settings and audit history

#### `PUT /api/v1/admin/appearance-defaults`

All four appearance fields are required.

```http
PUT /api/v1/admin/appearance-defaults HTTP/1.1
Content-Type: application/json

{
  "operationId": "77777777-7777-4777-8777-000000000043",
  "appearance": {"palette": "d4rk", "theme": "dark", "font": "system-stack", "contentWidth": "standard"}
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000043",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"appearance": {"palette": "d4rk", "theme": "dark", "font": "system-stack", "contentWidth": "standard"}}
}
```

#### `PUT /api/v1/admin/inventory-settings`

Sets the inventory refresh interval to 1–86400 seconds.

```http
PUT /api/v1/admin/inventory-settings HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000044", "intervalSeconds": 30}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000044",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {"intervalSeconds": 30}
}
```

#### `GET /api/v1/admin/event-history`

Returns the active backend, connection status, limit, saved storage mode and configured defaults.

```http
GET /api/v1/admin/event-history HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "backend": "memory",
  "limit": 100,
  "connected": true,
  "storage": {"mode": "defaults"},
  "defaults": {"backend": "memory"}
}
```

#### `POST /api/v1/admin/event-history/test`

Tests connection settings. `mode: "defaults"` tests a configured Valkey default. An unsuccessful test can return `{"connected":false,"failure":"authorization"}`.

```http
POST /api/v1/admin/event-history/test HTTP/1.1
Content-Type: application/json

{"mode": "valkey", "valkey": {"url": "redis://cache.example:6379/0", "rejectUnauthorized": true}}

HTTP/1.1 200 OK
Content-Type: application/json

{"connected": true, "elapsedMs": 12}
```

#### `PUT /api/v1/admin/event-history`

Set the in-memory/display retention limit to 0–1000. Omit `storage` to change the limit alone. Storage modes are `defaults`, `memory` and `valkey`. A Valkey configuration takes `url` and can include `password`, `ca`, `rejectUnauthorized`, `keyPrefix`, `maxEvents` or `ttlSeconds`.

```http
PUT /api/v1/admin/event-history HTTP/1.1
Content-Type: application/json

{"operationId": "77777777-7777-4777-8777-000000000045", "limit": 100, "storage": {"mode": "memory"}}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "77777777-7777-4777-8777-000000000045",
  "outcome": "confirmed",
  "correlationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "data": {
    "backend": "memory",
    "limit": 100,
    "connected": true,
    "storage": {"mode": "memory"},
    "defaults": {"backend": "memory"}
  }
}
```

#### `GET /api/v1/admin/audit`

Returns up to 100 entries, newest first. Audit rows use database-style `bridge_correlation` and Unix milliseconds for `created`.

```http
GET /api/v1/admin/audit HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "entries": [
    {
      "actor": "88888888-8888-4888-8888-888888888888",
      "resource": "bridge:home",
      "action": "bridge.sync",
      "outcome": "confirmed",
      "operation": "77777777-7777-4777-8777-000000000028",
      "correlation": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bridge_correlation": null,
      "created": 1795455000000
    }
  ]
}
```

## WUI calls to the bridge

The WUI resolves the signed-in user’s camera UUID to the bridge’s route ID. For HTTP camera calls it sends the bridge bearer token and, when available, the wire identity in `X-Camera-Stable-Id`. In this table `…` abbreviates `/api/cameras/{camera}` on the bridge.

| WUI activity | Bridge requests or source |
| --- | --- |
| Connection checks and camera discovery | `GET /api/contract`, `GET /api/inventory`. Older-bridge connectivity fallback uses `GET /livez`. |
| Live events and state | Connect to `/ws` and send `subscribe` or `snapshot`, or open `GET /api/events` for the HTTP event source. The WUI also supports an MQTT feed. Browser delivery always uses WUI SSE. |
| PTZ, setting updates and alerts | With HTTP commands selected, `POST /api/cameras/{camera}/command/exec` carries `{id,command}`. The WUI maps `operationId` to `id`. A fresh read uses `GET /api/cameras/{camera}/settings/{group}`. |
| Encoding, clock, display and general options | WUI reads and writes use the bridge resource of the same name under `/api/cameras/{camera}`. The WUI validates readbacks and wraps writes in operation results. Its `/ftp` maps to bridge `/options/ftpDestination`. |
| Networking and audio | `GET/PUT /api/cameras/{camera}/network` and `/network/rtsp`, `PUT …/network/wifi`, `GET …/talk`, then `POST/PUT/DELETE …/talk/{token}`. Talk remains HTTP for the duration of the session. |
| Live media and previews | `GET …/preview` for cached JPEGs. Direct playback opens `GET …/media/{stream}`. A configured RTSP proxy supplies its own video input. Preset snapshots combine PTZ commands and either MQTT capture or a fresh bridge preview. |
| SD storage and video | `GET …/storage`, `POST …/storage/format`, `GET …/recordings` and `GET …/recordings/{recording}/video`, `/preview` or `/metadata`. The WUI forwards byte ranges for video. |
| Time-lapse and export | `GET …/time-lapse/photos` and `GET …/time-lapse/photos/{photo}`. The WUI uses `?preview=true` for thumbnails. Nearest-photo lookup issues bounded time-window searches. ZIP export searches and downloads the selected files through the same recording/photo APIs. |
| Retention worker | `GET …/media/capabilities`, `/media/days`, `/media/files`, then `POST …/media/delete` for selected expired files. The browser edits the WUI policy. |
| Enrollment and credential management | Bridge `/api/enrollment-targets`, `/api/enrollment-targets/identify`, `/api/enrollments`, `/api/enrollments/{enrollment}` and `/resume`. Camera user edits use `…/users` or `…/users/password`. Rotation actions use `…/rotation` or `…/rotation/reconcile`. |
| Callbacks and restart | Bridge `GET/POST /api/callbacks`, `PUT/DELETE /api/callbacks/{callback}` and `POST /api/terminate`. |
| Instance accounts, grants, appearance, camera order, audit and operations | The WUI owns these resources. Their browser-facing request and response examples are in the WUI sections above. |

## Implementation sources

The WUI registers its Fastify routes by feature. Its live handler serves browser SSE, and its channel client consumes bridge events. [API entry point](../server/api.ts) · [Feature route handlers](../server) · [Browser event stream](../server/live.ts) · [Upstream clients](../server/bridge-channels.ts) · [SvelteKit proxy](../src/hooks.server.ts)
