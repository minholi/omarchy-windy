// Pure data shaping for the Windy bar widget. Keep this file free of QML
// globals so the request contract, wind math, and response parsing can also
// be exercised by Node in CI (see model.test.mjs).

var API_URL = "https://api.windy.com/api/point-forecast/v2"
var IP_LOCATION_URL = "https://ipwho.is/"
var GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
var FALLBACK_MODEL = "gfs"

// Fixed, trusted executable. Requests never resolve curl through PATH, so an
// entry in the widget's environment cannot substitute another binary.
var CURL_PATH = "/usr/bin/curl"

// The API key lives in the login keyring (Secret Service), never in shell.json.
// secret-tool is addressed by absolute path, and the key reaches `store` over
// stdin so it never appears in a process command line.
var SECRET_TOOL_PATH = "/usr/bin/secret-tool"
var SECRET_LABEL = "Windy API key"
var SECRET_ATTRIBUTES = ["service", "windy", "account", "minholi.windy"]

// Producer-side response ceilings. StdioCollector buffers whatever the producer
// writes, so curl itself is told to give up (exit 63) instead of letting a
// hostile or malformed response grow shell memory: point forecasts are a few
// tens of kilobytes, the metadata lookups a few kilobytes.
var MAX_FORECAST_BYTES = 262144
var MAX_METADATA_BYTES = 65536

// Point Forecast models with the region boxes autoModel() tests, most
// specific first. Global models carry no bounds and are never auto-picked.
var MODELS = [
  { id: "namHawaii", label: "NAM Hawaii", latMin: 15, latMax: 26, lonMin: -163, lonMax: -152 },
  { id: "namAlaska", label: "NAM Alaska", latMin: 50, latMax: 72, lonMin: -180, lonMax: -125 },
  { id: "hrrrConus", label: "HRRR (CONUS)", latMin: 21, latMax: 53, lonMin: -134, lonMax: -60 },
  { id: "canHrdps", label: "HRDPS Canada", latMin: 40, latMax: 75, lonMin: -145, lonMax: -50 },
  { id: "aromeFrance", label: "AROME France", latMin: 37.5, latMax: 51.5, lonMin: -5.5, lonMax: 8.5 },
  { id: "iconD2", label: "ICON-D2", latMin: 43, latMax: 56, lonMin: 2, lonMax: 18 },
  { id: "iconEu", label: "ICON-EU", latMin: 29, latMax: 72, lonMin: -25, lonMax: 45 },
  { id: "gfs", label: "GFS (global)" },
  { id: "icon", label: "ICON (global)" },
  { id: "namConus", label: "NAM (CONUS)" }
]

var LEVELS = [
  { id: "surface", label: "10 m" },
  { id: "850h", label: "850 hPa" },
  { id: "700h", label: "700 hPa" },
  { id: "500h", label: "500 hPa" },
  { id: "300h", label: "300 hPa" }
]

// factor converts m/s into the unit.
var SPEED_UNITS = [
  { id: "kn", label: "kn", factor: 1.943844 },
  { id: "kmh", label: "km/h", factor: 3.6 },
  { id: "mph", label: "mph", factor: 2.236936 },
  { id: "ms", label: "m/s", factor: 1 }
]

// weatherWarnings is not offered by every model; requesting it elsewhere is a
// 400. These models accept it and give a WMO-style code per 3 h window.
var WARNING_MODELS = ["arome", "aromeAntilles", "aromeFrance", "aromeReunion", "icon", "iconD2", "iconEu"]

var CONDITION_ICONS = {
  clear: { day: "\ue30d", night: "\ue32b" },
  partly: { day: "\ue302", night: "\ue32e" },
  cloudy: { day: "\ue33d", night: "\ue33d" },
  fog: { day: "\ue313", night: "\ue346" },
  drizzle: { day: "\ue318", night: "\ue318" },
  rain: { day: "\ue318", night: "\ue318" },
  snow: { day: "\ue31a", night: "\ue31a" },
  sleet: { day: "\ue3ad", night: "\ue3ad" },
  thunder: { day: "\ue31d", night: "\ue31d" }
}

// Short human-readable text for each derived condition, shown under the
// location in the panel hero.
var CONDITION_LABELS = {
  clear: "Clear",
  partly: "Partly cloudy",
  cloudy: "Cloudy",
  fog: "Fog",
  drizzle: "Drizzle",
  rain: "Rain",
  snow: "Snow",
  sleet: "Sleet",
  thunder: "Thunderstorm"
}

var CONDITION_SEVERITY = {
  clear: 0, partly: 1, cloudy: 2, fog: 3,
  drizzle: 4, rain: 5, sleet: 6, snow: 7, thunder: 8
}

function findById(list, id) {
  var wanted = String(id === undefined || id === null ? "" : id).replace(/^\s+|\s+$/g, "")
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === wanted) return list[i]
  }
  return null
}

