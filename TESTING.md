# Testing & local development

How the pieces fit, how to test changes locally, and the Particle gotchas that
cost the most time to discover.

## System recap

```
Argon device ──publish "quake/check" (cursor)──▶ Particle Cloud
                                                     │  (product webhook integration)
                                                     ▼
                            GET /v1/device/quakes?since=<cursor>   ← this server (Railway)
                            X-Webhook-Secret: <WEBHOOK_SECRET>
                                                     │
                            { now, quakes: [ { t, v } ] }   (200)
                                                     ▼
Argon device ◀──"hook-response/quake/check/0"────── Particle Cloud
```

- The device keeps its own **cursor** (last quake time it played, stored in EEPROM) and
  sends it as `?since=`. The server is stateless — it just answers "quakes newer than that".
- `v` is `"<magnitude>n<duration>"`; the device plays it and advances its cursor to `t`.
- Firmware lives in the **seismic-intercept** repo (branch `feat/pull-firmware`).

---

## Testing server changes locally

Run it (the start script loads `.env` if present; on Railway the vars are injected):

```bash
WEBHOOK_SECRET=test PORT=4091 npm start
```

Only `WEBHOOK_SECRET` is required — everything else has defaults (see the env table in
`README.md`).

Exercise the routes:

```bash
B=http://localhost:4091
SINCE=$(( ($(date +%s)-3600)*1000 ))   # 1h ago, ms

# landing page
curl -s $B/v1/quakes | head            # JSON array
open $B/                               # live page

# device endpoint auth matrix
curl -i $B/v1/device/quakes                                   # 401 (no header)
curl -i -H "x-webhook-secret: wrong"   $B/v1/device/quakes    # 401
curl -i -H "x-webhook-secret: test"    "$B/v1/device/quakes?since=$SINCE"   # 200 {now,quakes}
curl -i -H "x-webhook-secret: test"    $B/v1/device/quakes    # 200, cold-start (last 5 min)
```

Boot **without** `WEBHOOK_SECRET` to confirm the fail-closed path returns `503`.

Syntax check without running: `node --check src/app.js`.

### Full webhook loop against a *local* server (ngrok)

Particle Cloud can't reach `localhost`, so tunnel it:

```bash
WEBHOOK_SECRET=test PORT=4091 npm start   # terminal 1
ngrok http 4091                           # terminal 2 → gives an https URL
```

Point the webhook's URL at the ngrok `https://…` host temporarily, then trigger a device
poll (below). Switch the URL back to Railway when done. (Easiest alternative: just test
against the deployed Railway server.)

---

## Testing firmware changes locally (seismic-intercept)

The pull firmware is on branch `feat/pull-firmware`, checked out in a worktree
(`/Users/Sam/Development/seismic-intercept-pull`). **Flash from there, not `master`** —
`master` still has the old push firmware (no `poll` function).

```bash
cd /Users/Sam/Development/seismic-intercept-pull
particle compile argon src/                       # build check
particle flash <device> src/                      # OTA flash
particle serial monitor                            # watch logs
```

Test hooks built into the firmware:

```bash
# fire the pumps directly — hardware check, does NOT touch the cursor
particle call <device> data "3000n3000"           # 3s inflation

# force one poll cycle (device → webhook → server → device)
particle call <device> poll

# exercise the response parser without the webhook (advances the cursor to t!)
particle publish "hook-response/quake/check" \
  '{"now":1,"quakes":[{"t":1,"v":"800n1200"}]}' --private
```

Expected serial on a good poll:
`poll: publishing cursor='…'` → `response: {"now":…}` → `queue mag/dur:` → pumps → `cursor -> '…'`.

- First poll after boot: empty cursor → server replays the last 5 min (`BOOTSTRAP_WINDOW_MS`).
  An empty `quakes:[]` just means nothing in that window; the cursor still advances to `now`.
- No `response:` line → the device isn't receiving the hook-response (see gotchas #1/#2).

---

## Particle integration gotchas (hard-won)

1. **Secret via `{{{WEBHOOK_SECRET}}}` needs "Allow environment variables" enabled** on the
   integration. Without it the literal `{{{WEBHOOK_SECRET}}}` string is sent as the header,
   the server compares it byte-for-byte and returns **401**. Also select/attach the secret to
   the integration so it's exposed. (This was the final blocker — symptom: hook-response
   appears in the console but the device never plays.)

2. **A product device needs a *product* integration.** A device claimed to a Particle Product
   publishes on the **product event stream**. A personal/sandbox webhook's hook-response goes
   to your **account** stream — so *you* see `hook-response/quake/check/0` in the console, but
   the **device never receives it**. Create the webhook under **Console → your Product →
   Integrations**, not the top-level personal Integrations.

3. **Product OTA reverts your firmware.** If the device is claimed to a product with released
   firmware, the cloud re-flashes that release on reconnect and your freshly-flashed `poll`
   function disappears (symptom: `poll` shows in the dashboard, then vanishes on refresh).
   Fix: **Console → Product → Devices → the device → "Mark as development device."** This only
   excludes it from fleet OTA — it does **not** un-enroll it from the product, so its events
   are still product-scoped (gotcha #2 still applies).

4. **Response Topic** defaults to `hook-response/{{{PARTICLE_EVENT_NAME}}}` =
   `hook-response/quake/check`, which is the prefix the firmware subscribes to. If you set a
   custom response topic, the device won't match it.

5. **Subscription scope arg is deprecated** in Device OS 6.x (`MY_DEVICES` has no effect) —
   use the two-arg `Particle.subscribe(event, handler)`.

---

## Deploy recap

- Railway deploys the `production` branch. Flow: PR → `master` → promote `master → production`.
- Set `WEBHOOK_SECRET` on Railway (Variables) to match the integration's secret.
- Pull model needs no `DEVICE_KEY`/`PARTICLE_TOKEN` — those are only read when `ENABLE_PUSH=true`.
- The `npm warn config production Use --omit=dev instead` line in Railway build logs is a
  harmless npm deprecation warning, not an error.
