
1. Install node (if not installed already) https://nodejs.org/en/
2. Clone this repo
3. Make a .env file in root directory
4. Add your argon `DEVICE_KEY='xxxxxxxxxxxxxxx'` which you recieved after registering your device
5. Geneate particle token `particle token create` defaults to 90 day expiration use flag  `--never-expires` for a long lived token
6. Add `PARTICLE_TOKEN='xxxxxxxxxxxxxxx'`
7. (Optional) Add `PORT='4000'` — the server reads `process.env.PORT` and defaults to `4000`. On Railway/other hosts, `PORT` is injected automatically, so leave it unset there.
8. Open terminal and install dependancies and run `npm install && npm start`

Env vars used: `WEBHOOK_SECRET`, `MAX_DURATION`, `MIN_DURATION`, `MIN_MAGNITUDE` (optional, default 0.01), `PORT` (optional), `CACHE_TTL` (optional, ms), `ENABLE_PUSH` (optional, legacy).

## Device pull model

Devices no longer receive pushes by default. Instead, each Particle device keeps its own
cursor (the last USGS `updated` value it has seen, stored in EEPROM) and periodically publishes
an event; a Particle integration webhook calls this server:

    GET /v1/device/quakes?since=<cursor_ms>
    X-Webhook-Secret: <value of WEBHOOK_SECRET>

Response: `{ "now": <server_ms>, "quakes": [ { "t": <updated_ms>, "i": "<event_id>", "v": "<magnitude>n<duration>" } ] }`
(oldest first, max 7). The device plays each `v`, then advances its cursor to the last `t`.

The cursor is the record's **`updated`** time (when USGS published/revised it), **not** the
quake's origin `time`. USGS adds and revises events late and out of order, so a quake that
happened 30 min ago may only appear in the feed now — filtering on origin `time` would skip it
because its origin time is older than the cursor. Filtering on `updated` catches these late
arrivals. Because a revision also bumps `updated` (which would otherwise re-send an
already-played quake), each entry includes the event id `i`; the **device dedupes on `i`** and
skips quakes it has already played, while still advancing its cursor past them.

Cold start (a freshly-booted device sends a missing/invalid `since`): the server returns just
the **single newest** quake, so a new device plays the latest event and starts tracking from
there. Requests without the correct `X-Webhook-Secret` header get `401`; if `WEBHOOK_SECRET` is
unset on the server the endpoint fails closed with `503`.

Legacy push mode (server calls the Particle API; needs `DEVICE_KEY` + `PARTICLE_TOKEN`)
still exists behind `ENABLE_PUSH='true'` for migration, and will be removed once all
devices run pull firmware. With push off, the server is request-driven and safe to
app-sleep on Railway.