function modelById(id) { return findById(MODELS, id) }
function levelById(id) { return findById(LEVELS, id) }
function speedUnitById(id) { return findById(SPEED_UNITS, id) }

function modelLabel(id) {
  var model = modelById(id)
  return model ? model.label : ""
}

function levelLabel(id) {
  var level = levelById(id)
  return level ? level.label : ""
}

function unitLabel(id) {
  var unit = speedUnitById(id)
  return unit ? unit.label : ""
}

function autoModel(latitude, longitude) {
  var lat = Number(latitude)
  var lon = Number(longitude)
  if (!isFinite(lat) || !isFinite(lon)) return FALLBACK_MODEL

  for (var i = 0; i < MODELS.length; i++) {
    var model = MODELS[i]
    if (model.latMin === undefined) continue
    if (lat >= model.latMin && lat <= model.latMax && lon >= model.lonMin && lon <= model.lonMax)
      return model.id
  }
  return FALLBACK_MODEL
}

// User setting -> concrete API model id. "auto" (and blank) resolves against
// the coordinates; unknown ids fall back to the global model.
function resolveModel(setting, latitude, longitude) {
  var id = String(setting === undefined || setting === null ? "" : setting).replace(/^\s+|\s+$/g, "")
  if (id === "" || id === "auto") return autoModel(latitude, longitude)
  return modelById(id) ? id : FALLBACK_MODEL
}

// Provider setting -> concrete provider. "auto" prefers Windy only when a key
// is configured; Open-Meteo is the keyless default, so it also wins for blank
// and unknown values.
function resolveProvider(setting, hasKey) {
  var id = String(setting === undefined || setting === null ? "" : setting)
    .replace(/^\s+|\s+$/g, "")
    .toLowerCase()
  if (id === "windy") return "windy"
  if (id === "auto") return hasKey ? "windy" : "openmeteo"
  return "openmeteo"
}

// API units strings look like "m*s-1", "km*h-1", or "kn". The returned
// factor converts a value in that unit into m/s.
function normalizeSpeedUnit(raw) {
  var unit = String(raw === undefined || raw === null ? "" : raw)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\*/g, "")
    .replace(/\^/g, "")
  if (unit === "ms-1" || unit === "m/s" || unit === "mps") return 1
  if (unit === "kmh-1" || unit === "km/h" || unit === "kmph" || unit === "kmh") return 1 / 3.6
  if (unit === "mih-1" || unit === "mi/h" || unit === "mph") return 0.44704
  if (unit === "kn" || unit === "kt" || unit === "knot" || unit === "knots") return 0.514444
  return 1
}

function normalizeSpeed(value, unitsString) {
  if (value === undefined || value === null || value === "") return null
  var number = Number(value)
  if (!isFinite(number)) return null
  return number * normalizeSpeedUnit(unitsString)
}

function speedUnitFactor(unitId) {
  var unit = speedUnitById(unitId)
  return unit ? unit.factor : 1
}

function speedToUnit(ms, unitId) {
  if (ms === undefined || ms === null || ms === "") return null
  var number = Number(ms)
  if (!isFinite(number)) return null
  return number * speedUnitFactor(unitId)
}

function formatSpeed(ms, unitId) {
  var value = speedToUnit(ms, unitId)
  if (value === null) return ""
  return String(Math.round(value))
}

function unitToken(raw) {
  return String(raw === undefined || raw === null ? "" : raw)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\*/g, "")
    .replace(/\^/g, "")
}

// The API reports temperature in Kelvin, precipitation in metres, and
// pressure in pascals. Normalize everything to °C, mm, and hPa so the display
// layer never has to know the wire format.
function normalizeTemperature(value, unitsString) {
  if (value === undefined || value === null || value === "") return null
  var number = Number(value)
  if (!isFinite(number)) return null
  var unit = unitToken(unitsString)
  if (unit === "k" || unit === "kelvin") return number - 273.15
  if (unit === "f" || unit === "°f" || unit === "degf") return (number - 32) * 5 / 9
  return number
}

function normalizePrecip(value, unitsString) {
  if (value === undefined || value === null || value === "") return null
  var number = Number(value)
  if (!isFinite(number)) return null
  var unit = unitToken(unitsString)
  if (unit === "m") return number * 1000
  if (unit === "cm") return number * 10
  if (unit === "in" || unit === "inch" || unit === "inches") return number * 25.4
  return number
}

function normalizePressure(value, unitsString) {
  if (value === undefined || value === null || value === "") return null
  var number = Number(value)
  if (!isFinite(number)) return null
  var unit = unitToken(unitsString)
  if (unit === "pa" || unit === "pascal" || unit === "pascals") return number / 100
  return number
}

