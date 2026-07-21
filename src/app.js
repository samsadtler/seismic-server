
var path = require('path');
var crypto = require('crypto');
var bodyParser = require('body-parser');
var express = require('express');


var app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'html');

var port = process.env.PORT || 4000,
    lastRecordedQuakeTimes = 0;

let currentQuakeState = {'body':'1000n200'};

const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson';

// env int with a NaN-safe fallback (unlike `|| default`, this honors an explicit 0)
// and a min clamp so negatives can't produce nonsense (e.g. a future bootstrap window)
function envInt(name, def, min = 0) {
    const raw = parseInt(process.env[name], 10);
    return Number.isInteger(raw) ? Math.max(min, raw) : def;
}

const CACHE_TTL = envInt('CACHE_TTL', 20000);
const _rawMinMag = parseFloat(process.env.MIN_MAGNITUDE);
const MIN_MAGNITUDE = Number.isFinite(_rawMinMag) ? _rawMinMag : .01; // allows 0 / negatives
const MAX_DEVICE_QUAKES = 7; // ~491B worst case (7 × 20-char id, default MAX_DURATION); one 512B hook-response chunk
const MAX_ID_LEN = 20; // cap emitted event id so long "official" USGS ids can't push the payload past 512B
const GRACE_MS = envInt('GRACE_MS', 30 * 60 * 1000); // look back this far behind the cursor to catch quakes USGS added/revised out of order (dedup makes it replay-safe)
const ENABLE_PUSH = process.env.ENABLE_PUSH === 'true';

// on-demand USGS feed cache — replaces the always-on poll loop so the
// service is request-driven and safe to app-sleep on Railway
let feedCache = { json: null, fetchedAt: 0 };

app.listen(port, function () {
    log('Server running on port ' + port);
    if (ENABLE_PUSH) checkForQuakes(); // legacy push loop, migration only
});

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname + '/index.html'));
});

app.post('/v1/latest', function (req, res) {
    return res.json(currentQuakeState)
});

app.get('/v1/quakes', async function (req, res) {
    const json = await getQuakeFeed();
    return res.json(buildRecentQuakes(json));
});

// device pull endpoint — called by the Particle integration webhook.
// Devices keep their own cursor (the last `updated` value they've seen) and send it as ?since=
app.get('/v1/device/quakes', async function (req, res) {
    if (!process.env.WEBHOOK_SECRET) return res.status(503).json({ error: 'not configured' });
    if (!isAuthorizedWebhook(req)) return res.status(401).json({ error: 'unauthorized' });

    const now = Date.now();
    const since = parseSince(req.query.since); // null on cold start (no/invalid cursor)

    const json = await getQuakeFeed();
    return res.json({ now: now, quakes: buildDeviceQuakes(json, since) });
});

