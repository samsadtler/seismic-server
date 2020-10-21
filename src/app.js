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

var port = process.env.PORT || 4000;
var quakeTimer;
var lastRecordedQuakeTime = 0;
var recentLocation = {};

setInterval(function () {
    log('Sending keep-alive GET request to heroku')
    http.get("http://seismic-server.herokuapp.com");
}, 1500000);

app.listen(port, function () {
    log('Server running on port ' + port);
    dotenv.load();
    checkForQuakes();
});

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname + '/index.html'));
});


function checkForQuakes() {
    fetchNewQuakeData().then(function (quakeData) {
        if (quakeData && quakeData.time && shouldTriggerSense(quakeData)) {
                if (quakeData == null) {
                    log('Error discovered. Cancel triggering sense.')
                } else {
                    triggerSense(quakeData)
                }
        }
    }).catch(e => console.log('fetchNewQuakeData Error ', e));

    quakeTimer = setTimeout(() => { checkForQuakes() }, 20000);
}

function shouldTriggerSense(quakeData) {
    var isNewQuake = quakeData.time > lastRecordedQuakeTime;
    var isHighMagnitude = quakeData.mag > 1;
    var shouldTrigger = isNewQuake && isHighMagnitude;

    if (shouldTrigger) {
        log('Encountered USGS seismic event which should trigger sense');
        lastRecordedQuakeTime = quakeData.time;
    }
    return shouldTrigger;
}

function fetchNewQuakeData() {
    var url = 'http://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson';
    return fetchJson(url, json => {
        if (json.features) return json.features[0].properties;
    }).catch(e => { console.error(`${e}`) });
}

function loadDistance(quakeData) {
    log('Loading distance from Google Maps API...' + JSON.stringify(quakeData));
    quakeLocation = quakeData.place.split(' ').join('+');
    var url = 'https://maps.googleapis.com/maps/api/distancematrix/json?origins=' + quakeLocation + '&destinations=New+York,New+York&key=' + process.env.GOOGLE_MAPS_API_KEY;
    return fetchJson(url, function (json) {
        if (responseHasErrors(json)) {
            logError('error in load distance ',json.error_message);
            return null;
        }
        quakeData.distance = json.rows[0].elements[0].distance.value;
        log('Distance found: ' + quakeData.distance);
        return quakeData;
    }).catch(e => { console.log(`load distance error : ${e}`) });
}

function responseHasErrors(json) {
    return json.status != 'OK';
}

function triggerSense(quakeData) {
    let magnitude = scaleMagnitude(quakeData.mag),
        placeholder = 100
        concatValues = magnitude + 'n' + placeholder;
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