function localeUsesImperial(localeName) {
  var name = String(localeName === undefined || localeName === null ? "" : localeName).replace(".", "_")
  return /^en[_-]US($|[_.-])/.test(name) || /^en[_-]LR($|[_.-])/.test(name) || /^my($|[_.-])/.test(name)
}

// Null when the country is unknown, so the caller can fall back to the locale.
function countryUsesImperial(countryName) {
  var country = String(countryName === undefined || countryName === null ? "" : countryName)
    .replace(/^\s+|\s+$/g, "")
    .replace(/[._-]+/g, " ")
    .toLowerCase()
  if (!country) return null
  if (country === "us" || country === "usa" || country === "united states" || country === "united states of america") return true
  if (country === "liberia" || country === "myanmar" || country === "burma") return true
  return false
}

// Explicit setting wins; otherwise the location's country, then the locale.
function resolveTemperatureUnit(setting, localeName, countryName) {
  var id = unitToken(setting)
  if (id === "c" || id === "celsius") return "c"
  if (id === "f" || id === "fahrenheit") return "f"

  var countryPreference = countryUsesImperial(countryName)
  if (countryPreference !== null) return countryPreference ? "f" : "c"
  return localeUsesImperial(localeName) ? "f" : "c"
}

function temperatureValue(celsius, unitId) {
  if (celsius === undefined || celsius === null || celsius === "") return null
  var number = Number(celsius)
  if (!isFinite(number)) return null
  return unitId === "f" ? number * 9 / 5 + 32 : number
}

function formatTemperature(celsius, unitId, withUnit) {
  var value = temperatureValue(celsius, unitId)
  if (value === null) return ""
  return String(Math.round(value)) + "°" + (withUnit ? (unitId === "f" ? "F" : "C") : "")
}

function apparentTemperatureC(tempC, rh, windMs) {
  if (tempC === undefined || tempC === null || tempC === "" ||
      rh === undefined || rh === null || rh === "" ||
      windMs === undefined || windMs === null || windMs === "") return null
  var temp = Number(tempC)
  var humidity = Number(rh)
  var wind = Number(windMs)
  if (!isFinite(temp) || !isFinite(humidity) || !isFinite(wind)) return null
  var vapourPressure = humidity / 100 * 6.105 * Math.exp(17.27 * temp / (237.7 + temp))
  return temp + 0.33 * vapourPressure - 0.7 * wind - 4
}

function precipUnitFor(temperatureUnit) {
  return temperatureUnit === "f" ? "in" : "mm"
}

function precipValue(millimeters, unitId) {
  if (millimeters === undefined || millimeters === null || millimeters === "") return null
  var number = Number(millimeters)
  if (!isFinite(number)) return null
  return unitId === "in" ? number / 25.4 : number
}

function formatPrecip(millimeters, unitId) {
  var value = precipValue(millimeters, unitId)
  if (value === null) return ""
  if (unitId === "in") return value.toFixed(2) + " in"
  if (value < 10) return value.toFixed(1) + " mm"
  return String(Math.round(value)) + " mm"
}

function conditionIcon(condition, night) {
  var icons = CONDITION_ICONS[String(condition)]
  if (!icons) return ""
  return night ? icons.night : icons.day
}

function conditionLabel(condition) {
  return CONDITION_LABELS[String(condition)] || ""
}

function weatherWarningCondition(code) {
  var c = Number(code)
  if (!isFinite(c)) return ""
  if (c === 45 || c === 48) return "fog"
  if (c === 56 || c === 57 || c === 66 || c === 67) return "sleet"
  if (c >= 95) return "thunder"
  if (c >= 71 && c <= 77) return "snow"
  if (c === 85 || c === 86) return "snow"
  if (c === 61) return "drizzle"
  if (c >= 63 && c <= 65) return "rain"
  if (c === 80 || c === 81 || c === 82) return "rain"
  if (c >= 51 && c <= 55) return "drizzle"
  return ""
}

// Best-effort sky state from what the model actually exposes: an explicit
// weather warning code when the model has one, else precipitation amount,
// type, temperature, cloud layers, and humidity.
function deriveCondition(tempC, precipMm, ptype, cloudCover, rh, warningCode) {
  var fromWarning = weatherWarningCondition(warningCode)
  if (fromWarning !== "") return fromWarning

  var precip = isFinite(Number(precipMm)) ? Number(precipMm) : 0
  var type = isFinite(Number(ptype)) ? Math.round(Number(ptype)) : 0

  if (precip > 0.15) {
    if (type === 5) return "snow"
    if (type === 3 || type === 7 || type === 8) return "sleet"
    if (type === 1) return precip >= 2.5 ? "rain" : "drizzle"
    var temp = Number(tempC)
    if (isFinite(temp) && temp <= 0.5) return "snow"
    return precip >= 2.5 ? "rain" : "drizzle"
  }

  var cover = isFinite(Number(cloudCover)) ? Number(cloudCover) : 0
  if (isFinite(Number(rh)) && Number(rh) >= 97 && cover >= 60) return "fog"
  if (cover >= 80) return "cloudy"
  if (cover >= 35) return "partly"
  return "clear"
}

