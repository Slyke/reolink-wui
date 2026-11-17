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

Configure one record per private bridge. Select `commands` and `events` independently. Use `capture: "mqtt"` for MQTT captures. Set `mqtt.cameraIds` to the exact broker topic IDs and leave the bridge-wide `cameraIds` empty to discover all cameras via WebSocket. When `mqtt.cameraIds` is omitted, the bridge-wide list supplies the MQTT scope. Give the broker identity access to the configured camera topics and command results, and permission to publish their command requests. A local bridge test uses its own broker and fixtures. Prefer one scoped bridge service token per WUI deployment rather than using a legacy full access token. An MQTT endpoint with no assigned command, event or capture role is used for authenticated broker connectivity in Status. It does not subscribe or publish. See [the private bridge WUI contract](https://github.com/Slyke/reolink-bridge/blob/master/docs/wui.md).

Configure the inventory scan interval under **Settings → Private bridges**. It defaults to 10 seconds and accepts 1 through 86400. The scan polls WUI v1 inventory endpoints and syncs reported cameras. A legacy bridge sends state on WebSocket subscription and as camera snapshots change. After adding a camera to a legacy bridge's config, restart the bridge so the WUI can reconnect and discover it. An explicit bridge camera allowlist limits discovery. The **Refreshed at** timestamp in Settings records the last manual inventory refresh.

For MQTT TLS over an authenticated tunnel that provides only the broker leaf certificate, set `mqtt.ca` to the explicitly trusted certificate and `mqtt.allowPartialTrustChain: true`. The client still verifies the hostname and certificate validity. With an issuer CA available, configure that CA and leave partial trust disabled.

## Enrollment and callbacks

Enrollment requires a reolink-bridge build with WUI v1 enabled. In the bridge's private `wui` config, set distinct `serviceToken` and `adminToken` values, a persistent `storageDirectory`, and a named target with the device host, Baichuan port, and camera ID. For an initialized camera, put its credential in the bridge target's `importPassword`. Configure the WUI bridge record as follows. [Bridge configuration and example](https://github.com/Slyke/reolink-bridge/blob/master/docs/wui.md)

```json5
extensions: {
  url: "https://bridge.example.invalid:8080",
  token: "${file:bridge-service.token}",
  adminToken: "${file:bridge-admin.token}",
  ca: "${file:bridge-ca.pem}",
},
```

Restart the configured services and open **Settings → Enrollment**. Enter or scan the printed UID or serial, select a bridge and named target, and choose **Import** for an initialized camera or **Initialize** for a supported factory device. Use the Wi-Fi join QR for supported Wi-Fi models. After verification, restart reolink-bridge to activate the device and refresh inventory.

For callbacks, prepare a receiver that accepts event JSON via HTTP POST and returns a 2xx response. Add the exact URL to the WUI bridge record, for example `callbacks: { alerts: "https://alerts.example.invalid/events" }`. On a WUI v1 bridge add the same URL to `wui.callbackDestinations` and use the instance-wide service token for WebSocket callback access. Restart the configured services and open **Settings → Bridge callbacks**. Choose the bridge and approved receiver, then add a callback ID and optional event and camera filters. [Bridge callback payloads and filters](https://github.com/Slyke/reolink-bridge/blob/master/docs/interfaces.md#manage-downstream-callbacks)

On Kubernetes, use top-level bridge `callbacks` entries in a ConfigMap and restart reolink-bridge to apply them. Editing callbacks from the WUI requires the bridge config file to be in a writable persistent directory, because the bridge replaces the file atomically.

## Camera playback

Open **Settings → Camera settings**, choose a camera, and save its **Playback** source. **Direct camera** reads the device through reolink-bridge. On supported cameras, `capture: "mqtt"` provides snapshot previews.

For continuous video, deploy a reolink-bridge build with WUI v1 and FFmpeg. Add a service token and a media profile to the bridge's JSON5 config. This example uses the substream on the bridge camera ID `lumus`.

```json5
wui: {
  serviceToken: "${WUI_BRIDGE_SERVICE_TOKEN}",
  media: { lumus: { port: 554, streams: ["sub"] } },
},
```

The relay reads RTSP/TCP using the existing camera host and credentials. The port must be reachable from the bridge and the selected stream must use H.264. Put the token value in the bridge's secret environment and in a protected WUI token file. In the corresponding WUI bridge record, configure `extensions.url` with the bridge HTTPS endpoint, `extensions.token` with the token reference, `extensions.ca` with the TLS trust reference, and `extensions.relay: true`. After restarting both services, select **Direct camera** in the camera's Playback settings. The Monitor offers **Start live stream** when the profile is advertised. [Bridge WUI v1 configuration](https://github.com/Slyke/reolink-bridge/blob/master/docs/wui.md)

**RTSP proxy** accepts a credential-free private TCP restream URL reachable from the WUI API. For Frigate, use `rtsp://frigate-host:8554/stream-name` with its configured go2rtc stream name. The API needs FFmpeg in its PATH. The container includes FFmpeg. [Frigate RTSP setup](https://docs.frigate.video/configuration/restream/)

For bridge-cached previews, configure `wui.previews.cameras` on Reolink Bridge and configure the WUI bridge’s `extensions` service token and HTTPS URL. Dashboard and Monitor check for a changed image every two seconds. The bridge sets the capture interval and can retain the most recent successful JPEG in Valkey. [Bridge preview settings](https://github.com/Slyke/reolink-bridge/blob/master/docs/wui.md#background-camera-previews)

For other preview sources, set the frame preview interval in milliseconds in the same Playback settings. It defaults to 5000 ms and accepts intervals from 50 ms. Dashboard and Monitor start the delay after each frame arrives. **Refresh on alert** can request a frame when an authorized detection starts. Monitor's **Refresh live view** fetches a frame immediately or reconnects the active stream. **Start live stream** opens the selected continuous source. Browsers receive frames and streams through the authenticated WUI API.

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
