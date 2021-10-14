var dotenv = require('dotenv');
var path = require('path');
var bodyParser = require('body-parser');
var express = require('express');
var formData = require('form-data');
var http = require('http');
require('es6-promise').polyfill();
require('isomorphic-fetch');

var app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'html');

var port = process.env.PORT || 4000,
    lastRecordedQuakeTimes = 0;

let currentQuakeState = {'body':'1000n200'};

setInterval(function () {
    log(`Sending keep-alive GET request to heroku: http://seismic-server${process.env.ENVIRONMENT||''}.herokuapp.com`)
    http.get(`http://seismic-server${process.env.ENVIRONMENT||''}.herokuapp.com`);
}, 1500000);

app.listen(port, function () {
    log('Server running on port ' + port);
    dotenv.load();
    checkForQuakes();
});

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname + '/index.html'));
});

app.post('/v1/latest', function (req, res) {
    console.log('request ', req)
    return res.json(currentQuakeState)
});

function shouldTriggerSense(quakeData) {
    var isNewQuake = quakeData.time > lastRecordedQuakeTimes,
        isHighMagnitude = quakeData.mag > .01,
        shouldTrigger = isNewQuake && isHighMagnitude;
   
    return shouldTrigger;
}

function processQuakeData(data) {
    let quakeData = [];
    for (i = 0; i < data.features.length; i++){
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

    quakeTimer = setTimeout(() => { checkForQuakes() }, 20000);
}

function triggerSense(quakeData) {
    let magnitude = scaleLogMagnitude(quakeData.mag), duration = magnitude;
    concatValues = magnitude + 'n' + duration;

    logShouldInflate(quakeData, magnitude); // logs

    return concatValues;
}

async function sendToParticle(quakeData) {
    let form = new formData(), header = new Headers();
    let concatValues = triggerSense(quakeData);

    form.append('args', concatValues);
    header.append("Content-Type", "application/x-www-form-urlencoded");

    var requestOptions = {
        method: 'POST',
        headers: header,
        body: form,
        redirect: 'follow'
    };

    log('send to particle');

    return await fetch('https://api.particle.io/v1/devices/' + process.env.DEVICE_KEY + '/data?access_token=' + process.env.PARTICLE_TOKEN, requestOptions)
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