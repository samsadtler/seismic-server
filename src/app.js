
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
const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 20000;
const MIN_MAGNITUDE = .01;
const MAX_DEVICE_QUAKES = 5; // keeps hook-response payload within one 512B chunk
const BOOTSTRAP_WINDOW_MS = parseInt(process.env.BOOTSTRAP_WINDOW_MS) || 5 * 60 * 1000; // cold-start replay window
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
// Devices keep their own cursor (last seen quake time) and send it as ?since=
app.get('/v1/device/quakes', async function (req, res) {
    if (!process.env.WEBHOOK_SECRET) return res.status(503).json({ error: 'not configured' });
    if (!isAuthorizedWebhook(req)) return res.status(401).json({ error: 'unauthorized' });

    const now = Date.now();
    const since = parseSince(req.query.since);

    // cold start (no/invalid cursor): replay just the last BOOTSTRAP_WINDOW_MS
    // instead of the whole feed, so a freshly-booted device plays recent quakes
    // rather than an hour of backlog (or nothing)
    const effectiveSince = since === null ? now - BOOTSTRAP_WINDOW_MS : since;

    const json = await getQuakeFeed();
    return res.json({ now: now, quakes: buildDeviceQuakes(json, effectiveSince) });
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

// minimal payload for devices: t = quake time (next cursor), v = "<magnitude>n<duration>"
function buildDeviceQuakes(json, since) {
    if (!json || !json.features) return [];

    return json.features
        .map(feature => feature.properties || {})
        .filter(p => p.time > since && p.mag > MIN_MAGNITUDE)
        .sort((a, b) => a.time - b.time)
        .slice(-MAX_DEVICE_QUAKES) // newest N, oldest-first so devices play in order
        .map(p => ({ t: p.time, v: triggerSense(p) }));
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

function triggerSense(quakeData) {
    const magnitude = scaleLogMagnitude(quakeData.mag), duration = magnitude;
    const concatValues = magnitude + 'n' + duration;

    logShouldInflate(quakeData, magnitude); // logs

    return concatValues;
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