function conditionSeverity(condition) {
  var value = CONDITION_SEVERITY[String(condition)]
  return value === undefined ? -1 : value
}

function requestParameters(model) {
  var parameters = ["wind", "windGust", "temp", "rh", "precip", "pressure",
    "lclouds", "mclouds", "hclouds"]
  if (WARNING_MODELS.indexOf(String(model)) !== -1) parameters.push("weatherWarnings")
  return parameters
}

// Wind (and temp/rh) levels: "surface" is the 10 m wind and 2 m temperature.
// Always request surface so temperature is available whichever wind level is
// selected.
function requestLevels(level) {
  var selected = levelById(level) ? level : "surface"
  return selected === "surface" ? ["surface"] : ["surface", selected]
}

// Windy reports wind as u (eastward) / v (northward) components. "from" is
// the meteorological direction the wind blows from, clockwise from north.
function uvToSpeedDir(u, v) {
  var east = Number(u)
  var north = Number(v)
  if (!isFinite(east) || !isFinite(north)) return null

  var speed = Math.sqrt(east * east + north * north)
  var toward = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360
  return { speed: speed, toward: toward, from: (toward + 180) % 360 }
}

var COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]

function compass(degrees) {
  var value = Number(degrees)
  if (!isFinite(value)) return ""
  var normalized = ((value % 360) + 360) % 360
  return COMPASS_POINTS[Math.round(normalized / 22.5) % 16]
}

function seriesKey(parameter, level) {
  return String(parameter) + "-" + String(level)
}

// weather.json holds {"name": ..., "latitude": ..., "longitude": ...} and is
// owned by omarchy-weather-location. A missing or unparseable file means the
// weather stack falls back to IP detection; so do we.
function parseLocationFile(raw) {
  var unset = { name: "", latitude: null, longitude: null, country: "" }
  try {
    var data = JSON.parse(String(raw === undefined || raw === null ? "" : raw))
    if (!data || typeof data !== "object") return unset

    var latitude = parseFloat(data.latitude)
    var longitude = parseFloat(data.longitude)
    var hasCoordinates = isFinite(latitude) && isFinite(longitude)
    if (hasCoordinates && (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180))
      hasCoordinates = false

    var name = typeof data.name === "string" ? data.name.replace(/^\s+|\s+$/g, "") : ""
    return {
      name: name,
      latitude: hasCoordinates ? latitude : null,
      longitude: hasCoordinates ? longitude : null,
      country: ""
    }
  } catch (e) {
    return unset
  }
}

// Open-Meteo geocoding response -> suggestion rows for the location picker.
function parseGeocodingResults(raw) {
  try {
    var data = JSON.parse(String(raw === undefined || raw === null ? "" : raw))
    var results = data && data.results
    if (!results || !results.length) return []

    var out = []
    for (var i = 0; i < results.length; i++) {
      var result = results[i]
      if (!result || !result.name || result.latitude === undefined || result.longitude === undefined) continue
      var region = [result.admin1, result.country].filter(function(part) { return !!part }).join(", ")
      out.push({
        name: String(result.name),
        description: region,
        latitude: result.latitude,
        longitude: result.longitude,
        country: typeof result.country === "string" ? result.country : ""
      })
    }
    return out
  } catch (e) {
    return []
  }
}

// Free text plus the highlighted suggestion -> the location to commit. An
// empty name clears back to IP auto-detection; a name with no picked
// suggestion keeps coordinates null and has to be resolved by geocoding.
function locationCommit(text, suggestions, selectedIndex) {
  var name = String(text === undefined || text === null ? "" : text).replace(/^\s+|\s+$/g, "")
  if (name === "") return { name: "", latitude: null, longitude: null, country: "" }

  var choices = suggestions || []
  var index = Math.max(0, Math.min(parseInt(selectedIndex, 10) || 0, choices.length - 1))
  var suggestion = choices[index]
  if (suggestion) return {
    name: suggestion.name,
    latitude: suggestion.latitude,
    longitude: suggestion.longitude,
    country: ""
  }

  return { name: name, latitude: null, longitude: null, country: "" }
}

// ipwho.is response -> {name, latitude, longitude}; null when the service
// answered with an error or the fields are not usable.
function parseIpLocation(raw) {
  var data
  try {
    data = JSON.parse(String(raw === undefined || raw === null ? "" : raw))
  } catch (e) {
    return null
  }
  if (!data || typeof data !== "object" || data.success === false) return null

  var latitude = parseFloat(data.latitude)
  var longitude = parseFloat(data.longitude)
  if (!isFinite(latitude) || !isFinite(longitude)) return null
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null

  var name = ""
  if (typeof data.city === "string" && data.city) name = data.city
  else if (typeof data.region === "string" && data.region) name = data.region
  else if (typeof data.country === "string" && data.country) name = data.country

  var country = typeof data.country === "string" ? data.country : ""
  return { name: name, latitude: latitude, longitude: longitude, country: country }
}

