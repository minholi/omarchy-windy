import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const model = {};
vm.createContext(model);
vm.runInContext(fs.readFileSync(new URL('./Model.js', import.meta.url), 'utf8'), model, {filename: 'Model.js'});

const openmeteo = {};
vm.createContext(openmeteo);
vm.runInContext(fs.readFileSync(new URL('./OpenMeteo.js', import.meta.url), 'utf8'), openmeteo, {filename: 'OpenMeteo.js'});

const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

function approx(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} !== ${expected}`);
}

function schemaRow(key) {
  return manifest.barWidget.schema.find(row => row.key === key);
}

// ---- Provider contract -----------------------------------------------------
assert.equal(schemaRow('provider').defaultValue, 'openmeteo');
assert.ok(schemaRow('provider').options.includes('windy'));
assert.ok(schemaRow('provider').options.includes('auto'));
assert.equal(manifest.barWidget.defaults.provider, 'openmeteo');
assert.equal(model.resolveProvider('openmeteo', true), 'openmeteo');
assert.equal(model.resolveProvider('windy', false), 'windy');
assert.equal(model.resolveProvider('auto', true), 'windy');
assert.equal(model.resolveProvider('auto', false), 'openmeteo');
assert.equal(model.resolveProvider('', false), 'openmeteo');
assert.equal(model.resolveProvider('bogus', true), 'openmeteo');

// ---- Model mapping ---------------------------------------------------------
assert.equal(openmeteo.resolveModel('auto'), 'best_match');
assert.equal(openmeteo.resolveModel(''), 'best_match');
assert.equal(openmeteo.resolveModel('bogus'), 'best_match');
assert.equal(openmeteo.resolveModel('namHawaii'), 'best_match');
assert.equal(openmeteo.resolveModel('gfs'), 'gfs_seamless');
assert.equal(openmeteo.resolveModel('icon'), 'icon_seamless');
assert.equal(openmeteo.resolveModel('iconEu'), 'icon_eu');
assert.equal(openmeteo.resolveModel('iconD2'), 'icon_d2');
assert.equal(openmeteo.resolveModel('aromeFrance'), 'meteofrance_arome_france_hd');
assert.equal(openmeteo.resolveModel('hrrrConus'), 'gfs_hrrr');
assert.equal(openmeteo.resolveModel('canHrdps'), 'gem_hrdps_continental');
assert.equal(openmeteo.modelLabel('gfs_seamless'), 'GFS seamless');
assert.equal(openmeteo.modelLabel('bogus'), 'Best match');

// ---- Levels ----------------------------------------------------------------
assert.equal(openmeteo.findLevel('surface'), 'surface');
assert.equal(openmeteo.findLevel('850h'), '850h');
assert.equal(openmeteo.findLevel('bogus'), 'surface');
assert.ok(openmeteo.hourlyVariables('surface').includes('wind_speed_10m'));
assert.ok(!openmeteo.hourlyVariables('surface').includes('wind_speed_850hPa'));
assert.ok(openmeteo.hourlyVariables('850h').includes('wind_speed_850hPa'));
assert.ok(openmeteo.hourlyVariables('850h').includes('wind_direction_850hPa'));
assert.ok(openmeteo.hourlyVariables('300h').includes('wind_speed_300hPa'));

// ---- URL and command -------------------------------------------------------
const url = openmeteo.forecastUrl({ latitude: -23.18639, longitude: -46.88417, model: 'gfs', level: '850h' });
assert.ok(url.startsWith('https://api.open-meteo.com/v1/forecast?'));
assert.ok(url.includes('latitude=-23.18639'));
assert.ok(url.includes('longitude=-46.88417'));
assert.ok(url.includes('wind_speed_unit=ms'));
assert.ok(url.includes('temperature_unit=celsius'));
assert.ok(url.includes('timezone=GMT'));
assert.ok(url.includes('past_days=1'));
assert.ok(url.includes('forecast_days=10'));
assert.ok(url.includes('cell_selection=nearest'));
assert.ok(url.includes('models=gfs_seamless'));
assert.ok(url.includes('wind_speed_10m'));
assert.ok(url.includes('wind_speed_850hPa'));

const command = openmeteo.forecastCommand({ latitude: 1, longitude: 2, model: 'auto', level: 'surface' });
assert.equal(command[0], '/usr/bin/curl');
assert.ok(command.includes('--max-time'));
assert.ok(command.includes('--max-filesize'));
assert.equal(command[command.length - 1], openmeteo.forecastUrl({ latitude: 1, longitude: 2, model: 'auto', level: 'surface' }));
assert.ok(!command.some(part => /apiKey|secret/i.test(part)), 'the command may not carry a credential');

// ---- Direction -> u/v ------------------------------------------------------
// Meteorological direction is where the wind blows FROM; u/v describe where it
// blows TOWARD (east/north positive).
const fromNorth = openmeteo.directionToUv(5, 0);
approx(fromNorth.u, 0, 'north wind u');
approx(fromNorth.v, -5, 'north wind v');
const fromEast = openmeteo.directionToUv(5, 90);
approx(fromEast.u, -5, 'east wind u');
approx(fromEast.v, 0, 'east wind v');
const fromWest = openmeteo.directionToUv(5, 270);
approx(fromWest.u, 5, 'west wind u');
assert.equal(openmeteo.directionToUv(null, 10), null);
assert.equal(openmeteo.directionToUv(10, 'nope'), null);

// Round trip through Model's vector math keeps speed and direction.
const uv = openmeteo.directionToUv(7.5, 137);
const wind = model.uvToSpeedDir(uv.u, uv.v);
approx(wind.speed, 7.5, 'speed round trip');
approx(wind.from, 137, 'direction round trip');

// ---- WMO condition codes ---------------------------------------------------
assert.equal(openmeteo.weatherCodeCondition(0), 'clear');
assert.equal(openmeteo.weatherCodeCondition(2), 'partly');
assert.equal(openmeteo.weatherCodeCondition(3), 'cloudy');
assert.equal(openmeteo.weatherCodeCondition(45), 'fog');
assert.equal(openmeteo.weatherCodeCondition(53), 'drizzle');
assert.equal(openmeteo.weatherCodeCondition(56), 'sleet');
assert.equal(openmeteo.weatherCodeCondition(63), 'rain');
assert.equal(openmeteo.weatherCodeCondition(75), 'snow');
assert.equal(openmeteo.weatherCodeCondition(81), 'rain');
assert.equal(openmeteo.weatherCodeCondition(86), 'snow');
assert.equal(openmeteo.weatherCodeCondition(96), 'thunder');
assert.equal(openmeteo.weatherCodeCondition('nope'), '');

// ---- Response parsing ------------------------------------------------------
const hourly = {
  time: ['2026-09-17T18:00', '2026-09-17T19:00', '2026-09-17T20:00'],
  wind_speed_10m: [4, 2, 6],
  wind_direction_10m: [0, 90, 270],
  wind_gusts_10m: [8, 5, 9],
  temperature_2m: [20, 21, 22],
  relative_humidity_2m: [50, 60, 70],
  precipitation: [0.4, 0, 1.2],
  surface_pressure: [1010, 1011, 1012],
  cloud_cover_low: [10, 20, 30],
  cloud_cover_mid: [40, 50, 60],
  cloud_cover_high: [70, 80, 90],
  weather_code: [3, 61, 0],
  wind_speed_850hPa: [10, 12, 14],
  wind_direction_850hPa: [180, 200, 220]
};
const shaped = openmeteo.shapeForecast(hourly);
assert.equal(shaped.ts[0], Date.parse('2026-09-17T18:00Z'));
assert.equal(shaped.precipWindowHours, 1);
approx(shaped['wind_v-surface'][0], -4, 'north wind v');
approx(shaped['wind_u-surface'][1], -2, 'east wind u');
approx(shaped['wind_u-surface'][2], 6, 'west wind u');
approx(shaped['past3hprecip-surface'][2], 1.2, 'hourly rain kept as-is');
assert.equal(shaped['condition-surface'][1], 'drizzle');
assert.equal(shaped.units['temp-surface'], 'C');
assert.equal(shaped.units['wind_u-850h'], 'm*s-1');

const parsed = openmeteo.parseResponse(JSON.stringify({ hourly: hourly }));
assert.equal(parsed.ok, true);

// The parsed shape feeds the provider-agnostic forecast code unchanged.
const now = Date.parse('2026-09-17T19:30Z');
const current = model.forecastAt(parsed.data, 'surface', now);
approx(current.tempC, 21.5, 'interpolated temperature');
approx(current.speedMs, 2, 'interpolated speed');
approx(current.from, 270, 'interpolated direction');
approx(current.gustMs, 7, 'interpolated gust');
approx(current.precipMm, 1.2, 'rain snaps to the nearest step');
assert.equal(current.condition, 'clear');
const high = model.forecastAt(parsed.data, '850h', now);
// Blending happens on the u/v components, so compare against the same chord
// midpoint rather than the arithmetic mean of speed and direction.
const lowerUv = openmeteo.directionToUv(12, 200);
const upperUv = openmeteo.directionToUv(14, 220);
const expectedUv = model.uvToSpeedDir((lowerUv.u + upperUv.u) / 2, (lowerUv.v + upperUv.v) / 2);
approx(high.speedMs, expectedUv.speed, 'pressure-level speed');
approx(high.from, expectedUv.from, 'pressure-level direction');
assert.equal(model.hourlyForecast(parsed.data, 'surface', now, 24, 8).length, 1);
assert.equal(model.dailyForecast(parsed.data, 'surface', now, 4, 0).length, 1);

// A condition series with no matching wind series has no usable point.
assert.equal(model.forecastAt({ ts: [now], 'condition-surface': ['rain'] }, 'surface', now), null);

// ---- Error shapes ----------------------------------------------------------
const outOfDomain = openmeteo.parseResponse('{"error":true,"reason":"No data is available for this location"}');
assert.equal(outOfDomain.ok, false);
assert.equal(outOfDomain.error, 'No data is available for this location');
assert.equal(openmeteo.parseResponse('').ok, false);
assert.equal(openmeteo.parseResponse('nope').error, 'Invalid JSON response');
assert.equal(openmeteo.parseResponse('{"hourly":{"time":[]}}').error, 'No forecast times in response');
assert.equal(openmeteo.parseResponse('{"hourly":{"time":["2026-09-17T18:00"]}}').error, 'No forecast values in response');

// ---- QML wiring ------------------------------------------------------------
const panel = fs.readFileSync(new URL('./Panel.qml', import.meta.url), 'utf8');
assert.match(panel, /import\s+"OpenMeteo\.js"\s+as\s+OpenMeteo/);
assert.match(panel, /OpenMeteo\.forecastCommand\(/);
assert.match(panel, /OpenMeteo\.parseResponse\(/);
assert.match(panel, /Model\.resolveProvider\(/);
assert.match(panel, /setting\("provider",\s*"openmeteo"\)/);
assert.match(panel, /provider === "windy" && apiKey === ""/);
assert.match(panel, /OpenMeteo\.resolveModel\(/);
assert.match(panel, /OpenMeteo\.modelLabel\(/);
assert.ok(!/^\s*if \(apiKey === ""\) return$/m.test(panel), 'Open-Meteo must not require an API key');
assert.match(panel, /cc by 4\.0/i);

console.log('openmeteo tests passed');
