# Deployment

Keep `./local-only/` (or your mounted configuration and secrets location) private. Pass its JSON5 config path with `WUI_CONFIG` to both processes. Whole-string `${ENV_VAR}` references return a string or null; `${file:relative/path}` and `${file:$PATH_VAR}` read a bounded relative file reference and preserve contents. Bind camera management and the broker to private networks. Restrict WUI egress to the configured bridge, broker, database and OIDC issuer. The browsers receive only WUI session material. Camera/device credentials live in the private bridge.

- **Browser mode:** use one HTTPS ingress with `browserBasePath` (default `/api`) routed to Node and the rest routed to SvelteKit. Preserve the configured prefix on Node. Set `publicOrigin` to the browser origin.
- **Proxy mode:** route the browser to SvelteKit. Its API proxy path defaults to `/api-proxy`; fixed upstream origin and prefix are required. Set `forward.secret` to an independent random value and `forward.peers` to the actual SvelteKit socket addresses on Node. Both apps read the same settings. The hop preserves cookies, SSE and streamed media. Do not buffer these responses at ingress.
- Use HTTPS for routed connections. Only loopback endpoints may be configured as plaintext for outgoing connections. For a TLS Node listener set `listen.tls.cert` and `listen.tls.key` using file references; omitting both creates an ephemeral self-signed certificate with configured SANs at startup. `listen.tls.serverNames` adds internal DNS/IP names. Set per-endpoint `ca` PEM references where a private CA is needed. For the adapter-node UI use a local TLS ingress and set `ORIGIN` to the external URL.

## Identities

Choose a single `auth.mode`: `local`, `oidc`, `oidc+local`, `proxy-headers` or `proxy-headers+local`. Bootstrap command works only when the database has no accounts. For an external administrator, use `npm run admin -- bootstrap external '<verified-subject>' 'Instance administrator'`. Identify an OIDC person by its verified `sub` from the configured issuer (not email or username). Administrators link verified identities from the administration screen. New accounts have no camera grants.

Set `localSessionMinutes` in `WUI_CONFIG` to control how long new password sessions last. For example, `localSessionMinutes: 10080` gives the browser cookie and server session a seven-day lifetime. It accepts whole minutes from 5 to 525600. When omitted, password sessions use `sessionMinutes` (480 minutes by default). Sign out and back in to get a session with the new lifetime.