function resolveUnit(setting) {
  var id = String(setting === undefined || setting === null ? "" : setting).replace(/^\s+|\s+$/g, "").toLowerCase()
  return speedUnitById(id) ? id : "kn"
}

function resolveLevel(setting) {
  var id = String(setting === undefined || setting === null ? "" : setting).replace(/^\s+|\s+$/g, "")
  return levelById(id) ? id : "surface"
}

function requestPayload(options) {
  var opts = options || {}
  var levels = opts.levels && opts.levels.length ? opts.levels.slice() : ["surface"]
  var parameters = opts.parameters && opts.parameters.length
    ? opts.parameters.slice() : requestParameters(opts.model)
  return {
    lat: Number(opts.latitude),
    lon: Number(opts.longitude),
    model: opts.model || FALLBACK_MODEL,
    parameters: parameters,
    levels: levels,
    key: typeof opts.key === "string" ? opts.key : ""
  }
}

function requestError(payload) {
  if (!payload || typeof payload !== "object") return "Missing request"
  if (!payload.key) return "Missing Windy API key"
  var lat = Number(payload.lat)
  var lon = Number(payload.lon)
  if (!isFinite(lat) || lat < -90 || lat > 90) return "Invalid latitude"
  if (!isFinite(lon) || lon < -180 || lon > 180) return "Invalid longitude"
  return null
}

// Shared curl invocation: quiet on success, verbose on failure, bounded in time
// and in bytes written to stdout.
function curlArguments(options) {
  var opts = options || {}
  var args = [CURL_PATH, "-sS"]
  args.push(opts.failWithBody ? "--fail-with-body" : "--fail")
  args.push("--max-time", String(opts.timeoutSeconds))
  args.push("--max-filesize", String(opts.maxBytes))
  return args
}

// The forecast request body carries the Windy API key, so it is written to
// curl's stdin ("--data-binary @-") rather than passed as an argument: process
// arguments are readable from /proc while the request runs and are logged when
// the process fails to start. Pair with Process { stdinEnabled: true }.
function forecastRequestCommand() {
  return curlArguments({
    timeoutSeconds: 10,
    maxBytes: MAX_FORECAST_BYTES,
    failWithBody: true
  }).concat(["-X", "POST",
    "-H", "Content-Type: application/json",
    "--data-binary", "@-",
    API_URL])
}

// The exact bytes written to the request's stdin.
function forecastRequestBody(payload) {
  if (!payload || typeof payload !== "object") return ""
  return JSON.stringify(payload)
}

function ipLocationCommand() {
  return curlArguments({ timeoutSeconds: 8, maxBytes: MAX_METADATA_BYTES }).concat([IP_LOCATION_URL])
}

function geocodeUrl(query, count) {
  return GEOCODING_URL + "?name=" + encodeURIComponent(String(query))
    + "&count=" + count + "&language=en&format=json"
}

function geocodeCommand(query, count, timeoutSeconds) {
  return curlArguments({
    timeoutSeconds: timeoutSeconds || 6,
    maxBytes: MAX_METADATA_BYTES
  }).concat([geocodeUrl(query, count)])
}

// ---- Credentials -----------------------------------------------------------
// secret-tool talks to the Secret Service over the session D-Bus, so a closed
// child environment still has to carry the bus address (or the runtime dir GLib
// falls back to). Everything else stays unset.
function keyringEnvironment(runtimeDir, busAddress) {
  var env = {}
  if (runtimeDir) env.XDG_RUNTIME_DIR = String(runtimeDir)
  if (busAddress) env.DBUS_SESSION_BUS_ADDRESS = String(busAddress)
  return env
}

function secretLookupCommand() {
  return [SECRET_TOOL_PATH, "lookup"].concat(SECRET_ATTRIBUTES)
}

// Pair with Process { stdinEnabled: true }: the secret is written to stdin,
// never passed as an argument.
function secretStoreCommand() {
  return [SECRET_TOOL_PATH, "store", "--label=" + SECRET_LABEL].concat(SECRET_ATTRIBUTES)
}

function secretClearCommand() {
  return [SECRET_TOOL_PATH, "clear"].concat(SECRET_ATTRIBUTES)
}

// Lookup output gains a trailing newline (secret-tool prints it to a pipe).
// Keys are single-line tokens, so surrounding whitespace is never meaningful.
function trimSecret(raw) {
  return String(raw === undefined || raw === null ? "" : raw).replace(/^\s+|\s+$/g, "")
}

// A pre-keyring install kept the key in shell.json. The widget migrates that
// value once and then strips it from the entry, so no plaintext credential
// survives in the config.
function legacyApiKey(settingValue) {
  return trimSecret(settingValue)
}