function isAuthorizedWebhook(req) {
    const provided = Buffer.from(req.get('x-webhook-secret') || '');
    const expected = Buffer.from(process.env.WEBHOOK_SECRET);

    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function parseSince(raw) {
    const since = Number.parseInt(raw, 10);
    return Number.isSafeInteger(since) && since > 0 ? since : null;
}

async function getQuakeFeed() {
    const now = Date.now();
    if (feedCache.json && now - feedCache.fetchedAt < CACHE_TTL) return feedCache.json;

    try {
        const response = await fetch(USGS_URL);
        const json = await response.json();
        if (json && json.features) {
            feedCache = { json: json, fetchedAt: now };
            log('Fetched USGS feed: ' + json.features.length + ' quakes at ' + new Date(now).toLocaleTimeString());
        }
    } catch (e) {
        logError(e); // stale-if-error: fall through and serve the last good feed
    }
    return feedCache.json;
}

// display shape for the landing page
function buildRecentQuakes(json) {
    if (!json || !json.features) return [];

    return json.features
        .map(feature => {
            let p = feature.properties || {};
            let coords = (feature.geometry && feature.geometry.coordinates) || [];
            return {
                id: feature.id,
                place: p.place,
                mag: p.mag,
                time: p.time,
                url: p.url,
                type: p.type,
                lon: coords[0],
                lat: coords[1],
                depth: coords[2]
            };
        })
        .sort((a, b) => b.time - a.time)
        .slice(0, 50);
}

// minimal payload for devices: t = cursor (the USGS `updated` time), i = event id, v = "<mag>n<dur>".
// The cursor is `updated` (when USGS published/revised the record) rather than the origin `time`,
// so quakes added to the feed late — origin time older than the cursor — still come through.
// The device dedupes by `i`, so a quake whose record is merely revised (a bumped `updated`) is
// not replayed. Cold start (since === null): return just the newest quake, so a fresh device
// plays the latest event and starts tracking from there.
function buildDeviceQuakes(json, since) {
    if (!json || !json.features) return [];

    const entries = json.features
        .map(f => ({ id: f.id, p: f.properties || {} }))
        .filter(x => x.p.mag > MIN_MAGNITUDE)
        // cursor on `updated` (nullish-guard, not `||`, so a real updated:0 wouldn't fall back)
        .map(x => ({ id: x.id, p: x.p, cursor: x.p.updated != null ? x.p.updated : x.p.time }))
        .sort((a, b) => a.cursor - b.cursor); // oldest-first

    // newest N since the cursor; if more than N match, the oldest are dropped (newest-wins)
    // to keep the hook-response within one 512B chunk — the cursor advances past them.
    // look back GRACE_MS behind the cursor so a quake USGS added/revised out of order
    // (updated time below the device's watermark) is still returned; the device dedupes
    // on id, so re-sending already-played quakes in the window doesn't replay them
    const selected = since === null
        ? entries.slice(-1)
        : entries.filter(x => x.cursor > since - GRACE_MS).slice(-MAX_DEVICE_QUAKES);

    return selected.map(x => ({ t: x.cursor, i: (x.id || '').slice(0, MAX_ID_LEN), v: computeV(x.p) }));
}

function shouldTriggerSense(quakeData) {
    var isNewQuake = quakeData.time > lastRecordedQuakeTimes,
        isHighMagnitude = quakeData.mag > MIN_MAGNITUDE,
        shouldTrigger = isNewQuake && isHighMagnitude;

    return shouldTrigger;
}

function processQuakeData(data) {
    if (!data || !data.features) return [];

    let quakeData = [];
    for (let i = 0; i < data.features.length; i++){
        if (shouldTriggerSense(data.features[i].properties)) quakeData.push(data.features[i].properties);
    }

    quakeData.sort((a, b) => a.time - b.time)
    console.log("USGS Output: ", quakeData, new Date().toLocaleTimeString())
    return quakeData
}

// legacy push loop — only runs when ENABLE_PUSH=true, kept for migration
// until device firmware moves to the pull model
function checkForQuakes() {
    getQuakeFeed()
        .then(json => processQuakeData(json))
        .then(quakeData => Promise.all(
            quakeData.map(async (quake) => {
                await sendToParticle(quake);
                lastRecordedQuakeTimes = quake.time;
            })
        ))
        .catch(e => console.log('checkForQuakes Error ', e));

    setTimeout(() => { checkForQuakes() }, 20000);
}

// pure "<magnitude>n<duration>" string, no logging — used by the pull path
function computeV(quakeData) {
    const magnitude = scaleLogMagnitude(quakeData.mag), duration = magnitude;
    return magnitude + 'n' + duration;
}

// push path: same value, but logs the vibration (an actual trigger is happening)
function triggerSense(quakeData) {
    logShouldInflate(quakeData, scaleLogMagnitude(quakeData.mag)); // logs
    return computeV(quakeData);
}

async function sendToParticle(quakeData) {
    let concatValues = triggerSense(quakeData);

    var requestOptions = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({arg:concatValues}),
        redirect: 'follow'
    };

    log('send to particle');
    const URL = 'https://api.particle.io/v1/devices/' + process.env.DEVICE_KEY + '/data?access_token=' + process.env.PARTICLE_TOKEN;
    return await fetch(URL, requestOptions)
        .then(res => res.text())
        .then(result => {
            log(`Response received from seismic sense: ${result}`);
            return result
        })
        .catch(error => logError('error' + error))
}

// log 10 based scale function
function scaleLogMagnitude(magnitude) {
    let adjMagnitude = magnitude < 1 ? 1 : magnitude; // prevents dealing with negative numbers
    let newMax = parseInt(process.env.MAX_DURATION)|| 120000;
    let newMin = parseInt(process.env.MIN_DURATION)|| 60000;
    let scaledMagnitude = Math.abs(Math.round(newMax * Math.log10(adjMagnitude))) + newMin;

    return scaledMagnitude;
}

let log = message => {
    console.log(message);
}

let logError = error => {
    log(`Encountered an error: ${error}`);
}

function logShouldInflate(quakeData, scaledMagnitude) {
    console.log("Vibration triggered with values:");
    console.log(" -> magnitude:        " + quakeData.mag);
    console.log(" -> scaled magnitude: " + scaledMagnitude);
}
