
var path = require('path');
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

// rolling buffer of recent quakes for the landing page
let recentQuakes = [];

app.listen(port, function () {
    log('Server running on port ' + port);
    checkForQuakes();
});

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname + '/index.html'));
});

app.post('/v1/latest', function (req, res) {
    return res.json(currentQuakeState)
});

app.get('/v1/quakes', function (req, res) {
    return res.json(recentQuakes);
});

function shouldTriggerSense(quakeData) {
    var isNewQuake = quakeData.time > lastRecordedQuakeTimes,
        isHighMagnitude = quakeData.mag > .01,
        shouldTrigger = isNewQuake && isHighMagnitude;
   
    return shouldTrigger;
}

// builds the display buffer from the full feed, independent of the
// Particle trigger filter so the hardware path stays untouched
function updateRecentQuakes(json) {
    if (!json || !json.features) return;

    recentQuakes = json.features
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

function processQuakeData(data) {
    let quakeData = [];
    for (let i = 0; i < data.features.length; i++){
        if (shouldTriggerSense(data.features[i].properties)) quakeData.push(data.features[i].properties);
    }

    quakeData.sort((a, b) => a.time - b.time)
    console.log("USGS Output: ", quakeData)
    return quakeData
}

function fetchNewQuakeData() {
    var url = 'http://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson';
    
    return fetchJson(url, json => {
        if (json.features) return json;
    }).catch(e => { console.error(`${e}`) });
}


function checkForQuakes() {
    fetchNewQuakeData()
        .then( quakeDataSet => { updateRecentQuakes(quakeDataSet); return quakeDataSet; })
        .then( quakeDataSet => processQuakeData(quakeDataSet))
        .then(quakeData => {
            Promise.all(
                quakeData.map(
                    async (quake) => {
                        await sendToParticle(quake)
                        .then(
                            lastRecordedQuakeTimes = quake.time
                        )
            }))
    }).catch(e => console.log('fetchNewQuakeData Error ', e));

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
        .catch(error => logError('error' + error));
}

//linear scale function
// function scaleMagnitude(magnitude) {
//     var richterMax = 10;
//     var richterMin = 0;
//     var newMax = 4000;
//     var newMin = 200;
//     var scaledMagnitude = ((newMax - newMin) / (richterMax - richterMin)) * (magnitude - richterMax) + newMax;
//     return Math.abs(Math.round(scaledMagnitude));
// }

// log 10 based scale function
function scaleLogMagnitude(magnitude) {
    let adjMagnitude = magnitude < 1 ? 1 : magnitude; // prevents dealing with negative numbers
    let newMax = parseInt(process.env.MAX_DURATION)|| 120000;
    let newMin = parseInt(process.env.MIN_DURATION)|| 60000;
    let scaledMagnitude = Math.abs(Math.round(newMax * Math.log10(adjMagnitude))) + newMin;

    return scaledMagnitude;
}

 let fetchJson = async (url, handler) => {
    return await fetch(url)
        .then( response => {
            return response.json();
        }, error => {
            logError(error);
        })
        .then(handler,  error => {
            logError(error);
        })
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