function entryWithoutApiKey(entry) {
  var out = {}
  if (entry && typeof entry === "object")
    for (var k in entry) if (k !== "apiKey") out[k] = entry[k]
  return out
}

function parseResponse(rawText) {
  var text = String(rawText === undefined || rawText === null ? "" : rawText).replace(/^\s+|\s+$/g, "")
  if (!text) return { ok: false, error: "Empty response (model may not cover this location)" }

  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: "Invalid JSON response" }
  }
  if (!data || typeof data !== "object") return { ok: false, error: "Unexpected response" }
  if (typeof data.error === "string" && data.error) return { ok: false, error: data.error }
  if (!Array.isArray(data.ts) || data.ts.length === 0)
    return { ok: false, error: "No forecast times in response" }

  return { ok: true, data: data }
}

function responseUnits(data, key) {
  var units = data && data.units ? data.units[key] : undefined
  return typeof units === "string" ? units : ""
}

function responseValue(data, key, index) {
  var series = data ? data[key] : undefined
  if (!Array.isArray(series) || index < 0 || index >= series.length) return null
  var value = series[index]
  if (value === undefined || value === null || value === "") return null
  var number = Number(value)
  return isFinite(number) ? number : null
}

function cloudCoverAt(data, index) {
  var cover = null
  var layers = ["lclouds-surface", "mclouds-surface", "hclouds-surface"]
  for (var i = 0; i < layers.length; i++) {
    var value = responseValue(data, layers[i], index)
    if (value === null) continue
    cover = cover === null ? value : Math.max(cover, value)
  }
  return cover
}

// Normalized series values for one step, before wind is converted into speed
// and direction. Null when either wind component is missing; individual fields
// stay null when the model has no value for them.
function rawPoint(data, level, index) {
  var uKey = seriesKey("wind_u", level)
  var vKey = seriesKey("wind_v", level)
  var u = normalizeSpeed(responseValue(data, uKey, index), responseUnits(data, uKey))
  var v = normalizeSpeed(responseValue(data, vKey, index), responseUnits(data, vKey))
  if (u === null || v === null) return null

  var tempKey = "temp-surface"
  var feelsKey = "feels-surface"
  var precipKey = "past3hprecip-surface"
  var pressureKey = "pressure-surface"

  // Providers that hand over a condition directly (Open-Meteo's WMO code)
  // publish it in a string series; everything else derives it from the values.
  var conditionSeries = data ? data["condition-surface"] : undefined
  var condition = Array.isArray(conditionSeries) && index >= 0 && index < conditionSeries.length
    && typeof conditionSeries[index] === "string" && conditionSeries[index] !== ""
    ? conditionSeries[index] : null

  return {
    ms: Number(data.ts[index]),
    u: u,
    v: v,
    gustMs: normalizeSpeed(responseValue(data, "gust-surface", index), responseUnits(data, "gust-surface")),
    tempC: normalizeTemperature(responseValue(data, tempKey, index), responseUnits(data, tempKey)),
    feelsC: normalizeTemperature(responseValue(data, feelsKey, index), responseUnits(data, feelsKey)),
    precipMm: normalizePrecip(responseValue(data, precipKey, index), responseUnits(data, precipKey)),
    pressureHpa: normalizePressure(responseValue(data, pressureKey, index), responseUnits(data, pressureKey)),
    rh: responseValue(data, "rh-surface", index),
    ptype: responseValue(data, "ptype-surface", index),
    warningCode: responseValue(data, "weatherwarnings-surface", index),
    cloudCover: cloudCoverAt(data, index),
    condition: condition
  }
}

function pointFromRaw(raw) {
  var wind = uvToSpeedDir(raw.u, raw.v)
  var feelsC = raw.feelsC === undefined || raw.feelsC === null
    ? apparentTemperatureC(raw.tempC, raw.rh, wind.speed) : raw.feelsC
  return {
    ms: raw.ms,
    speedMs: wind.speed,
    from: wind.from,
    toward: wind.toward,
    gustMs: raw.gustMs,
    tempC: raw.tempC,
    feelsC: feelsC,
    rh: raw.rh,
    precipMm: raw.precipMm,
    pressureHpa: raw.pressureHpa,
    cloudCover: raw.cloudCover,
    condition: raw.condition || deriveCondition(raw.tempC, raw.precipMm, raw.ptype, raw.cloudCover, raw.rh, raw.warningCode)
  }
}

function forecastPoint(data, level, index) {
  var raw = rawPoint(data, level, index)
  return raw ? pointFromRaw(raw) : null
}

