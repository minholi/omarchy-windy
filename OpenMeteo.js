// Open-Meteo provider for the Windy bar widget. The free tier needs no API
// key and is intended for non-commercial use, which is why this is the default
// provider. Keep this file free of QML globals so the URL contract, the unit
// conversions, and the response parsing can also be exercised by Node in CI
// (see openmeteo.test.mjs).

var API_URL = "https://api.open-meteo.com/v1/forecast"

// Fixed, trusted executable. Requests never resolve curl through PATH, so an
// entry in the widget's environment cannot substitute another binary.
var CURL_PATH = "/usr/bin/curl"

// Producer-side ceiling, same idea as Model.js: curl gives up (exit 63)
// instead of letting a hostile or malformed response grow shell memory.
var MAX_FORECAST_BYTES = 262144
var TIMEOUT_SECONDS = 10

// GMT keeps the hourly timestamps free of offset ambiguity; they are parsed as
// UTC. past_days feeds the trailing rain accumulation, and the 10-day horizon
// matches the Windy provider's forecast length.
var TIMEZONE = "GMT"
var PAST_DAYS = 1
var FORECAST_DAYS = 10

// Requested wind levels. "surface" is the 10 m wind; the pressure levels use
// Open-Meteo's "<level>hPa" variable suffix. The parser emits whichever of
// these the response actually contains, using Model.js series keys.
var LEVEL_VARIABLES = {
  surface: { speed: "wind_speed_10m", direction: "wind_direction_10m" },
  "850h": { speed: "wind_speed_850hPa", direction: "wind_direction_850hPa" },
  "700h": { speed: "wind_speed_700hPa", direction: "wind_direction_700hPa" },
  "500h": { speed: "wind_speed_500hPa", direction: "wind_direction_500hPa" },
  "300h": { speed: "wind_speed_300hPa", direction: "wind_direction_300hPa" }
}

// Windy model setting -> Open-Meteo model. "auto" resolves to best_match,
// which picks the highest-resolution model per coordinate; the Windy NAM
// models have no close equivalent and fall back to best_match too.
var MODEL_MAP = {
  gfs: "gfs_seamless",
  icon: "icon_seamless",
  iconEu: "icon_eu",
  iconD2: "icon_d2",
  aromeFrance: "meteofrance_arome_france_hd",
  hrrrConus: "gfs_hrrr",
  canHrdps: "gem_hrdps_continental"
}

var MODEL_LABELS = {
  best_match: "Best match",
  gfs_seamless: "GFS seamless",
  icon_seamless: "ICON seamless",
  icon_eu: "ICON-EU",
  icon_d2: "ICON-D2",
  meteofrance_arome_france_hd: "AROME France HD",
  gfs_hrrr: "HRRR (CONUS)",
  gem_hrdps_continental: "HRDPS Canada"
}

// The internal forecast keys live in Model.js; Open-Meteo fills them with the
// same normalized units Windy uses (m/s, °C, mm, hPa, %) so the display layer
// stays provider-agnostic.
var INTERNAL_UNITS = {
  "wind_u-surface": "m*s-1",
  "wind_v-surface": "m*s-1",
  "gust-surface": "m*s-1",
  "temp-surface": "C",
  "feels-surface": "C",
  "rh-surface": "%",
  "past3hprecip-surface": "mm",
  "pressure-surface": "hPa",
  "lclouds-surface": "%",
  "mclouds-surface": "%",
  "hclouds-surface": "%"
}

function findLevel(id) {
  var wanted = String(id === undefined || id === null ? "" : id).replace(/^\s+|\s+$/g, "")
  return LEVEL_VARIABLES[wanted] ? wanted : "surface"
}

// "auto", blank, and Windy-only models fall back to best_match.
function resolveModel(setting) {
  var id = String(setting === undefined || setting === null ? "" : setting).replace(/^\s+|\s+$/g, "")
  if (id === "" || id === "auto") return "best_match"
  return MODEL_MAP[id] || "best_match"
}

function modelLabel(id) {
  return MODEL_LABELS[String(id === undefined || id === null ? "" : id)] || "Best match"
}

