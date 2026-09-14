import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const model = {};
vm.createContext(model);
vm.runInContext(fs.readFileSync(new URL('./Model.js', import.meta.url), 'utf8'), model, {filename: 'Model.js'});

const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

function approx(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} !== ${expected}`);
}

function schemaRow(key) {
  return manifest.barWidget.schema.find(row => row.key === key);
}

// ---- Manifest contract -----------------------------------------------------
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.id, 'io.github.minholi.windy');
assert.equal(manifest.kinds.length, 1);
assert.equal(manifest.kinds[0], 'bar-widget');
assert.equal(manifest.entryPoints.barWidget, 'BarWidget.qml');
assert.ok(fs.existsSync(new URL('./BarWidget.qml', import.meta.url)));
assert.ok(['left', 'center', 'right'].includes(manifest.barWidget.defaultSection));

for (const row of manifest.barWidget.schema) {
  assert.ok(Object.prototype.hasOwnProperty.call(manifest.barWidget.defaults, row.key),
    `defaults missing ${row.key}`);
  assert.equal(manifest.barWidget.defaults[row.key], row.defaultValue,
    `default and schema disagree for ${row.key}`);
  if (row.type === 'enum') {
    assert.ok(row.options.includes(row.defaultValue), `default not in options for ${row.key}`);
  }
}

// The API key is a keyring credential; it is not a shell.json setting.
assert.ok(!Object.prototype.hasOwnProperty.call(manifest.barWidget.defaults, 'apiKey'));
assert.equal(schemaRow('apiKey'), undefined);

// Every enum the settings UI can write must be understood by the model.
for (const option of schemaRow('model').options) {
  const resolved = model.resolveModel(option, 48.85, 2.35);
  assert.equal(typeof resolved, 'string');
  assert.ok(model.modelLabel(resolved) !== '', `no label for model ${option}`);
  if (option !== 'auto') assert.equal(resolved, option);
}
for (const option of schemaRow('unit').options) {
  assert.ok(model.unitLabel(option) !== '', `no label for unit ${option}`);
  assert.ok(isFinite(model.speedToUnit(1, option)), `no conversion for unit ${option}`);
}
for (const option of schemaRow('level').options) {
  assert.ok(model.levelLabel(option) !== '', `no label for level ${option}`);
  assert.equal(model.seriesKey('wind_u', option), `wind_u-${option}`);
}
const refresh = schemaRow('refreshMinutes');
assert.equal(refresh.type, 'integer');
assert.ok(refresh.min >= 5);
assert.ok(refresh.defaultValue >= refresh.min && refresh.defaultValue <= refresh.max);

// ---- uv -> speed/direction -------------------------------------------------
approx(model.uvToSpeedDir(0, 1).speed, 1, 'northward speed');
assert.equal(model.uvToSpeedDir(0, 1).toward, 0);
assert.equal(model.uvToSpeedDir(0, 1).from, 180);
assert.equal(model.uvToSpeedDir(1, 0).toward, 90);
assert.equal(model.uvToSpeedDir(1, 0).from, 270);
assert.equal(model.uvToSpeedDir(0, -1).toward, 180);
assert.equal(model.uvToSpeedDir(0, -1).from, 0);
assert.equal(model.uvToSpeedDir(-1, 0).toward, 270);
assert.equal(model.uvToSpeedDir(-1, 0).from, 90);
approx(model.uvToSpeedDir(1, 1).speed, Math.SQRT2, 'diagonal speed');
assert.equal(model.uvToSpeedDir(1, 1).toward, 45);
assert.equal(model.uvToSpeedDir(1, 1).from, 225);
assert.equal(model.uvToSpeedDir(-1, -1).from, 45);
assert.equal(model.uvToSpeedDir(undefined, 1), null);
assert.equal(model.uvToSpeedDir(1, 'nope'), null);

// ---- Compass ---------------------------------------------------------------
assert.equal(model.compass(0), 'N');
assert.equal(model.compass(22.5), 'NNE');
assert.equal(model.compass(90), 'E');
assert.equal(model.compass(180), 'S');
assert.equal(model.compass(270), 'W');
assert.equal(model.compass(340), 'NNW');
assert.equal(model.compass(348.75), 'N');
assert.equal(model.compass(359), 'N');
assert.equal(model.compass(-90), 'W');
assert.equal(model.compass(undefined), '');

// ---- Unit normalization ----------------------------------------------------
assert.equal(model.normalizeSpeedUnit('m*s-1'), 1);
approx(model.normalizeSpeedUnit('km*h-1'), 1 / 3.6, 'km/h factor');
approx(model.normalizeSpeedUnit('kn'), 0.514444, 'knots factor');
approx(model.normalizeSpeedUnit('mi*h-1'), 0.44704, 'mph factor');
assert.equal(model.normalizeSpeedUnit('furlongs*fortnight-1'), 1);
approx(model.normalizeSpeed(36, 'km*h-1'), 10, 'km/h to m/s');
approx(model.normalizeSpeed(20, 'kn'), 10.28888, 'knots to m/s');
assert.equal(model.normalizeSpeed(null, 'm*s-1'), null);
assert.equal(model.normalizeSpeed('', 'm*s-1'), null);
approx(model.speedToUnit(10, 'kn'), 19.43844, 'm/s to knots');
approx(model.speedToUnit(10, 'kmh'), 36, 'm/s to km/h');
assert.equal(model.formatSpeed(10, 'kmh'), '36');
assert.equal(model.formatSpeed(10, 'ms'), '10');
assert.equal(model.formatSpeed(null, 'kn'), '');

// ---- Model selection -------------------------------------------------------
assert.equal(model.autoModel(48.8566, 2.3522), 'aromeFrance');
assert.equal(model.autoModel(52.52, 13.405), 'iconD2');
assert.equal(model.autoModel(39.7392, -104.9903), 'hrrrConus');
assert.equal(model.autoModel(21.3069, -157.8583), 'namHawaii');
assert.equal(model.autoModel(61.2181, -149.9003), 'namAlaska');
assert.equal(model.autoModel(51.5074, -0.1278), 'iconEu');
assert.equal(model.autoModel(-33.8688, 151.2093), 'gfs');
assert.equal(model.autoModel(NaN, 0), 'gfs');
assert.equal(model.resolveModel('auto', 39.7392, -104.9903), 'hrrrConus');
assert.equal(model.resolveModel('', 39.7392, -104.9903), 'hrrrConus');
assert.equal(model.resolveModel('icon', 0, 0), 'icon');
assert.equal(model.resolveModel('bogus', 0, 0), 'gfs');
assert.equal(model.resolveModel(' auto ', 39.7392, -104.9903), 'hrrrConus');

// ---- Location parsing ------------------------------------------------------
const unset = model.parseLocationFile('');
assert.equal(unset.name, '');
assert.equal(unset.latitude, null);
assert.deepEqual(model.parseLocationFile('nope'), unset);
const malibu = model.parseLocationFile('{"name":"Malibu"}');
assert.equal(malibu.name, 'Malibu');
assert.equal(malibu.latitude, null);
assert.equal(malibu.longitude, null);
const stored = model.parseLocationFile('{"name":"Vienna","latitude":48.2,"longitude":16.37}');
assert.equal(stored.name, 'Vienna');
assert.equal(stored.latitude, 48.2);
assert.equal(stored.longitude, 16.37);
assert.equal(model.parseLocationFile('{"latitude":91,"longitude":0}').latitude, null);

const ip = model.parseIpLocation('{"success":true,"city":"Itatiba","country":"Brazil","latitude":-23.005,"longitude":-46.838}');
assert.equal(ip.name, 'Itatiba');
assert.equal(ip.country, 'Brazil');
approx(ip.latitude, -23.005, 'ip latitude');
assert.equal(model.parseIpLocation('{"success":false,"message":"error"}'), null);
assert.equal(model.parseIpLocation('not json'), null);
assert.equal(model.parseIpLocation('{"success":true}'), null);
assert.equal(model.parseIpLocation('{"success":true,"region":"Bahia","latitude":-12,"longitude":-38}').name, 'Bahia');

// ---- Geocoding picker ------------------------------------------------------
const geo = model.parseGeocodingResults(JSON.stringify({
  results: [
    {name: 'Curitiba', admin1: 'Paraná', country: 'Brazil', latitude: -25.42, longitude: -49.27},
    {name: 'Curitiba', admin1: 'Mato Grosso', country: 'Brazil', latitude: -13.5, longitude: -56.0},
    {name: 'Bad row'}
  ]
}));
assert.equal(geo.length, 2);
assert.equal(geo[0].name, 'Curitiba');
assert.equal(geo[0].description, 'Paraná, Brazil');
assert.equal(geo[0].country, 'Brazil');
assert.equal(geo[0].latitude, -25.42);
assert.equal(model.parseGeocodingResults('not json').length, 0);
assert.equal(model.parseGeocodingResults('{}').length, 0);
assert.equal(model.parseGeocodingResults('{"results":[]}').length, 0);

const picked = model.locationCommit('whatever', geo, 1);
assert.equal(picked.name, 'Curitiba');
assert.equal(picked.latitude, -13.5);
const typed = model.locationCommit('  Malibu  ', [], 0);
assert.equal(typed.name, 'Malibu');
assert.equal(typed.latitude, null);
const cleared = model.locationCommit('', geo, 0);
assert.equal(cleared.name, '');
assert.equal(cleared.latitude, null);
assert.equal(model.locationCommit('x', geo, 99).name, 'Curitiba');

// ---- Setting normalization -------------------------------------------------
assert.equal(model.resolveUnit('KMH'), 'kmh');
assert.equal(model.resolveUnit(' mph '), 'mph');
assert.equal(model.resolveUnit('bogus'), 'kn');
assert.equal(model.resolveUnit(''), 'kn');
assert.equal(model.resolveLevel('850h'), '850h');
assert.equal(model.resolveLevel('bogus'), 'surface');
assert.equal(model.resolveLevel(''), 'surface');

// ---- Request contract ------------------------------------------------------
const payload = model.requestPayload({latitude: 49.809, longitude: 16.787, key: 'secret'});
assert.equal(payload.lat, 49.809);
assert.equal(payload.lon, 16.787);
assert.equal(payload.model, 'gfs');
assert.deepEqual([...payload.parameters],
  ['wind', 'windGust', 'temp', 'rh', 'precip', 'pressure', 'lclouds', 'mclouds', 'hclouds']);
assert.deepEqual([...payload.levels], ['surface']);
assert.equal(payload.key, 'secret');
assert.equal(model.requestError(payload), null);

assert.equal(model.requestError(model.requestPayload({latitude: 1, longitude: 2})), 'Missing Windy API key');
assert.equal(model.requestError(model.requestPayload({latitude: 91, longitude: 2, key: 'k'})), 'Invalid latitude');
assert.equal(model.requestError(model.requestPayload({latitude: 1, longitude: -181, key: 'k'})), 'Invalid longitude');
assert.equal(model.requestError(null), 'Missing request');
const custom = model.requestPayload({latitude: 1, longitude: 2, key: 'k', model: 'iconEu', levels: ['surface', '850h'], parameters: ['wind']});
assert.equal(custom.model, 'iconEu');
assert.deepEqual([...custom.levels], ['surface', '850h']);
assert.deepEqual([...custom.parameters], ['wind']);

// ---- Request hardening -----------------------------------------------------
// The API key travels in the request body written to curl's stdin. It must
// never appear in a process argument: argv is readable from /proc while the
// request runs and the shell logs the command when a process fails to start.
const secretPayload = model.requestPayload({latitude: 49.809, longitude: 16.787, key: 'WINDY-KEY-SECRET'});
const forecastCommand = [...model.forecastRequestCommand()];
const forecastBody = model.forecastRequestBody(secretPayload);

assert.equal(model.CURL_PATH, '/usr/bin/curl');
assert.equal(forecastCommand[0], model.CURL_PATH);
assert.ok(forecastCommand.every(argument => typeof argument === 'string'));
assert.ok(!forecastCommand.join('\u0000').includes('WINDY-KEY-SECRET'), 'API key must not reach argv');
assert.ok(!forecastCommand.some(argument => argument.includes('lat') || argument.includes('key')),
  'no request data in argv');
assert.equal(forecastCommand[forecastCommand.indexOf('--data-binary') + 1], '@-');
assert.equal(forecastCommand[forecastCommand.indexOf('--max-time') + 1], '10');
assert.equal(forecastCommand[forecastCommand.indexOf('--max-filesize') + 1],
  String(model.MAX_FORECAST_BYTES));
assert.ok(forecastCommand.includes('--fail-with-body'));
assert.equal(forecastCommand[forecastCommand.length - 1], model.API_URL);
assert.equal(forecastCommand.filter(argument => argument === '--data-binary').length, 1);

assert.equal(forecastBody, JSON.stringify(secretPayload));
assert.equal(JSON.parse(forecastBody).key, 'WINDY-KEY-SECRET');
assert.equal(model.forecastRequestBody(null), '');
assert.equal(model.forecastRequestBody('nope'), '');

const metadataCommands = [
  model.ipLocationCommand(),
  model.geocodeCommand('Malibu', 1),
  model.geocodeCommand('Malibu', 1, 5)
];
for (const command of metadataCommands) {
  assert.equal(command[0], model.CURL_PATH, 'metadata requests use the fixed executable');
  assert.ok(command.includes('--fail'));
  assert.ok(!command.includes('--fail-with-body'));
  assert.ok(!command.includes('@-'), 'metadata requests carry no stdin body');
  assert.equal(command[command.indexOf('--max-filesize') + 1], String(model.MAX_METADATA_BYTES));
  assert.match(command[command.length - 1], /^https:\/\//);
}
assert.ok(model.MAX_FORECAST_BYTES > 0 && Number.isInteger(model.MAX_FORECAST_BYTES));
assert.ok(model.MAX_METADATA_BYTES > 0 && model.MAX_METADATA_BYTES < model.MAX_FORECAST_BYTES);
assert.equal(model.ipLocationCommand()[model.ipLocationCommand().length - 1], model.IP_LOCATION_URL);
assert.equal(model.geocodeUrl('São Paulo', 5),
  'https://geocoding-api.open-meteo.com/v1/search?name=S%C3%A3o%20Paulo&count=5&language=en&format=json');
assert.equal(model.geocodeCommand('São Paulo', 5, 5)[model.geocodeCommand('São Paulo', 5, 5).length - 1],
  model.geocodeUrl('São Paulo', 5));
assert.equal(model.geocodeCommand('Malibu', 1)[model.geocodeCommand('Malibu', 1).indexOf('--max-time') + 1], '6');
assert.ok(model.curlArguments({timeoutSeconds: 3, maxBytes: 10}).includes('--fail'));

// ---- Keyring credentials ---------------------------------------------------
// The API key lives in the login keyring, and secret-tool is addressed by
// absolute path like curl. `store` receives the key over stdin, so the key
// never appears in a process command line.
assert.equal(model.SECRET_TOOL_PATH, '/usr/bin/secret-tool');
assert.ok(model.SECRET_ATTRIBUTES.length >= 2 && model.SECRET_ATTRIBUTES.length % 2 === 0);
assert.ok(model.SECRET_ATTRIBUTES.includes('io.github.minholi.windy'));

const lookupCommand = [...model.secretLookupCommand()];
assert.equal(lookupCommand[0], model.SECRET_TOOL_PATH);
assert.equal(lookupCommand[1], 'lookup');
assert.deepEqual(lookupCommand.slice(2), [...model.SECRET_ATTRIBUTES]);

const storeCommand = [...model.secretStoreCommand()];
assert.equal(storeCommand[0], model.SECRET_TOOL_PATH);
assert.equal(storeCommand[1], 'store');
assert.equal(storeCommand[2], '--label=' + model.SECRET_LABEL);
assert.deepEqual(storeCommand.slice(3), [...model.SECRET_ATTRIBUTES]);
assert.ok(!storeCommand.join('\u0000').includes('WINDY-KEY-SECRET'), 'the key must not reach argv');
assert.ok(!storeCommand.includes('@-'), 'store reads the key from stdin, not from a file argument');

const clearCommand = [...model.secretClearCommand()];
assert.equal(clearCommand[0], model.SECRET_TOOL_PATH);
assert.equal(clearCommand[1], 'clear');
assert.deepEqual(clearCommand.slice(2), [...model.SECRET_ATTRIBUTES]);

assert.equal(JSON.stringify(model.keyringEnvironment('/run/user/1000', 'unix:path=/run/user/1000/bus')),
  '{"XDG_RUNTIME_DIR":"/run/user/1000","DBUS_SESSION_BUS_ADDRESS":"unix:path=/run/user/1000/bus"}');
assert.equal(JSON.stringify(model.keyringEnvironment('/run/user/1000', '')),
  '{"XDG_RUNTIME_DIR":"/run/user/1000"}');
assert.equal(JSON.stringify(model.keyringEnvironment('', 'unix:path=/run/user/1000/bus')),
  '{"DBUS_SESSION_BUS_ADDRESS":"unix:path=/run/user/1000/bus"}');
assert.equal(JSON.stringify(model.keyringEnvironment('', '')), '{}');

assert.equal(model.trimSecret('WINDY-KEY-SECRET\n'), 'WINDY-KEY-SECRET');
assert.equal(model.trimSecret('  WINDY-KEY-SECRET  '), 'WINDY-KEY-SECRET');
assert.equal(model.trimSecret(null), '');
assert.equal(model.trimSecret(undefined), '');

assert.equal(model.legacyApiKey(' WINDY-KEY-SECRET\n'), 'WINDY-KEY-SECRET');
assert.equal(model.legacyApiKey(''), '');
const legacyEntry = {id: 'io.github.minholi.windy', apiKey: 'WINDY-KEY-SECRET', unit: 'kmh', display: 'both'};
assert.equal(JSON.stringify(model.entryWithoutApiKey(legacyEntry)),
  '{"id":"io.github.minholi.windy","unit":"kmh","display":"both"}');
assert.equal(JSON.stringify(model.entryWithoutApiKey(null)), '{}');

// ---- Weather parameters and levels -----------------------------------------
assert.ok(!model.requestParameters('gfs').includes('weatherWarnings'));
assert.ok(model.requestParameters('iconEu').includes('weatherWarnings'));
assert.ok(model.requestParameters('aromeFrance').includes('weatherWarnings'));
assert.deepEqual([...model.requestLevels('surface')], ['surface']);
assert.deepEqual([...model.requestLevels('850h')], ['surface', '850h']);
assert.deepEqual([...model.requestLevels('bogus')], ['surface']);

// ---- Temperature / rain / pressure normalization ---------------------------
approx(model.normalizeTemperature(290.6, 'K'), 17.45, 'kelvin to celsius');
approx(model.normalizeTemperature(32, 'F'), 0, 'fahrenheit to celsius');
approx(model.normalizeTemperature(21.5, 'C'), 21.5, 'celsius passthrough');
assert.equal(model.normalizeTemperature(null, 'K'), null);
approx(model.normalizePrecip(0.00322, 'm'), 3.22, 'metres to mm');
approx(model.normalizePrecip(2.5, 'mm'), 2.5, 'mm passthrough');
approx(model.normalizePrecip(1, 'in'), 25.4, 'inches to mm');
approx(model.normalizePrecip(1, 'kg*m-2'), 1, 'kg/m2 to mm');
approx(model.normalizePressure(101905, 'Pa'), 1019.05, 'pascal to hPa');
approx(model.normalizePressure(1013, 'hPa'), 1013, 'hPa passthrough');

// ---- Display units ---------------------------------------------------------
assert.equal(model.resolveTemperatureUnit('f', 'pt_BR.UTF-8'), 'f');
assert.equal(model.resolveTemperatureUnit('auto', 'en_US.UTF-8'), 'f');
assert.equal(model.resolveTemperatureUnit('auto', 'en_GB.UTF-8'), 'c');
assert.equal(model.resolveTemperatureUnit('auto', 'pt_BR.UTF-8'), 'c');
assert.equal(model.resolveTemperatureUnit('', 'my_MM'), 'f');
assert.equal(model.resolveTemperatureUnit('auto', 'en_US.UTF-8', 'Brazil'), 'c');
assert.equal(model.resolveTemperatureUnit('auto', 'pt_BR.UTF-8', 'United States'), 'f');
assert.equal(model.resolveTemperatureUnit('c', 'en_US.UTF-8', 'United States'), 'c');
assert.equal(model.countryUsesImperial(''), null);
assert.equal(model.countryUsesImperial('United States of America'), true);
assert.equal(model.countryUsesImperial('Germany'), false);
assert.equal(model.countryUsesImperial('Myanmar'), true);
assert.equal(model.formatTemperature(17.4, 'c', true), '17°C');
assert.equal(model.formatTemperature(17.4, 'f', true), '63°F');
assert.equal(model.formatTemperature(17.4, 'c', false), '17°');
assert.equal(model.formatTemperature(null, 'c', true), '');
assert.equal(model.precipUnitFor('f'), 'in');
assert.equal(model.precipUnitFor('c'), 'mm');
assert.equal(model.formatPrecip(3.22, 'mm'), '3.2 mm');
assert.equal(model.formatPrecip(14.6, 'mm'), '15 mm');
assert.equal(model.formatPrecip(25.4, 'in'), '1.00 in');
assert.equal(model.formatPrecip(null, 'mm'), '');

// ---- Condition derivation --------------------------------------------------
assert.equal(model.deriveCondition(20, 3, 1, 100, 90, null), 'rain');
assert.equal(model.deriveCondition(20, 0.5, 1, 100, 90, null), 'drizzle');
assert.equal(model.deriveCondition(-2, 1, 5, 100, 90, null), 'snow');
assert.equal(model.deriveCondition(1, 1, 7, 100, 90, null), 'sleet');
assert.equal(model.deriveCondition(-1, 1, 0, 100, 90, null), 'snow');
assert.equal(model.deriveCondition(20, 0, 0, 85, 60, null), 'cloudy');
assert.equal(model.deriveCondition(20, 0, 0, 40, 60, null), 'partly');
assert.equal(model.deriveCondition(20, 0, 0, 10, 60, null), 'clear');
assert.equal(model.deriveCondition(20, 0, 0, 90, 98, null), 'fog');
assert.equal(model.deriveCondition(20, 0, 0, 10, 60, 95), 'thunder');
assert.equal(model.deriveCondition(0, 0, 0, 10, 60, 71), 'snow');
assert.equal(model.deriveCondition(20, 0, 0, 10, 60, 51), 'drizzle');
assert.equal(model.conditionSeverity('thunder') > model.conditionSeverity('rain'), true);
assert.ok(model.conditionIcon('rain', false) !== '');
assert.notEqual(model.conditionIcon('clear', false), model.conditionIcon('clear', true));
assert.equal(model.conditionIcon('bogus', false), '');

// ---- Response parsing ------------------------------------------------------
const good = model.parseResponse('{"ts":[1],"units":{}}');
assert.equal(good.ok, true);
assert.equal(model.parseResponse('').ok, false);
assert.equal(model.parseResponse('not json').error, 'Invalid JSON response');
assert.equal(model.parseResponse('{"error":"Invalid API key"}').error, 'Invalid API key');
assert.equal(model.parseResponse('{"ts":[]}').error, 'No forecast times in response');

// ---- Forecast slicing ------------------------------------------------------
const now = Date.UTC(2026, 0, 1, 12, 0, 0);
const hour = 3600000;
const data = {
  ts: [now - hour, now, now + hour, now + 2 * hour, now + 3 * hour],
  units: {
    'wind_u-surface': 'm*s-1',
    'wind_v-surface': 'm*s-1',
    'gust-surface': 'm*s-1'
  },
  'wind_u-surface': [1, 3, null, 0, 0],
  'wind_v-surface': [0, 4, 0, -2, 0],
  'gust-surface': [2, 6, null, 3, 1]
};

const hourly = model.hourlyForecast(data, 'surface', now, 24, 48);
assert.equal(hourly.length, 3);
approx(hourly[0].speedMs, 5, 'u/v magnitude');
assert.equal(Math.round(hourly[0].from), 217);
approx(hourly[0].gustMs, 6, 'gust');
assert.equal(hourly[1].from, 0);
approx(hourly[2].speedMs, 0, 'calm');
assert.ok(hourly.every(point => point.ms >= now));

assert.equal(model.hourlyForecast(data, 'surface', now, 24, 2).length, 2);
assert.equal(model.hourlyForecast(data, 'surface', now, 1, 48).length, 1);
assert.equal(model.hourlyForecast(data, '850h', now, 24, 48).length, 0);
assert.equal(model.hourlyForecast(null, 'surface', now, 24, 48).length, 0);

const current = model.currentForecast(data, 'surface', now + 30 * 60 * 1000);
approx(current.speedMs, 5, 'nearest forecast');
const latest = model.currentForecast(data, 'surface', now + 10 * hour);
approx(latest.speedMs, 0, 'falls back to last available point');
assert.equal(model.currentForecast(data, '850h', now), null);

// ---- Full forecast point and daily aggregation -----------------------------
const dayBase = Date.UTC(2026, 0, 1, 0, 0, 0);
const hourMs = 3600000;
const full = {
  ts: [0, 3, 6, 9, 12, 15, 24, 27].map(h => dayBase + h * hourMs),
  units: {
    'wind_u-surface': 'm*s-1', 'wind_v-surface': 'm*s-1', 'gust-surface': 'm*s-1',
    'temp-surface': 'K', 'past3hprecip-surface': 'm', 'pressure-surface': 'Pa',
    'rh-surface': '%', 'lclouds-surface': '%', 'mclouds-surface': '%', 'hclouds-surface': '%'
  },
  'wind_u-surface': [1, 1, 1, 1, 1, 1, 1, 1],
  'wind_v-surface': [0, 0, 0, 0, 0, 0, 0, 0],
  'gust-surface': [2, 2, 2, 2, 2, 2, 2, 2],
  'temp-surface': [273.15, 275.15, 283.15, 293.15, 288.15, 278.15, 271.15, 274.15],
  'past3hprecip-surface': [0, 0.001, 0.003, 0, 0, 0.002, 0, 0],
  'pressure-surface': Array(8).fill(101000),
  'rh-surface': Array(8).fill(80),
  'lclouds-surface': [90, 80, 100, 50, 40, 70, 10, 5],
  'mclouds-surface': Array(8).fill(0),
  'hclouds-surface': Array(8).fill(0)
};

const point = model.forecastPoint(full, 'surface', 2);
approx(point.tempC, 10, 'point temperature');
approx(point.precipMm, 3, 'point precipitation');
approx(point.pressureHpa, 1010, 'point pressure');
assert.equal(point.rh, 80);
assert.equal(point.condition, 'rain');
assert.equal(model.forecastPoint(full, 'surface', 1).condition, 'drizzle');
assert.equal(model.forecastPoint(full, 'surface', 3).condition, 'partly');
assert.equal(model.forecastPoint(full, 'surface', 6).condition, 'clear');

const days = model.dailyForecast(full, 'surface', dayBase + hourMs, 2, 0);
assert.equal(days.length, 2);
assert.equal(days[0].dateMs, dayBase);
approx(days[0].minTempC, 0, 'day min');
approx(days[0].maxTempC, 20, 'day max');
approx(days[0].precipMm, 6, 'day rain total');
assert.equal(days[0].condition, 'rain');
approx(days[1].minTempC, -2, 'next day min');
approx(days[1].maxTempC, 1, 'next day max');
approx(days[1].precipMm, 0, 'next day rain');
assert.equal(days[1].condition, 'clear');
assert.equal(model.dailyForecast(full, 'surface', dayBase + hourMs, 1, 0).length, 1);
assert.equal(model.dailyForecast(full, 'surface', dayBase + hourMs, 3, 180).length, 3);
assert.equal(model.dailyForecast(null, 'surface', dayBase, 3, 0).length, 0);

// ---- QML scaffold ----------------------------------------------------------
const barWidget = fs.readFileSync(new URL('./BarWidget.qml', import.meta.url), 'utf8');
assert.match(barWidget, /^BarWidget\s*\{/m);
assert.match(barWidget, /moduleName:\s*"io\.github\.minholi\.windy"/);
for (const method of ['open', 'close', 'toggle', 'closeForPopoutSwitch'])
  assert.match(barWidget, new RegExp(`function\\s+${method}\\s*\\(`));
assert.match(barWidget, /source:\s*Qt\.resolvedUrl\("Panel\.qml"\)/);
assert.match(barWidget, /target\.anchorItem\s*=\s*button/);
assert.match(barWidget, /target\.hostWidget\s*=\s*root/);
assert.match(barWidget, /WidgetButton\s*\{/);
assert.match(barWidget, /hasVisualContent:\s*true/);
assert.match(barWidget, /dimmed:\s*!root\.hasData/);
assert.match(barWidget, /setting\("display",\s*"temp"\)/);
assert.match(barWidget, /root\.conditionGlyph/);
assert.match(barWidget, /root\.temperatureText/);
assert.match(barWidget, /visible:\s*root\.displayMode !== "wind"/);
assert.match(barWidget, /displayMode === "both"/);
assert.doesNotMatch(barWidget, /\bIpcHandler\s*\{/);

const panel = fs.readFileSync(new URL('./Panel.qml', import.meta.url), 'utf8');
assert.match(panel, /^Panel\s*\{/m);
assert.match(panel, /ipcTarget:\s*"io\.github\.minholi\.windy"/);
assert.match(panel, /manageIpc:\s*false/);
assert.match(panel, /function\s+openFromHotkey\s*\(/);
assert.match(panel, /function\s+refresh\s*\(/);
assert.match(panel, /KeyboardPanel\s*\{/);
assert.match(panel, /import\s+"Model\.js"\s+as\s+Model/);
assert.match(panel, /Quickshell\.env\("WINDY_API_KEY"\)/);
assert.match(panel, /Model\.parseLocationFile\(/);
assert.match(panel, /Model\.currentForecast\(/);
assert.match(panel, /Model\.hourlyForecast\(/);
assert.match(panel, /Model\.dailyForecast\(/);
assert.match(panel, /Model\.requestParameters\(/);
assert.match(panel, /Model\.requestLevels\(/);
assert.match(panel, /Model\.resolveTemperatureUnit\(/);
assert.match(panel, /Model\.precipUnitFor\(/);
assert.match(panel, /Model\.parseGeocodingResults\(/);
assert.match(panel, /Model\.locationCommit\(/);
for (const method of ['startEditingLocation', 'commitLocation', 'clearLocation', 'pickSuggestion', 'resolveLocationName'])
  assert.match(panel, new RegExp(`function\\s+${method}\\s*\\(`));
assert.match(panel, /omarchy-weather-location/);
assert.match(panel, /Model\.geocodeCommand\(/);
assert.match(panel, /Model\.ipLocationCommand\(/);
// The forecast body is piped into curl's stdin and never becomes an argument.
assert.match(panel, /Model\.forecastRequestCommand\(/);
assert.match(panel, /Model\.forecastRequestBody\(/);
assert.match(panel, /stdinEnabled:\s*root\.requestBody !== ""/);
assert.match(panel, /write\(root\.requestBody\)/);
assert.match(panel, /clearEnvironment:\s*true/);
assert.match(panel, /environment:\s*\(\{\}\)/);
assert.ok(!panel.includes('["curl"'), 'Panel must not run curl from PATH');
assert.ok(!/command:\s*\[[^\]]*apiKey/.test(panel), 'no command may take the API key');
// Credentials come from the keyring and the key is piped to secret-tool's stdin.
assert.match(panel, /Model\.secretLookupCommand\(/);
assert.match(panel, /Model\.secretStoreCommand\(/);
assert.match(panel, /Model\.secretClearCommand\(/);
assert.match(panel, /stdinEnabled:\s*root\.keyringStoreBody !== ""/);
assert.match(panel, /write\(root\.keyringStoreBody\)/);
assert.match(panel, /environment:\s*Model\.keyringEnvironment\(/);
assert.match(panel, /Model\.entryWithoutApiKey\(/);
assert.ok(!/saveSetting\(\s*"apiKey"/.test(panel), 'the API key must not be written to shell.json');
assert.ok(!panel.includes('omarchy bar set'), 'the API key is set through the keyring, not shell.json');
assert.match(panel, /component\s+SettingChip/);
for (const method of ['openSettings', 'closeSettings', 'saveSetting', 'commitApiKey'])
  assert.match(panel, new RegExp(`function\\s+${method}\\s*\\(`));
assert.match(panel, /password:\s*true/);
assert.match(panel, /updateEntryInline/);
assert.match(panel, /function\s+settings\s*\(\s*\)\s*:\s*void/);
assert.match(panel, /Model\.conditionIcon\(/);
assert.match(panel, /Model\.formatTemperature\(/);
assert.match(panel, /function\s+status\s*\(\s*\)\s*:\s*string/);
assert.match(panel, /function\s+openWindy\s*\(/);
assert.match(panel, /https:\/\/www\.windy\.com\/\?/);

console.log('model tests passed');