function hourlyForecast(data, level, nowMs, maxHours, maxPoints) {
  if (!data || !Array.isArray(data.ts)) return []

  var now = isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  var windowMs = (isFinite(Number(maxHours)) ? Number(maxHours) : 24) * 3600000
  var pointLimit = isFinite(Number(maxPoints)) ? Number(maxPoints) : 48

  var out = []
  for (var i = 0; i < data.ts.length && out.length < pointLimit; i++) {
    var ms = Number(data.ts[i])
    if (!isFinite(ms) || ms < now) continue
    if (ms - now > windowMs) break

    var point = forecastPoint(data, level, i)
    if (point) out.push(point)
  }
  return out
}

// Linear blend of one numeric field; a missing side falls back to the other.
function blendValue(a, b, t) {
  if (a === null || a === undefined) return b === undefined ? null : b
  if (b === null || b === undefined) return a
  return a + (b - a) * t
}

// Precipitation, precipitation type, weather warnings, and provider-supplied
// conditions describe the nearest step rather than a mix of two, so they snap
// to one side.
function blendRaw(lower, upper, t) {
  var nearest = t < 0.5 ? lower : upper
  var other = nearest === lower ? upper : lower
  return {
    ms: lower.ms + (upper.ms - lower.ms) * t,
    u: blendValue(lower.u, upper.u, t),
    v: blendValue(lower.v, upper.v, t),
    gustMs: blendValue(lower.gustMs, upper.gustMs, t),
    tempC: blendValue(lower.tempC, upper.tempC, t),
    feelsC: blendValue(lower.feelsC, upper.feelsC, t),
    precipMm: nearest.precipMm,
    pressureHpa: blendValue(lower.pressureHpa, upper.pressureHpa, t),
    rh: blendValue(lower.rh, upper.rh, t),
    ptype: nearest.ptype,
    warningCode: nearest.warningCode,
    cloudCover: blendValue(lower.cloudCover, upper.cloudCover, t),
    condition: nearest.condition || other.condition
  }
}

// Nearest step with usable wind data; ties keep the earlier step, exactly like
// the pre-interpolation selection.
function nearestRaw(data, level, ms) {
  var best = null
  var bestDistance = Infinity
  for (var i = 0; i < data.ts.length; i++) {
    var stepMs = Number(data.ts[i])
    if (!isFinite(stepMs)) continue
    var distance = Math.abs(stepMs - ms)
    if (distance >= bestDistance) continue
    var raw = rawPoint(data, level, i)
    if (!raw) continue
    best = raw
    bestDistance = distance
  }
  return best
}

function rawOrNearest(data, level, index, ms) {
  var raw = rawPoint(data, level, index)
  if (raw) return raw
  return nearestRaw(data, level, ms)
}

// Forecast for an arbitrary time between steps. Wind and scalar fields blend
// across the bracketing steps so the bar does not jump to the next 3 h grid
// point; before the first step and after the last one the nearest step wins.
// When either bracketing step lacks wind data the old nearest-point selection
// is used instead, so a null step never blends across the gap.
function forecastAt(data, level, nowMs) {
  if (!data || !Array.isArray(data.ts) || data.ts.length === 0) return null

  var ms = isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()

  var lowerIndex = -1
  var upperIndex = -1
  for (var i = 0; i < data.ts.length; i++) {
    var stepMs = Number(data.ts[i])
    if (!isFinite(stepMs)) continue
    if (stepMs <= ms) {
      lowerIndex = i
      continue
    }
    upperIndex = i
    break
  }

  if (lowerIndex === -1) {
    var first = rawOrNearest(data, level, upperIndex, ms)
    return first ? pointFromRaw(first) : null
  }
  if (upperIndex === -1) {
    var last = rawOrNearest(data, level, lowerIndex, ms)
    return last ? pointFromRaw(last) : null
  }

  var lower = rawPoint(data, level, lowerIndex)
  var upper = rawPoint(data, level, upperIndex)
  if (!lower || !upper) {
    var nearest = nearestRaw(data, level, ms)
    return nearest ? pointFromRaw(nearest) : null
  }

  var span = upper.ms - lower.ms
  var t = span > 0 ? (ms - lower.ms) / span : 0
  return pointFromRaw(blendRaw(lower, upper, t))
}

function currentForecast(data, level, nowMs) {
  return forecastAt(data, level, nowMs)
}