function hourlyVariables(level) {
  var selected = findLevel(level)
  var variables = [
    "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
    "temperature_2m", "apparent_temperature", "relative_humidity_2m", "precipitation",
    "surface_pressure", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
    "weather_code"
  ]
  if (selected !== "surface") {
    variables.push(LEVEL_VARIABLES[selected].speed, LEVEL_VARIABLES[selected].direction)
  }
  return variables
}

function forecastUrl(options) {
  var opts = options || {}
  var params = [
    "latitude=" + Number(opts.latitude),
    "longitude=" + Number(opts.longitude),
    "hourly=" + hourlyVariables(opts.level).join(","),
    "wind_speed_unit=ms",
    "temperature_unit=celsius",
    "timezone=" + TIMEZONE,
    "past_days=" + PAST_DAYS,
    "forecast_days=" + FORECAST_DAYS,
    "cell_selection=nearest",
    "models=" + encodeURIComponent(resolveModel(opts.model))
  ]
  return API_URL + "?" + params.join("&")
}

// Shared curl invocation: quiet on success, body on failure, bounded in time
// and in bytes written to stdout. Open-Meteo requests carry no secret, so the
// URL is a plain argument.
function forecastCommand(options) {
  var opts = options || {}
  return [CURL_PATH, "-sS", "--fail-with-body",
    "--max-time", String(opts.timeoutSeconds || TIMEOUT_SECONDS),
    "--max-filesize", String(MAX_FORECAST_BYTES),
    forecastUrl(opts)]
}

// Meteorological direction is where the wind blows FROM; u/v components
// describe where it blows TOWARD (east/north positive), matching Windy.
function directionToUv(speed, direction) {
  if (speed === undefined || speed === null || speed === "" ||
      direction === undefined || direction === null || direction === "")
    return null
  var s = Number(speed)
  var dir = Number(direction)
  if (!isFinite(s) || !isFinite(dir)) return null
  var radians = dir * Math.PI / 180
  return { u: -s * Math.sin(radians), v: -s * Math.cos(radians) }
}

function hourlyValue(hourly, key, index) {
  var series = hourly ? hourly[key] : undefined
  if (!Array.isArray(series) || index < 0 || index >= series.length) return null
  var value = series[index]
  if (value === undefined || value === null || value === "") return null
  var number = Number(value)
  return isFinite(number) ? number : null
}

