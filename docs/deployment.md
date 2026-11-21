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

Use **Settings → Private bridges → Bridge connections** to add bridges and edit each bridge's HTTP API, custom WebSocket endpoint, MQTT broker, command transport, and callback destinations. Connection overrides are stored in `bridges.connection_config` in the configured SQL database. Saved tokens and passwords are retained when their fields are left blank and are masked in UI/API responses. Manual connection credentials are stored with these database overrides.

**Save bridge connection** persists the connection. **Test bridge connection** checks the unsaved draft using read-only API requests, a WebSocket event subscription, and MQTT connectivity/subscriptions. Results are reported separately for HTTP, WS, and MQTT. Testing does not save configuration or send camera commands. Saved credentials are reused when their inputs are blank.

The bridge ID is the WUI's stable identifier for an upstream connection. It links discovered cameras, grants, callbacks, and source preferences to that connection. It does not need to match the bridge's MQTT client ID or Kubernetes service name. Keep it unchanged when moving a bridge to a new URL. Camera IDs are an optional discovery filter. Leave them empty to load all cameras exposed by the bridge's token. Exact IDs are needed for an MQTT-only connection without inventory discovery.

TLS is selected by the URL scheme. Plain `http://`, `ws://`, and `mqtt://` connections are supported. Their TLS counterparts are `https://`, `wss://`, and `mqtts://`. Each transport has its own `rejectUnauthorized` boolean, defaulting to `true`. Supply `ca` for a private CA or self-signed trust anchor, or uncheck **Verify TLS certificate and hostname** to set `rejectUnauthorized: false` for that connection. Inferred WebSocket connections inherit the HTTP connection's trust and verification settings. A custom WebSocket connection has independent settings. No process-wide TLS override is used.

Set the bridge’s `http.token` as the WUI HTTP API token. WUI enforces administrator access for enrollment and the per-camera `device.rotate` permission for password rotation. Callback destinations name the allowed receiver URLs for this WUI connection. **Bridge callbacks** creates the actual delivery rules and their camera/event filters. The same URLs must be allowed by the bridge's `api.callbackDestinations`.

The startup `bridges` array also accepts multiple connections. WUI overrides take precedence for the matching bridge ID. A bridge can use HTTP, WebSocket, MQTT, or a combination. Omit `commands` to disable camera commands. WebSocket defaults to `/ws` on the HTTP endpoint, while an explicit `ws` record supplies independent connection details. Add a separate bridge ID for each upstream service. Camera grants remain scoped to that bridge and its camera IDs.