// Aggregate hourly points into local calendar days starting today. tzOffset
// is Date.prototype.getTimezoneOffset() (minutes west of UTC); pass it from
// the UI so grouping follows the user's clock.
function dailyForecast(data, level, nowMs, days, tzOffsetMinutes) {
  if (!data || !Array.isArray(data.ts)) return []

  var now = isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  var tzOffset = isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : 0
  var dayCount = isFinite(Number(days)) ? Number(days) : 4
  var todayKey = Math.floor((now - tzOffset * 60000) / 86400000)

  var dayKeys = []
  var groups = []
  for (var i = 0; i < data.ts.length; i++) {
    var ms = Number(data.ts[i])
    if (!isFinite(ms)) continue
    var dayKey = Math.floor((ms - tzOffset * 60000) / 86400000)
    if (dayKey < todayKey) continue
    if (dayKey >= todayKey + dayCount) break

    var point = forecastPoint(data, level, i)
    if (!point) continue

    var position = dayKeys.indexOf(dayKey)
    if (position === -1) {
      dayKeys.push(dayKey)
      groups.push([])
      position = groups.length - 1
    }
    groups[position].push(point)
  }

  var out = []
  for (var d = 0; d < groups.length; d++) {
    var points = groups[d]
    if (!points.length) continue

    var minTemp = null
    var maxTemp = null
    var precip = 0
    var condition = "clear"
    for (var p = 0; p < points.length; p++) {
      var point = points[p]
      if (point.tempC !== null) {
        minTemp = minTemp === null ? point.tempC : Math.min(minTemp, point.tempC)
        maxTemp = maxTemp === null ? point.tempC : Math.max(maxTemp, point.tempC)
      }
      if (point.precipMm !== null) precip += point.precipMm
      if (conditionSeverity(point.condition) > conditionSeverity(condition)) condition = point.condition
    }

    out.push({
      dateMs: dayKeys[d] * 86400000 + tzOffset * 60000,
      minTempC: minTemp,
      maxTempC: maxTemp,
      precipMm: precip,
      condition: condition
    })
  }
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    API_URL: API_URL,
    IP_LOCATION_URL: IP_LOCATION_URL,
    GEOCODING_URL: GEOCODING_URL,
    CURL_PATH: CURL_PATH,
    SECRET_TOOL_PATH: SECRET_TOOL_PATH,
    SECRET_LABEL: SECRET_LABEL,
    SECRET_ATTRIBUTES: SECRET_ATTRIBUTES,
    MAX_FORECAST_BYTES: MAX_FORECAST_BYTES,
    MAX_METADATA_BYTES: MAX_METADATA_BYTES,
    FALLBACK_MODEL: FALLBACK_MODEL,
    MODELS: MODELS,
    LEVELS: LEVELS,
    SPEED_UNITS: SPEED_UNITS,
    modelById: modelById,
    levelById: levelById,
    speedUnitById: speedUnitById,
    modelLabel: modelLabel,
    levelLabel: levelLabel,
    unitLabel: unitLabel,
    autoModel: autoModel,
    resolveModel: resolveModel,
    resolveProvider: resolveProvider,
    normalizeSpeedUnit: normalizeSpeedUnit,
    normalizeSpeed: normalizeSpeed,
    speedUnitFactor: speedUnitFactor,
    speedToUnit: speedToUnit,
    formatSpeed: formatSpeed,
    normalizeTemperature: normalizeTemperature,
    normalizePrecip: normalizePrecip,
    normalizePressure: normalizePressure,
    localeUsesImperial: localeUsesImperial,
    countryUsesImperial: countryUsesImperial,
    resolveTemperatureUnit: resolveTemperatureUnit,
    temperatureValue: temperatureValue,
    formatTemperature: formatTemperature,
    apparentTemperatureC: apparentTemperatureC,
    precipUnitFor: precipUnitFor,
    precipValue: precipValue,
    formatPrecip: formatPrecip,
    conditionIcon: conditionIcon,
    conditionLabel: conditionLabel,
    weatherWarningCondition: weatherWarningCondition,
    deriveCondition: deriveCondition,
    conditionSeverity: conditionSeverity,
    requestParameters: requestParameters,
    requestLevels: requestLevels,
    uvToSpeedDir: uvToSpeedDir,
    compass: compass,
    seriesKey: seriesKey,
    parseLocationFile: parseLocationFile,
    parseGeocodingResults: parseGeocodingResults,
    locationCommit: locationCommit,
    parseIpLocation: parseIpLocation,
    resolveUnit: resolveUnit,
    resolveLevel: resolveLevel,
    requestPayload: requestPayload,
    requestError: requestError,
    curlArguments: curlArguments,
    forecastRequestCommand: forecastRequestCommand,
    forecastRequestBody: forecastRequestBody,
    ipLocationCommand: ipLocationCommand,
    geocodeUrl: geocodeUrl,
    geocodeCommand: geocodeCommand,
    keyringEnvironment: keyringEnvironment,
    secretLookupCommand: secretLookupCommand,
    secretStoreCommand: secretStoreCommand,
    secretClearCommand: secretClearCommand,
    trimSecret: trimSecret,
    legacyApiKey: legacyApiKey,
    entryWithoutApiKey: entryWithoutApiKey,
    parseResponse: parseResponse,
    responseValue: responseValue,
    forecastPoint: forecastPoint,
    forecastAt: forecastAt,
    hourlyForecast: hourlyForecast,
    currentForecast: currentForecast,
    dailyForecast: dailyForecast
  }
}
