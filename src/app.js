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
    quakeTimer,
    lastRecordedQuakeTimes = [],
    lastQuakeSent;

// setInterval(function () {
//     log('Sending keep-alive GET request to heroku')
//     http.get("http://seismic-server.herokuapp.com");
// }, 1500000);

app.listen(port, function () {
    log('Server running on port ' + port);
    dotenv.load();
    checkForQuakes();
});

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname + '/index.html'));
});


function checkForQuakes() {
    fetchNewQuakeData()
        .then( quakeDataSet => processQuakeData(quakeDataSet))
        .then( quakeData => {
            quakeData.map(quake => {
                if (quake && quake.time && shouldTriggerSense(quake)) {
                    console.log(quake)
                    triggerSense(quake)
                }
            })
    }).catch(e => console.log('fetchNewQuakeData Error ', e));

    quakeTimer = setTimeout(() => { checkForQuakes() }, 20000);
}

function shouldTriggerSense(quakeData) {
    var isNewQuake = quakeData.time > lastRecordedQuakeTimes;
    var isHighMagnitude = quakeData.mag > .1;
    var shouldTrigger = isNewQuake && isHighMagnitude;
    if (shouldTrigger) {
        log('Encountered USGS seismic event which should trigger sense');
        lastRecordedQuakeTimes = quakeData.time;
    }
    return shouldTrigger;
}

function processQuakeData(data) {
    let quakeData = [];

    for (i = 0; i < data.features.length; i++){
        quakeData.push(data.features[i].properties);
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

function responseHasErrors(json) {
    return json.status != 'OK';
}

function triggerSense(quakeData) {
    let magnitude = scaleLogMagnitude(quakeData.mag),
        duration;
    
    if (magnitude > lastQuakeSent) {
        magnitude = magnitude - lastQuakeSent;
        duration = magnitude
        lastQuakeSent = magnitude;
    } else {
        duration = lastQuakeSent - magnitude;
        lastQuakeSent = magnitude;
        magnitude = 0
    }


    concatValues = magnitude + 'n' + duration;
    logShouldInflate(quakeData, magnitude);
    sendToParticle(concatValues);
}

function sendToParticle(concatValues) {
    var form = new formData();
    var header = new Headers();

    form.append('args', concatValues);
    header.append("Content-Type", "application/x-www-form-urlencoded");

    var requestOptions = {
        method: 'POST',
        headers: header,
        body: form,
        redirect: 'follow'
    };

    log('send to particle');

    fetch('https://api.particle.io/v1/devices/' + process.env.DEVICE_KEY + '/data?access_token=' + process.env.PARTICLE_TOKEN, requestOptions)
        .then(res => res.text())
        .then(result => console.log(`Response received from seismic sense: ${result}`))
        .catch(error => logError('error' + error))
        .catch(error => logError('error' + error));
}

function scaleMagnitude(magnitude) {
    var richterMax = 10;
    var richterMin = 1;
    var newMax = 4000;
    var newMin = 200;
    var scaledMagnitude = ((newMax - newMin) / (richterMax - richterMin)) * (magnitude - richterMax) + newMax;
    return Math.abs(Math.round(scaledMagnitude));
}

function scaleLogMagnitude(magnitude) {
    var richterMax = 10;
    var richterMin = 1;
    var newMax = 10000;
    var newMin = 0;
    var scaledMagnitude = newMax*Math.log10(magnitude); 
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