For OIDC configure `auth.oidc = { issuer, clientId, clientSecret, tokenEndpointAuth, ca }`. The exact redirection URL is `<publicOrigin><active browser API prefix>/v1/session/oidc/callback`. The discovery document, authorization endpoint, token endpoint and keys must be on the configured issuer origin. For [Authelia](https://www.authelia.com/configuration/identity-providers/openid-connect/clients/), register a confidential client with code grant, `openid` scope, `require_pkce: true`, `pkce_challenge_method: S256`, and `client_secret_basic` (or configure `client_secret_post` at both ends).

For trusted header modes configure `auth.ingress = { issuer, peers, secret, identityHeader: 'remote-user' }`. At ingress strip incoming identity, ingress proof and forward headers. Populate the identity exclusively from the [trusted authentication service](https://www.authelia.com/integration/trusted-header-sso/introduction/) and add `X-WUI-Ingress-Proof` with the configured secret. WUI verifies both the socket peer and secret. In proxy mode SvelteKit verifies ingress itself and forwards only the verified subject using the independent Node hop key. Do not set the adapter-node `ADDRESS_HEADER` in these modes. In combined mode permit browser access to the UI and API through the local sign-in bypass path at ingress, while still stripping identity/proof headers and leaving WUI session checks in force. Clear the old WUI session when switching accounts.

## Bridges

Configure one record per bridge. Set `http` for the bridge API and `mqtt` for its broker connection. Choose `commands: "http"` or `commands: "mqtt"` and set `capture: "mqtt"` for on-demand image capture. The broker identity needs read access to each camera's event and state topics and command results. For MQTT commands or captures it also needs write access to each camera's command requests. [Bridge HTTP API](https://github.com/Slyke/reolink-bridge/blob/master/docs/api.md)

WUI queries `GET /api/inventory` and subscribes to the exact topics for active cameras. With neither camera list configured, new cameras are picked up once the bridge activates them and the broker ACL permits access. Use `cameraIds` to restrict the visible cameras. `mqtt.cameraIds` limits MQTT subscriptions and also supplies the visible scope if `cameraIds` is omitted. For an older bridge without the HTTP inventory endpoint, enter the exact camera IDs.

Configure the inventory scan interval under **Settings → Private bridges**. It defaults to 10 seconds and accepts 1 through 86400. The **Refreshed at** timestamp in Settings records the last manual inventory refresh.

Omit `events` to use WS/WSS as the primary event and state feed when a bridge endpoint is configured. MQTT is the default standby. The WUI keeps both feeds subscribed and uses the preferred one when it is ready. Status marks the active and standby connections.

Set `events: { primary: "mqtt", secondary: "ws" }` to prefer MQTT. The `events: "mqtt"` and `events: "ws"` forms select a single event feed. By default WS/WSS uses `/ws` at the `http` endpoint with the same token and CA. For a custom path or credential, set `ws: { url, token, ca }`. If using a scoped bridge API token, enable `api.events` on the bridge for WebSocket read access.

For MQTT TLS over an authenticated tunnel that provides only the broker leaf certificate, set `mqtt.ca` to the explicitly trusted certificate and `mqtt.allowPartialTrustChain: true`. The client still verifies the hostname and certificate validity. With an issuer CA available, configure that CA and leave partial trust disabled.

## Enrollment and callbacks

In the bridge's `api` config, set `adminToken`, a persistent `storageDirectory`, and a named target with the device host, Baichuan port, and camera ID. For an initialized camera, put its credential in the bridge target's `importPassword`. Use a dedicated admin token alongside the HTTP token in the WUI bridge record. [Bridge configuration](https://github.com/Slyke/reolink-bridge/blob/master/docs/api.md#authorization-and-enrollment)

```json5
http: {
  url: "https://bridge.example.invalid:8080",
  token: "${file:bridge-http.token}",
  adminToken: "${file:bridge-admin.token}",
  ca: "${file:bridge-ca.pem}",
},
```

Restart the configured services and open **Settings → Enrollment**. Enter or scan the printed UID or serial, select a bridge and named target, and choose **Import** for an initialized camera or **Initialize** for a supported factory device. Use the Wi-Fi join QR for supported Wi-Fi models. After verification, restart reolink-bridge to activate the device and refresh inventory.

For callbacks, prepare a receiver that accepts event JSON via HTTP POST and returns a 2xx response. Add the exact URL to the WUI bridge record, for example `callbacks: { alerts: "https://alerts.example.invalid/events" }`. Allow the same URL in `api.callbackDestinations` on the bridge. Use the bridge HTTP token or a service token with bridge-wide scope. Restart the configured services and open **Settings → Bridge callbacks**. Choose the bridge and approved receiver, then add a callback ID and optional event and camera filters. [Bridge callback payloads and filters](https://github.com/Slyke/reolink-bridge/blob/master/docs/interfaces.md#manage-downstream-callbacks)

On Kubernetes, use top-level bridge `callbacks` entries in a ConfigMap and restart reolink-bridge to apply them. Editing callbacks from the WUI requires the bridge config file to be in a writable persistent directory, because the bridge replaces the file atomically.

## Camera playback

Dashboard and Monitor read cached JPEGs from Reolink Bridge every two seconds. The bridge sets the capture interval and can persist the latest frame in Valkey. **Refresh live view** requests a fresh bridge preview. **Refresh on alert** can request the same refresh when an authorized detection starts. **Take snapshot** independently requests a fresh PNG from the camera through the bridge’s configured MQTT capture path. [Bridge preview settings](https://github.com/Slyke/reolink-bridge/blob/master/docs/api.md#background-camera-previews)

**Bridge camera relay** is the default source for continuous video. Use a reolink-bridge build with the HTTP media API and FFmpeg. Add a preview entry and video profile to the bridge configuration. This example uses the substream on the camera with ID `lumus`.

```json5
api: {
  previews: { cameras: { lumus: {} } },
  media: { lumus: { port: 554, streams: ["sub"] } },
},
```

The relay reads H.264 over RTSP/TCP with the configured camera credentials. In the WUI bridge record set `http` to the bridge HTTPS endpoint, bearer token, and TLS trust reference. When the bridge advertises a video profile, WUI enables relay playback by default. Set `http.relay: false` to disable that playback path. [Bridge video and preview API](https://github.com/Slyke/reolink-bridge/blob/master/docs/api.md)

For an external video source, open **Settings → Camera settings → Playback** and select **RTSP proxy**. Enter a credential-free private RTSP/TCP restream URL that the WUI API can reach. For Frigate, use `rtsp://frigate-host:8554/stream-name` with the configured go2rtc stream name. The API container includes FFmpeg. [Frigate RTSP setup](https://docs.frigate.video/configuration/restream/)

Each WUI API process shares one upstream video connection per camera and stream quality while authorized viewers are watching. Viewer grants and session expiry apply to each viewer independently.

## Event history

Set the count per camera in **Settings → Event history**. The starting count is 100 and the settings range is 0–1000. Set 0 to clear stored history while keeping the live feed. The default memory backend keeps events until the API restarts and persists the retention setting in the WUI database.

Set `eventHistory: { backend: "valkey", url: "${WUI_VALKEY_URL}", keyPrefix: "reolink-wui", retention: 100 }` in WUI config to store events and the retention setting across WUI restarts. Use a dedicated Valkey key prefix per deployment. Enable Valkey persistence to survive a Valkey restart. Remote servers use a `rediss://` URL and can set `eventHistory.ca` for a private CA. A loopback instance can use `redis://`. The WUI records events as they arrive from the connected bridge.

## Database and probes

For SQLite use a single API process with its database and WAL on a protected persistent local volume. Use `sqlite3 PATH ".backup 'backup.sqlite'"` for a consistent backup; stop the API before restoring and keep backups protected. For PostgreSQL use `database: { driver: "postgres", url: "${WUI_DATABASE_URL}", tls: { ca: "${file:pg-ca.pem}" } }`. Provide managed or file-backed credentials; a URL may not override TLS via query parameters. Take regular `pg_dump -Fc` backups and restore to a fresh database with `pg_restore` before switching the API. Both drivers apply the same versioned migrations on startup. Protect and back up the bridge vault independently of the WUI database.

`/livez` checks the process. `/readyz` checks the API's database, selected bridge transports and required OIDC discovery with bounded timeouts. Individual camera offline/stale status is shown only to authorized users. In browser layout route public probes to the API when probing the whole deployment; in proxy layout UI readiness follows the API. Set `LOG_CONSOLE_ENABLED`, `LOG_CONSOLE_FORMAT`, `LOG_CONSOLE_LEVELS`, and `LOG_RUNTIME_ENABLED` using the shared logger contract. The WUI logs generated correlation IDs and safe error keys. Do not log cookies, enrollment request bodies, or upstream payloads at ingress.

## Container

Build the local image with the six deployment metadata values. Use the same artifact in both services.

```sh
docker build -t reolink-wui:dev \
  --build-arg BUILD_VERSION=0.1.0 --build-arg BUILD_HASH=unknown \
  --build-arg BUILD_DATE="$(date -u +%FT%TZ)" --build-arg GIT_SHA=unknown \
  --build-arg GIT_DIRTY=false --build-arg CI_RUN_ID=local .
```

Supply real commit values in CI and tag the image with both version and short hash. The example Compose file uses a shared loopback network namespace for proxy mode and publishes only the UI to the local machine. Give the unprivileged application user access to the mounted config and SQLite directory. Compose 2.24+ accepts an optional `.env` for secret references. This directory, real configs, database dumps and generated keys are outside the image and build context.