Configure one record per bridge. Set `http` for the bridge API and `mqtt` for its broker connection. Choose `commands: "http"` or `commands: "mqtt"` and set `capture: "mqtt"` for on-demand image capture. The broker identity needs read access to each camera's event and state topics and command results. For MQTT commands or captures it also needs write access to each camera's command requests. [Bridge HTTP API](https://github.com/Slyke/reolink-bridge/blob/master/docs/api.md)

WUI queries `GET /api/inventory` and subscribes to the exact topics for active cameras. Leave the bridge-level `cameraIds` empty to discover every camera reported by HTTP inventory or WebSocket. Administrators see each discovered camera automatically. Other accounts need a camera grant. Set `mqtt.cameraIds` to restrict subscriptions to the topics allowed by the broker. Cameras outside that list can still use WebSocket or HTTP according to the bridge’s event source priority. For an MQTT-only connection, configure exact camera IDs for discovery.

The bridge identifies a physical camera by its reported serial number, with MAC as a fallback. To move Lumus, change its public ID and update any corresponding preview, relay, callback and MQTT filters. Within the same bridge, WUI retains the camera UUID, grants, playback settings and history when that hardware reappears. During upgrade it binds the existing row on its first hardware identification. A replacement with a different serial receives a new row. In-memory events last for the WUI process lifetime. Valkey events follow the configured retention. [Bridge camera IDs and ConfigMap handoff](https://github.com/Slyke/reolink-bridge/blob/master/docs/api.md#camera-ids-and-configmap-handoff)

Configure the inventory scan interval under **Settings → Private bridges**. It defaults to 10 seconds and accepts 1 through 86400. The **Refreshed at** timestamp in Settings records the last manual inventory refresh.

In **Settings → Private bridges**, the **Restart bridge** button beside **Refresh inventory** opens a confirmation for that bridge's name and ID. Administrators can enter a reason and an exit code from 0 to 255. A successful response means that the bridge accepted the exit request. Its supervisor handles startup.

Configure each bridge's **Event source priority** in its selected **Bridge connections** section under **Settings → Private bridges**. The priority editor follows the bridge selector and never applies to other bridges. Preferences are saved as an ordered array such as `["ws", "mqtt", "api"]` in the WUI database. The first connected source supplies events and camera state. Selected standby feeds stay connected, and an earlier source takes over again when it recovers. Reorder, add, or remove sources in the WUI and save to apply the change immediately.

New bridges default to `["ws", "mqtt", "api"]` when HTTP is configured. Available sources depend on the configured endpoints. Existing file-based `events` preferences are imported into the database once during upgrade, including the earlier primary/secondary object and string forms. Subsequent WUI changes take precedence across restarts.

By default WS/WSS uses `/ws` at the `http` endpoint with the same token and CA. For a custom path, set `ws: { url, ca }` to share the HTTP token. With a WS-only connection, supply the bridge PSK as `ws.token`. The `api` source uses the bridge's authenticated `GET /api/events` HTTP event stream with initial state snapshots, live updates, heartbeats, and gap reporting. Use a bridge build that exposes this endpoint.

For MQTT TLS over an authenticated tunnel that provides only the broker leaf certificate, set `mqtt.ca` to the explicitly trusted certificate and `mqtt.allowPartialTrustChain: true`. The client still verifies the hostname and certificate validity. With an issuer CA available, configure that CA and leave partial trust disabled.

## Enrollment and callbacks

In the bridge configuration, set `api.storageDirectory` to retain enrollment records and put the camera in `cameras[]` with its LAN address, Baichuan port, username and password reference. Use the existing bridge PSK in the WUI bridge record. [Bridge configuration](https://github.com/Slyke/reolink-bridge/blob/master/docs/api.md#authorization-and-enrollment)

```json5
http: {
  url: "https://bridge.example.invalid:8080",
  token: "${file:bridge-http.token}",
  ca: "${file:bridge-ca.pem}",
},
```

Connect the camera to the LAN by Ethernet or its supported Wi-Fi setup method. Open **Settings → Enrollment**, enter its address and choose **Identify camera**. Match the reported UID against its label. Choose **Set first admin password** for a factory camera or **Use an existing password** to verify an initialized camera. The bridge uses the password from its camera configuration.

**Enable RTSP streaming after verifying the camera** starts checked for first-password setup and unchecked for existing-password enrollment. The bridge reads the camera's port settings, enables RTSP when needed, and reports the verified result alongside the registration. A failed or unsupported RTSP change still allows registration to complete. For an enrolled camera, open **Settings → Camera settings → Network and Wi-Fi → RTSP streaming** to read the switch and port or change the switch. This uses the bridge's Baichuan connection.

A separately configured named target under `api.targets` can also be used for enrollment. The enrollment result indicates when a bridge restart is needed.

For callbacks, prepare a receiver that accepts event JSON via HTTP POST and returns a 2xx response. Add the exact URL to the WUI bridge record, for example `callbacks: { alerts: "https://alerts.example.invalid/events" }`. Allow the same URL in `api.callbackDestinations` on the bridge. Use the bridge HTTP token. Restart the configured services and open **Settings → Bridge callbacks**. Choose the bridge and approved receiver, then add a callback ID and optional event and camera filters. [Bridge callback payloads and filters](https://github.com/Slyke/reolink-bridge/blob/master/docs/interfaces.md#manage-downstream-callbacks)

On Kubernetes, use top-level bridge `callbacks` entries in a ConfigMap and restart reolink-bridge to apply them. Editing callbacks from the WUI requires the bridge config file to be in a writable persistent directory, because the bridge replaces the file atomically.

## Camera playback

Dashboard and Monitor read cached JPEGs from Reolink Bridge. **Camera settings → Live view and image → Playback preferences → Preview update interval** defaults to 2 seconds (50 ms minimum). With a connected, configured WebSocket or MQTT source and a bridge advertising preview notifications, WUI fetches only when the cache changes; the interval sets the minimum wait after a frame finishes loading. Without push notifications, it polls at that interval. The bridge controls its separate camera capture interval and can persist previews in Valkey. **Refresh live view** requests a fresh bridge preview. **Refresh on alert** can request the same refresh when an authorized detection starts. **Take snapshot** independently requests a fresh PNG from the camera through the bridge’s configured MQTT capture path. [Bridge preview settings](https://github.com/Slyke/reolink-bridge/blob/master/docs/api.md#background-camera-previews)

**Bridge camera relay** is the default source for continuous video. Use a reolink-bridge build with the HTTP media API and FFmpeg. Add a preview entry and video profile to the bridge configuration. This example uses the substream on the camera with ID `lumus`.

```json5
api: {
  previews: { cameras: { lumus: {} } },
  media: { lumus: { port: 554, streams: ["sub"] } },
},
```

The relay uses the configured camera credentials and accepts H.264 or H.265. Each camera media profile defaults to `transport: "auto"`. If RTSP cannot deliver a first frame, the bridge tries live video over the camera’s Baichuan port. Select `"rtsp"` or `"baichuan"` to require one transport. A background preview is enabled separately by including that camera's ID in `api.previews.cameras`. In the WUI bridge record set `http` to the bridge HTTPS endpoint, bearer token, and TLS trust reference. When the bridge advertises a video profile, WUI enables relay playback by default. Set `http.relay: false` to disable that playback path. [Bridge video and preview API](https://github.com/Slyke/reolink-bridge/blob/master/docs/api.md)

For an external video source, open **Settings → Camera settings → Live view and image → Playback preferences** and select **RTSP proxy**. Enter a credential-free private RTSP/TCP restream URL that the WUI API can reach. For Frigate, use `rtsp://frigate-host:8554/stream-name` with the configured go2rtc stream name. The API container includes FFmpeg. [Frigate RTSP setup](https://docs.frigate.video/configuration/restream/)

Each WUI API process shares one upstream video connection per camera and stream quality while authorized viewers are watching. Viewer grants and session expiry apply to each viewer independently.

## Event history

**Settings → Event history** selects **Use configuration defaults**, **In memory**, or **Valkey**. Defaults use the `eventHistory` block in the startup JSON5 configuration. In-memory mode overrides a configured Valkey backend. Manual Valkey mode accepts a `redis://` or `rediss://` URL, key prefix, optional password, and optional TLS CA certificate. The screen reports connection status and remains usable when Valkey is offline. Saved passwords are masked and are retained for the same address when left blank.

Backend selection, manual Valkey values, and the event count are persisted in `event_history_settings` in the WUI SQL database and apply immediately. Manual Valkey values remain available while another storage mode is selected. Each backend supplies its own history. Memory history is process-local, and returning to Valkey reads its retained history.

The in-memory count per camera is configured in **Settings → Event history**. Its default is 100 and its range is 0–1000. Set 0 to clear in-memory history while keeping the live feed. Memory history lasts until the API restarts. Its retention setting persists in the WUI database.

Valkey has independent per-camera `maxEvents` and event-age `ttlSeconds` limits. Enable either or both. A `null` count selects age-only retention, and a `null` lifetime selects count-only retention. Setting both to `null` is rejected. A count of 0 disables caching. The count supports up to 1,000,000 events per camera, and the lifetime supports 1 through 31536000 seconds. The feed fetches the latest 1000 retained events. Event age is based on the WUI's receipt time. Reading history does not renew event lifetimes. Existing list history is upgraded in place without changing event IDs.

Use these startup defaults, then select **Use configuration defaults** in the Event history screen. Manual Valkey overrides are saved in the WUI SQL database.

~~~json5
eventHistory: {
  backend: "valkey",
  url: "${WUI_VALKEY_URL}",
  keyPrefix: "reolink-wui",
  maxEvents: 10000,
  ttlSeconds: 86400,
  rejectUnauthorized: true,
}
~~~

Use a dedicated Valkey key prefix per deployment. Enable Valkey persistence to survive a Valkey restart. Use `redis://` for a plain connection or `rediss://` for TLS. A private CA or self-signed trust anchor can be supplied in `ca`. Setting `rejectUnauthorized: false` disables certificate and hostname verification for this Valkey connection. Legacy Valkey configurations without `maxEvents` retain their existing `retention` count behavior.

## Database and probes

For SQLite use a single API process with its database and WAL on a protected persistent local volume. Use `sqlite3 PATH ".backup 'backup.sqlite'"` for a consistent backup; stop the API before restoring and keep backups protected. For PostgreSQL use `database: { driver: "postgres", url: "${WUI_DATABASE_URL}", tls: { ca: "${file:pg-ca.pem}" } }`. Provide managed or file-backed credentials; a URL may not override TLS via query parameters. Take regular `pg_dump -Fc` backups and restore to a fresh database with `pg_restore` before switching the API. Both drivers apply the same versioned migrations on startup. Protect and back up the bridge vault independently of the WUI database.

`/livez` checks the process. `/readyz` checks the API's database, selected bridge transports and required OIDC discovery with bounded timeouts. Individual camera offline/stale status is shown only to authorized users. In browser layout route public probes to the API when probing the whole deployment; in proxy layout UI readiness follows the API. Set `LOG_CONSOLE_ENABLED`, `LOG_CONSOLE_FORMAT`, `LOG_CONSOLE_LEVELS`, and `LOG_RUNTIME_ENABLED` using the shared logger contract. The WUI logs generated correlation IDs and safe error keys. Do not log cookies, enrollment request bodies, or upstream payloads at ingress.

## Settings storage

The configured SQLite file or PostgreSQL database stores accounts, grants, sessions, camera playback options, inventory timing, installation appearance defaults, and per-bridge event source arrays. The priority array is JSON in `bridges.event_sources`. Preserve the SQLite file and its WAL directory on writable persistent storage, or back up the configured PostgreSQL database.

The startup JSON5 file supplies database connections, default bridge endpoints, authentication settings, secret references, and event-history defaults. Its path defaults to `./local-only/wui.json5` and can be selected with `WUI_CONFIG`. Personal appearance choices are saved in browser local storage under `reolink-wui:appearance:<account-id>`. Event history uses memory by default, or the configured Valkey backend.

## Container

Build the local image with the six deployment metadata values. Use the same artifact in both services.

```sh
docker build -t reolink-wui:dev \
  --build-arg BUILD_VERSION=0.1.0 --build-arg BUILD_HASH=unknown \
  --build-arg BUILD_DATE="$(date -u +%FT%TZ)" --build-arg GIT_SHA=unknown \
  --build-arg GIT_DIRTY=false --build-arg CI_RUN_ID=local .
```

Supply real commit values in CI and tag the image with both version and short hash. The example Compose file uses a shared loopback network namespace for proxy mode and publishes only the UI to the local machine. Give the unprivileged application user access to the mounted config and SQLite directory. Compose 2.24+ accepts an optional `.env` for secret references. This directory, real configs, database dumps and generated keys are outside the image and build context.

## SD-card recordings and orientation

Open **Recordings** to select a camera, search a date in the camera's local time, view total/used/free storage, and browse thumbnails in a grid or table. Searches include both reported recording qualities, pairing clips whose start and end boundaries differ by up to four seconds. Unmatched clips remain separate. The player offers each available quality. Layout, page size (including All), and end-of-recording behavior are saved in browser local storage. Dates and times occupy separate lines in the table. The timeline highlights rows/cards, opens playback at the selected point, and shows a nearby keyframe on hover. Its recorded-hours view can switch to a whole-day view; unrecorded periods are gaps, not evidence of inactivity. Play opens a modal with seeking, Previous/Next recording, and end-of-recording choices to stop, play the next clip, or loop the current clip. Escape, Close, and the backdrop dismiss the modal. The bridge must expose the storage and recordings API. The WUI account requires `recordings.view`. Instance administrators have this permission, and the Camera admin preset includes it when newly assigned. Other accounts can receive it under Camera grants.

Opening a day warms timeline thumbnails across all result pages. The WUI loads a poster for each recording, then frames along the visible rail, then the remaining recorded seconds. It reads one background thumbnail at a time and pauses when the tab is hidden or the player is open. The automatic preview caches in the tab and WUI API each hold up to 32 MiB and 4,096 entries for up to 600 seconds. Authorized viewers can reuse the API cache.

Moving a mouse or dragging a finger across the timeline queues the photos and video previews crossed along the rail. Earlier requests finish as the pointer moves. The current selection gets priority while the queue also processes earlier positions. A labeled nearby frame can appear while the selected frame loads. The browser keeps scanned images until you refresh, leave Recordings, or change the camera or date. This works with or without Valkey.

On **Recordings**, open **Bulk downloads** for the selected camera and date. **Download day’s videos (ZIP)** includes each SD recording in the qualities the camera saved, with separate `main` and `sub` folders. **Download PNGs (ZIP)** reads the camera’s saved JPEG time-lapse originals. Choose **Whole day** or one of the gaps in **PNG time range**. Empty periods can have photos when the camera has a JPEG time-lapse task. Both downloads require the **Export recordings** grant.

The recording toolbar stays visible while you scroll. Use its seek increment for 1, 5 or 10 seconds, or 1 or 10 frames. A frame step pauses playback and uses the selected MP4’s presentation timestamps. Expand the JSON to inspect the current frame or browse all frames. Accounts with both `recordings.view` and `recordings.export` can download the selected MP4, copy or download the selected JSON, and export every video frame. Each entry includes a one-based frame number, media offset, and the timestamp of the associated detection sample when available. A null object list means there was no matching sample. An empty list means the camera reported zero objects. The export records when source metadata was unavailable or truncated. Current bridges page through all recorded detection samples.

The bridge checks `api.recordings.temporaryDirectory` before advertising playback. Its default is `/tmp`, and `null` disables recorded-video playback. A missing or unwritable directory disables the Play buttons while card usage and file searches remain available. After fixing the directory, refresh the Recordings page.

The bridge downloads and prepares a private temporary MP4 on first playback. Subsequent range reads use that cached clip. Camera credentials and native recording file names remain in the bridge. The player refreshes an expired recording reference once before retrying. Preparation failures show the bridge's safe failure stage and correlation references. Browser media loading begins only after the bridge has prepared a valid MP4 range. [Bridge recordings API](https://github.com/Slyke/reolink-bridge/blob/master/docs/api.md#sd-card-recordings)

## Camera settings

Camera settings groups controls under **Live view and image**, **Detection and alerts**, **Network and time**, **Camera accounts**, and **Recording and storage**. The WUI stores playback preferences and SD media retention rules in its database. The SD recording schedule edits the camera and opens on demand.

Bridges advertising `deviceOptions` can report image tuning, day/night switching, anti-flicker, speaker volume, audio per recording stream, saved privacy masks, automatic tracking and alarm delivery. The WUI shows values and choices returned by the firmware. Under **Privacy masks → Edit privacy masks**, draw rectangles on the most recent live frame or add one with the keyboard. Save to apply them to the camera. Push, email and siren switches use the destinations and schedules already configured on the camera. Saving a change reads it back from the camera before the WUI confirms it.

In **Detection and alerts → FTP uploads**, cameras that expose an FTP destination offer the server, port, remote directory and login settings reported by the firmware. Save the destination, then enable camera FTP uploads in the same section. FTPS and anonymous login appear when the camera reports them. The destination and password live on the camera. A blank password preserves its existing credential at the same destination. The upload schedule remains on the camera.

**Live view and image → Bandwidth and stream quality** reads each camera’s encoder profiles. Pick a stream to see its resolution, frame rate, video bitrate and any keyframe interval it supports. The camera supplies the available combinations for each resolution. Changing resolution selects its highest advertised frame rate. You can choose a lower rate before saving. Saving updates that camera profile for all clients. Access uses `settings.encoding.read` and `settings.encoding.write`.

Dashboard live-view links include the WUI camera ID and stream. Opening a link requires the recipient’s own camera access. Changing quality updates the link and the signed-in user’s browser preference for that camera.

**Network and time → Camera clock** displays the camera’s local time, standard UTC offset, daylight-saving switch and network time (NTP). **Sync to this device** applies the browser’s time zone and recurring daylight-saving rules. Choose **Fixed UTC offset** for a year-round offset such as Vancouver’s `-07:00`. Use the **Daylight saving time** and **Automatic network time (NTP)** selectors and **Save clock options** to change either switch independently. **Auto** follows the seasonal dates stored on the camera. The WUI displays the transition dates when the firmware reports them. A sync applies the selected time zone’s daylight-saving rule and keeps the current NTP setting. **Set camera time** switches off active NTP for a manual time. The bridge checks the settings and running clock on a new camera connection before confirming. The recordings timeline shows **!** when a fresh sample differs from this device’s clock beyond its timing uncertainty.

**Live view and image → Image adjustments and day/night → Image orientation** shows supported camera-side horizontal/vertical flip and clockwise/counterclockwise rotation controls. They require `settings.image.write` and use fresh camera reads followed by verified readback. Camera-admin grants include the image-setting permissions. Quarter-turn rotation requires an advertised camera range.

In **Recording and storage**, expand **SD recording schedule** to edit hourly blocks for each recording type the device reports. Select a weekday in camera local time. **Time lapse** saves an MP4 or JPEG series with the capture interval and camera stream you select. New captures run daily until stopped. Both settings use native camera storage.

On supported cameras, **Add account** creates a camera user or administrator. **Remove** is available for eligible accounts. The bridge protects its own login and the built-in admin. **Change password** for the bridge login also updates its credential vault and verifies the new password. Use that vault on restart when the operation reports **Restart required**.

**Camera accounts** lists the usernames stored on the selected camera. The existing **Manage camera accounts and credentials** grant controls access. Choose **Change password** on a row, including the main admin. On an unbound camera, enter the printed UID so the bridge can verify its identity. When the account is also the bridge login, the bridge stores the verified new password in its private vault. Restart the bridge if prompted. Recovery for interrupted changes to its own login is in **Credential rotation**.

The Image orientation card explains when the connected bridge needs an update or the camera has not reported orientation controls. Camera-side settings are read before each supported change and verified by readback.


Recording previews use the bridge's CoverPreview API with a read-only partial recording-download fallback. Near a clip’s end the camera may finish a frame request before sending another keyframe. The bridge tries earlier windows within the same recording. The timeline labels a nearby preview with its offset. Hover requests specify an offset, and already prepared MP4s can supply the frame locally. No full recording download is required for an uncached thumbnail. The bridge advertises this path in `recordingPreviewCameras`. Older bridges display a preview placeholder until updated.

Image orientation buttons are shown in Camera settings. Only reported camera controls are enabled. When a camera reports flips but no 90° rotation support, the UI keeps the rotation buttons disabled and explains that capability. The UI does not emulate a camera setting with a browser transform.


Monitor and Dashboard share the Recordings, Camera settings, Refresh and Expand icons in the Live view heading. Expand, double-click or double-tap the preview to open the player. It starts the selected stream and displays the last preview until the first live frame arrives. On phones, PTZ fills the row below the video.

Use the arrows beside each camera in Monitor to order both views. The WUI database stores the order per account. The first eight ordered PTZ presets appear on the Dashboard. Selecting one takes a snapshot after the bridge reports arrival. It uses the configured MQTT snapshot transport for PNG, or requests a fresh JPEG from the bridge preview API. The PTZ panel lets an operator change their order and choose a timed return preset.

An open recording can be bookmarked or shared. The URL identifies the camera, date, recording and stream. Recipients sign in with their own recording access. Choosing a stream also saves that camera’s preference in the browser.

Valkey history keys upgrade from lists to sorted sets to enforce individual event expiry. To roll back to an older WUI build that only understands lists, restore a matching Valkey backup or use a separate key prefix.


Once the selected video has loaded, the player warms the next and previous recordings sequentially at the selected quality. Changing or closing playback cancels obsolete preload requests. This uses the bridge's shared media cache. Detection metadata is read from the same prepared recording when its API is advertised; it does not open a second native download. Available normalized boxes are aligned to media time and can be inspected as JSON. A camera may omit coordinates from its recording payload.

Live coordinate events require the bridge camera's coordinates.allowVideoStream option. When disabled, WUI says so in Event details, alongside always-available normalized event JSON. Enabling this bridge option reads the camera's metadata stream; it does not alter camera settings. ONVIF boolean alerts alone cannot supply bounding boxes.

## Per-camera SD media retention

An administrator can open **Settings → Camera settings**, select a camera, and expand **Recording and storage → SD media retention**. Enter independent ages in days for ordinary SD videos and time-lapse files (JPEG or completed MP4). Leaving a field blank disables that rule. Both fields start blank for every camera. Explicit camera support is required for each kind.

The WUI database stores the rules and the hourly check results for each camera. The worker uses the camera’s local clock and submits exact file IDs for media strictly older than the configured age. Files with ambiguous IDs or unknown completion times and running time-lapse movies are skipped. The first check starts within a minute. For videos, each check processes newly expired dates and backfills up to twelve additional months of camera calendars. The settings show the last check, its counts and any error reference. Files removed by retention are permanently deleted from the camera’s card.

## Keyed error logging

All WUI API failures, including 4xx responses, generate structured errors with correlation IDs. Configure the style-guide logger using a top-level logging block in the WUI configuration. Sinks and per-error gates control output; an error is generated even when all of its sinks are disabled.

~~~json5
logging: {
  sinks: {
    console: { enabled: true, format: "json", levels: ["warn", "error"] },
  },
  gates: {
    ACCESS_DENIED: { console: false },
    MEDIA_UNAVAILABLE: { console: true },
  },
}
~~~

The bridge has the same sink/gate model. Thumbnail fallback diagnostics use API_RECORDING_PREVIEW_FALLBACK (warning by default); a failed fallback uses API_RECORDING_PREVIEW_FAILED. Both carry correlation IDs. The bridge's HTTP middleware also reports framework rejections, failed readiness, and API errors that previously returned without a log. Already reported errors are not logged twice.


Background WS/MQTT/API feed failures, HTTP connection checks, inventory failures, connection-test failures, event-history connection/write/retention failures, and dropped history writes have distinct error keys. Operation outcomes that are rejected, unknown, or unverified also generate keyed errors even when the API uses HTTP 200 to return their outcome. OPERATION_UNVERIFIED defaults to warning level. Expected cancellation and disabled capabilities do not report failures. Connection-state logs are emitted when the failure changes; each failed HTTP request is still logged separately.

The Svelte UI process uses the same logging configuration. Proxy errors, rejected page requests, and unexpected render errors are gated too. Unexpected render errors return a generic public message without printing an uncontrolled exception to the console.