// WMO 4677 weather codes as returned by Open-Meteo. Preferring the code over a
// cloud-cover guess mirrors how weatherWarningCondition treats Windy models
// that expose a warning code.
function weatherCodeCondition(code) {
  var c = Number(code)
  if (!isFinite(c)) return ""
  if (c === 0 || c === 1) return "clear"
  if (c === 2) return "partly"
  if (c === 3) return "cloudy"
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

// Open-Meteo answers "2026-09-17T18:00" in the requested timezone; GMT means
// the explicit Z is the whole conversion.
function parseTime(raw) {
  var ms = Date.parse(String(raw) + "Z")
  return isFinite(ms) ? ms : null
}

// Open-Meteo response -> the internal forecast shape Model.js consumes. Every
// requested series is present for the whole horizon, so indices align.
function shapeForecast(hourly) {
  var count = hourly.time.length
  var forecast = {
    ts: [],
    units: {},
    precipWindowHours: 1
  }
  var levels = Object.keys(LEVEL_VARIABLES)
  var i
  var level
  var series
  for (i = 0; i < levels.length; i++) {
    level = levels[i]
    series = LEVEL_VARIABLES[level]
    if (!Array.isArray(hourly[series.speed]) || !Array.isArray(hourly[series.direction])) continue
    forecast["wind_u-" + level] = []
    forecast["wind_v-" + level] = []
    forecast.units["wind_u-" + level] = INTERNAL_UNITS["wind_u-surface"]
    forecast.units["wind_v-" + level] = INTERNAL_UNITS["wind_v-surface"]
  }
  if (forecast["wind_u-surface"] === undefined) return null

  var gust = []
  var temp = []
  var feels = []
  var rh = []
  var precip = []
  var pressure = []
  var lclouds = []
  var mclouds = []
  var hclouds = []
  var condition = []

  for (i = 0; i < count; i++) {
    var ms = parseTime(hourly.time[i])
    if (ms === null) continue
    forecast.ts.push(ms)

    for (var l = 0; l < levels.length; l++) {
      level = levels[l]
      if (forecast["wind_u-" + level] === undefined) continue
      series = LEVEL_VARIABLES[level]
      var wind = directionToUv(hourlyValue(hourly, series.speed, i), hourlyValue(hourly, series.direction, i))
      forecast["wind_u-" + level].push(wind ? wind.u : null)
      forecast["wind_v-" + level].push(wind ? wind.v : null)
    }

    gust.push(hourlyValue(hourly, "wind_gusts_10m", i))
    temp.push(hourlyValue(hourly, "temperature_2m", i))
    feels.push(hourlyValue(hourly, "apparent_temperature", i))
    rh.push(hourlyValue(hourly, "relative_humidity_2m", i))
    precip.push(hourlyValue(hourly, "precipitation", i))
    pressure.push(hourlyValue(hourly, "surface_pressure", i))
    lclouds.push(hourlyValue(hourly, "cloud_cover_low", i))
    mclouds.push(hourlyValue(hourly, "cloud_cover_mid", i))
    hclouds.push(hourlyValue(hourly, "cloud_cover_high", i))
    condition.push(weatherCodeCondition(hourlyValue(hourly, "weather_code", i)))
  }
  if (forecast.ts.length === 0) return null

  forecast.units["gust-surface"] = INTERNAL_UNITS["gust-surface"]
  forecast.units["temp-surface"] = INTERNAL_UNITS["temp-surface"]
  forecast.units["feels-surface"] = INTERNAL_UNITS["feels-surface"]
  forecast.units["rh-surface"] = INTERNAL_UNITS["rh-surface"]
  forecast.units["past3hprecip-surface"] = INTERNAL_UNITS["past3hprecip-surface"]
  forecast.units["pressure-surface"] = INTERNAL_UNITS["pressure-surface"]
  forecast.units["lclouds-surface"] = INTERNAL_UNITS["lclouds-surface"]
  forecast.units["mclouds-surface"] = INTERNAL_UNITS["mclouds-surface"]
  forecast.units["hclouds-surface"] = INTERNAL_UNITS["hclouds-surface"]
  forecast["gust-surface"] = gust
  forecast["temp-surface"] = temp
  forecast["feels-surface"] = feels
  forecast["rh-surface"] = rh
  forecast["past3hprecip-surface"] = precip
  forecast["pressure-surface"] = pressure
  forecast["lclouds-surface"] = lclouds
  forecast["mclouds-surface"] = mclouds
  forecast["hclouds-surface"] = hclouds
  forecast["condition-surface"] = condition
  return forecast
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
  if (data.error) {
    var reason = typeof data.reason === "string" ? data.reason.replace(/^\s+|\s+$/g, "") : ""
    return { ok: false, error: reason || "Open-Meteo request failed" }
  }

  var hourly = data.hourly
  if (!hourly || !Array.isArray(hourly.time) || hourly.time.length === 0)
    return { ok: false, error: "No forecast times in response" }

  var forecast = shapeForecast(hourly)
  if (!forecast) return { ok: false, error: "No forecast values in response" }
  return { ok: true, data: forecast }
}

if (typeof module !== "undefined") {
  module.exports = {
    API_URL: API_URL,
    CURL_PATH: CURL_PATH,
    MAX_FORECAST_BYTES: MAX_FORECAST_BYTES,
    TIMEZONE: TIMEZONE,
    PAST_DAYS: PAST_DAYS,
    FORECAST_DAYS: FORECAST_DAYS,
    LEVEL_VARIABLES: LEVEL_VARIABLES,
    MODEL_MAP: MODEL_MAP,
    INTERNAL_UNITS: INTERNAL_UNITS,
    findLevel: findLevel,
    resolveModel: resolveModel,
    modelLabel: modelLabel,
    hourlyVariables: hourlyVariables,
    forecastUrl: forecastUrl,
    forecastCommand: forecastCommand,
    directionToUv: directionToUv,
    weatherCodeCondition: weatherCodeCondition,
    parseTime: parseTime,
    shapeForecast: shapeForecast,
    parseResponse: parseResponse
  }
}
