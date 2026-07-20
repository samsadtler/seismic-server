
1. Install node (if not installed already) https://nodejs.org/en/
2. Clone this repo
3. Make a .env file in root directory
4. Add your argon `DEVICE_KEY='xxxxxxxxxxxxxxx'` which you recieved after registering your device
5. Geneate particle token `particle token create` defaults to 90 day expiration use flag  `--never-expires` for a long lived token
6. Add `PARTICLE_TOKEN='xxxxxxxxxxxxxxx'`
7. (Optional) Add `PORT='4000'` — the server reads `process.env.PORT` and defaults to `4000`. On Railway/other hosts, `PORT` is injected automatically, so leave it unset there.
8. Open terminal and install dependancies and run `npm install && npm start`

Env vars used: `WEBHOOK_SECRET`, `MAX_DURATION`, `MIN_DURATION`, `PORT` (optional), `CACHE_TTL` (optional, ms), `BOOTSTRAP_WINDOW_MS` (optional, ms, default 5 min), `ENABLE_PUSH` (optional, legacy).

## Device pull model

Devices no longer receive pushes by default. Instead, each Particle device keeps its own
cursor (the `time` of the last quake it played, stored in EEPROM) and periodically publishes
an event; a Particle integration webhook calls this server:

    GET /v1/device/quakes?since=<cursor_ms>
    X-Webhook-Secret: <value of WEBHOOK_SECRET>

Response: `{ "now": <server_ms>, "quakes": [ { "t": <quake_ms>, "v": "<magnitude>n<duration>" } ] }`
(oldest first, max 10). The device plays each `v`, then advances its cursor to the last `t`.
If `since` is missing/invalid (a freshly-booted device with no cursor) the server replays only
the last `BOOTSTRAP_WINDOW_MS` (default 5 min) of quakes rather than the whole feed — so a new
device plays recent activity, not an hour of backlog. The device then advances its cursor to
the last `t` it played (or `now` if that window was empty). Requests without the correct
`X-Webhook-Secret` header get `401`; if `WEBHOOK_SECRET` is unset on the server the endpoint
fails closed with `503`.

Legacy push mode (server calls the Particle API; needs `DEVICE_KEY` + `PARTICLE_TOKEN`)
still exists behind `ENABLE_PUSH='true'` for migration, and will be removed once all
devices run pull firmware. With push off, the server is request-driven and safe to
app-sleep on Railway.
