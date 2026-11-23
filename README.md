# Reolink WUI

A self-hosted SvelteKit and Node interface for powered standalone Reolink cameras. The private reolink-bridge bridge connects to your cameras. The WUI manages user access and forwards supported actions.

## Run locally

Use Node 24, Reolink Bridge, and an MQTT 5 broker. Run these commands from this directory on Linux or WSL.

```sh
npm ci
npm run build
install -d -m 0700 ./local-only
cp ./wui.example.json5 ./local-only/wui.json5
export WUI_FORWARD_SECRET="$(openssl rand -hex 32)"
umask 077
read -r -s -p 'First WUI password (at least 12 characters): ' FIRST_WUI_PASSWORD
printf '%s' "$FIRST_WUI_PASSWORD" > ./local-only/bootstrap-password
unset FIRST_WUI_PASSWORD
npm run admin -- bootstrap local installer 'Instance administrator' ./local-only/bootstrap-password
rm ./local-only/bootstrap-password
npm run api
```

In a second shell use the same `WUI_FORWARD_SECRET` and start the UI with `HOST=127.0.0.1 PORT=3000 npm run ui`. Open [the local WUI](http://127.0.0.1:3000). Register a private bridge in `local-only/wui.json5` and restart both services. Dashboard shows camera previews and Monitor shows live view and event history. Instance administrators have full access to all discovered cameras. Assign roles to other accounts under **Settings → Camera grants**.

See the [deployment guide](./docs/deployment.md) for TLS, service layout, identity providers, storage, and backup. The deployment guide also covers [enrollment and callbacks](./docs/deployment.md#enrollment-and-callbacks), [camera playback](./docs/deployment.md#camera-playback), and [event history](./docs/deployment.md#event-history). The [compatibility matrix](./docs/compatibility.md) describes what requires an updated bridge and what has been verified.

The [WUI API reference](./docs/api-reference.md) covers browser requests and responses, SSE and upstream bridge calls.

## Checks

```sh
npm run check
npm run build
npm test                                # requires local Mosquitto on PATH
npx playwright install chromium
npm run test:browser                    # checks both layouts with the built app
```

To run the same database suite against PostgreSQL, set `WUI_TEST_POSTGRES` to a connection string for a disposable loopback test database. The suite applies migrations and inserts fixtures there. Set `WUI_TEST_VALKEY` to a disposable Valkey URL to test retained events across app restarts. Set `WUI_TEST_RTSP` to a synthetic RTSP stream to test the proxy playback path. To use an installed Chromium instead of downloading one, set `WUI_TEST_CHROMIUM` to its executable path. The sibling bridge tests run with `cargo test --locked -- --include-ignored` on a host with Mosquitto and FFmpeg. To also exercise this WUI against the real bridge with mock camera endpoints, set `WUI_TEST_PROJECT` to this checkout and `WUI_TEST_NODE` to the absolute Node 24 executable before running the bridge tests. The cross-service checks create, update and remove a callback through the WUI, compare its body with the MQTT event, switch among WebSocket, MQTT and HTTP SSE, and match browser events against retained history. They also verify camera commands, snapshots and live media.
