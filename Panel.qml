import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "OpenMeteo.js" as OpenMeteo

Panel {
  id: root
  moduleName: "minholi.windy"
  ipcTarget: "minholi.windy"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property bool openedFromHotkey: false

  readonly property var barIdentity: hostWidget || root

  // ---- Settings -------------------------------------------------------------
  // The API key lives in the login keyring (Secret Service). shell.json only
  // ever holds a legacy plaintext value, which is migrated into the keyring and
  // stripped on the first load after this version, so no credential stays in a
  // broadly readable config file.
  property string keyringKey: ""
  property string keyringError: ""
  property string keyringStoreBody: ""
  property string keyringPendingValue: ""
  property bool keyringStoreIsMigration: false
  property bool keyringStoreStarted: false
  property bool keyringClearStarted: false
  property bool migrationAttempted: false

  readonly property string legacyKey: Model.legacyApiKey(setting("apiKey", ""))
  readonly property string apiKey: {
    // A legacy shell.json value wins once, so a CLI-written key keeps working
    // until the widget has migrated and stripped it.
    if (legacyKey !== "") return legacyKey
    if (keyringKey !== "") return keyringKey
    return String(Quickshell.env("WINDY_API_KEY") || "")
  }
  readonly property string providerSetting: setting("provider", "openmeteo")
  readonly property string provider: Model.resolveProvider(providerSetting, apiKey !== "")
  readonly property string unit: Model.resolveUnit(setting("unit", "kn"))
  readonly property string temperatureUnit: Model.resolveTemperatureUnit(setting("temperatureUnit", "auto"),
    Qt.locale().name, location && location.country ? location.country : root.countryHint)
  readonly property string temperatureUnitLabel: temperatureUnit === "f" ? "F" : "C"
  readonly property string temperatureMetric: String(setting("temperatureMetric", "air")) === "feels" ? "feels" : "air"
  readonly property string precipUnit: Model.precipUnitFor(temperatureUnit)
  readonly property string level: Model.resolveLevel(setting("level", "surface"))
  readonly property string modelSetting: setting("model", "auto")
  readonly property int refreshMinutes: Math.max(5, parseInt(setting("refreshMinutes", 15), 10) || 15)

  // ---- Location -------------------------------------------------------------
  property var location: null
  property string countryHint: ""
  property bool userLocation: false
  property bool detectingLocation: false
  property bool locationFailed: false
  property int ipRetries: 0

  // Click-to-edit location state.
  property bool editingLocation: false
  property bool savingLocation: false
  property bool savingHasCoordinates: false
  property string locationError: ""
  property string pendingLocationName: ""
  property var locationSuggestions: []
  property int suggestionIndex: 0
  property string geocodePendingQuery: ""
  property string geocodeActiveQuery: ""

  // Settings section state.
  property bool settingsMode: false
  property bool apiKeySaved: false

  property FileView locationFile: FileView {
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.applyStoredLocation(text())
    onLoadFailed: root.applyStoredLocation("")
  }

  // The first read can race shell startup; a single delayed reload recovers
  // without disturbing an already-loaded file (same workaround as the stock
  // weather panel).
  Timer {
    interval: 1500
    running: true
    onTriggered: locationFile.reload()
  }

  function applyStoredLocation(raw) {
    var parsed = Model.parseLocationFile(raw)
    if (parsed.latitude !== null && parsed.longitude !== null) {
      // FileView.reload() fires on every panel open and file watch event;
      // only a real change may reset the forecast and trigger a refetch.
      var unchanged = root.location
        && root.location.latitude === parsed.latitude
        && root.location.longitude === parsed.longitude
        && root.location.name === parsed.name
      if (unchanged) {
        if (root.savingLocation) root.finishSavingLocation()
        return
      }
      root.locationFailed = false
      root.detectingLocation = false
      root.userLocation = true
      root.countryHint = ""
      root.location = parsed
      if (!parsed.country && parsed.name !== "") root.requestCountry(parsed.name)
      if (root.savingLocation) root.finishSavingLocation()
      return
    }

    // Hand-written name-only entries ({"name": "Malibu"}) are documented as
    // valid; resolve them to coordinates once and persist the upgrade.
    if (parsed.name !== "") {
      root.locationFailed = false
      root.userLocation = true
      root.resolveLocationName(parsed.name)
      return
    }

    root.userLocation = false
    if (root.location) root.location = null
    if (!root.detectingLocation && !ipLocationProc.running) root.requestIpLocation()
  }

  function requestIpLocation() {
    if (ipLocationProc.running) return
    if (root.detectingLocation) return
    root.detectingLocation = true
    root.locationFailed = false
    ipLocationProc.running = true
  }

  Process {
    id: ipLocationProc
    command: Model.ipLocationCommand()
    clearEnvironment: true
    environment: ({})
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parsed = Model.parseIpLocation(text)
        root.detectingLocation = false
        // A configured location may have landed while this request was in
        // flight; it always wins over IP auto-detection.
        if (parsed && !root.userLocation) {
          root.location = parsed
          root.locationFailed = false
          root.ipRetries = 0
        } else if (parsed) {
          root.ipRetries = 0
        } else {
          root.locationFailed = true
          root.scheduleIpRetry()
        }
      }
    }
    onExited: function(exitCode) {
      if (exitCode === 0) return
      root.detectingLocation = false
      root.locationFailed = true
      root.scheduleIpRetry()
    }
  }

  function scheduleIpRetry() {
    if (root.ipRetries >= 2) return
    root.ipRetries++
    ipRetryTimer.restart()
  }

  Timer {
    id: ipRetryTimer
    interval: 3000
    onTriggered: root.requestIpLocation()
  }

  // ---- Location editing -----------------------------------------------------
  function startEditingLocation() {
    editingLocation = true
    savingLocation = false
    savingHasCoordinates = false
    locationError = ""
    locationSuggestions = []
    suggestionIndex = 0
    Qt.callLater(function() {
      locationField.text = root.location && root.location.name ? root.location.name : ""
      locationField.selectAll()
      locationField.forceActiveFocus()
    })
  }

  function cancelEditingLocation() {
    editingLocation = false
    savingLocation = false
    savingHasCoordinates = false
    locationSuggestions = []
    geocodeDebounce.stop()
    Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
  }

  function commitLocation() {
    var location = Model.locationCommit(locationField.text, locationSuggestions, suggestionIndex)
    if (location.name === "") {
      clearLocation()
      return
    }
    locationError = ""
    savingLocation = true
    savingHasCoordinates = location.latitude !== null
    root.userLocation = true
    pendingLocationName = location.name
    if (location.latitude !== null && location.longitude !== null) {
      root.locationFailed = false
      root.location = location
    }
    persistLocation(location.name, location.latitude, location.longitude)
  }

  function clearLocation() {
    root.location = null
    root.userLocation = false
    root.countryHint = ""
    locationError = ""
    savingLocation = false
    savingHasCoordinates = false
    cancelEditingLocation()
    persistLocation("", null, null)
  }

  function pickSuggestion(suggestion) {
    if (!suggestion) return
    locationError = ""
    savingLocation = true
    savingHasCoordinates = true
    root.locationFailed = false
    root.userLocation = true
    root.countryHint = suggestion.country || ""
    root.location = {
      name: suggestion.name,
      latitude: suggestion.latitude,
      longitude: suggestion.longitude,
      country: suggestion.country || ""
    }
    persistLocation(suggestion.name, suggestion.latitude, suggestion.longitude)
  }

  function finishSavingLocation() {
    if (!root.savingLocation) return
    savingLocation = false
    savingHasCoordinates = false
    cancelEditingLocation()
  }

  function persistLocation(name, latitude, longitude) {
    if (name && latitude !== null && longitude !== null)
      locationSaveProc.command = ["omarchy-weather-location", "--set", name, latitude + "," + longitude]
    else if (name)
      locationSaveProc.command = ["omarchy-weather-location", "--set", name]
    else
      locationSaveProc.command = ["omarchy-weather-location", "--clear"]
    locationSaveProc.running = true
  }

  function requestGeocode() {
    var query = locationField.text.trim()
    if (query.length < 2) {
      locationSuggestions = []
      return
    }
    geocodePendingQuery = query
    if (!geocodeProc.running) startGeocode()
  }

  function startGeocode() {
    geocodeActiveQuery = geocodePendingQuery
    geocodeProc.command = Model.geocodeCommand(geocodeActiveQuery, 5, 5)
    geocodeProc.running = true
  }

  function resolveLocationName(name) {
    if (resolveProc.running) return
    pendingLocationName = name
    resolveProc.command = Model.geocodeCommand(name, 1)
    resolveProc.running = true
  }

  // weather.json carries no country, so a configured location would otherwise
  // fall back to the locale for the temperature unit. Resolve it once.
  function requestCountry(name) {
    if (countryProc.running || root.countryHint !== "" || !name) return
    countryProc.command = Model.geocodeCommand(name, 1)
    countryProc.running = true
  }

  Process {
    id: geocodeProc
    clearEnvironment: true
    environment: ({})
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.locationSuggestions = root.editingLocation ? Model.parseGeocodingResults(text) : []
        root.suggestionIndex = 0
        if (root.geocodePendingQuery !== root.geocodeActiveQuery) Qt.callLater(root.startGeocode)
      }
    }
  }

  Timer {
    id: geocodeDebounce
    interval: 300
    onTriggered: root.requestGeocode()
  }

  Process {
    id: countryProc
    clearEnvironment: true
    environment: ({})
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var results = Model.parseGeocodingResults(text)
        if (results.length && results[0].country) root.countryHint = results[0].country
      }
    }
  }

  Process {
    id: resolveProc
    clearEnvironment: true
    environment: ({})
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var results = Model.parseGeocodingResults(text)
        if (!results.length) {
          root.locationFailed = true
          root.locationError = root.pendingLocationName !== ""
            ? "No location found for \"" + root.pendingLocationName + "\"" : ""
          if (root.savingLocation) root.finishSavingLocation()
          return
        }
        var first = results[0]
        root.userLocation = true
        root.countryHint = first.country || ""
        root.location = {
          name: first.name,
          latitude: first.latitude,
          longitude: first.longitude,
          country: first.country || ""
        }
        // Upgrade a name-only entry in place; the weather panel reads the
        // same file and benefits from the exact coordinates.
        root.persistLocation(first.name, first.latitude, first.longitude)
        if (root.savingLocation) root.finishSavingLocation()
      }
    }
  }

  Process {
    id: locationSaveProc
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.savingLocation = false
        root.savingHasCoordinates = false
        root.locationError = "Couldn't save the location."
        return
      }
      if (root.savingLocation && root.savingHasCoordinates) root.finishSavingLocation()
    }
  }

  // ---- Forecast -------------------------------------------------------------
  property var forecast: null
  property bool loading: false
  property string errorText: ""
  property int retries: 0
  property double lastUpdatedMs: 0

  // The JSON body (which carries the API key) is piped into curl's stdin, never
  // passed as an argument. It is cleared once written, which closes stdin.
  property string requestBody: ""
  property bool forecastStarted: false

  readonly property string providerName: provider === "windy" ? "Windy" : "Open-Meteo"
  // Regional Open-Meteo models reject coordinates outside their domain; after
  // the first such failure the request falls back to best_match until the
  // model setting or the location changes.
  property bool openMeteoFallback: false
  readonly property string modelId: provider === "windy"
    ? Model.resolveModel(modelSetting, location ? location.latitude : NaN, location ? location.longitude : NaN)
    : (openMeteoFallback ? "best_match" : OpenMeteo.resolveModel(modelSetting))
  readonly property var current: forecast ? Model.currentForecast(forecast, level, Date.now()) : null
  readonly property var hourly: forecast ? Model.hourlyForecast(forecast, level, Date.now(), 24, 8) : []
  readonly property var daily: forecast
    ? Model.dailyForecast(forecast, level, Date.now(), 4, new Date().getTimezoneOffset()) : []
  readonly property bool night: {
    var hour = new Date().getHours()
    return hour < 6 || hour >= 19
  }

  readonly property real arrowRotation: current ? current.toward : 0
  readonly property string speedLabel: current ? Model.formatSpeed(current.speedMs, unit) : ""
  readonly property string directionLabel: current
    ? Model.compass(current.from) + " " + Math.round(current.from) + "°" : ""
  readonly property string gustLabel: current && current.gustMs !== null
    ? Model.formatSpeed(current.gustMs, unit) + " " + Model.unitLabel(unit) : ""
  readonly property string rainLabel: current && current.precipMm !== null
    ? Model.formatPrecip(current.precipMm, precipUnit) : ""
  readonly property string humidityLabel: current && current.rh !== null
    ? Math.round(current.rh) + "%" : ""
  readonly property string temperatureText: current
    ? Model.formatTemperature(current.tempC, temperatureUnit, false) : ""
  readonly property string feelsLikeText: current && current.feelsC !== null
    ? Model.formatTemperature(current.feelsC, temperatureUnit, false) : ""
  readonly property string feelsLikeLabel: current && current.feelsC !== null
    ? Model.formatTemperature(current.feelsC, temperatureUnit, true) : ""
  readonly property string heroTemperatureText: temperatureMetric === "feels" && feelsLikeText !== ""
    ? feelsLikeText : temperatureText
  readonly property string heroCaptionText: temperatureMetric === "feels" && feelsLikeText !== ""
    && current && current.tempC !== null
    ? "AIR " + Model.formatTemperature(current.tempC, temperatureUnit, true) : ""
  readonly property string conditionGlyph: current
    ? Model.conditionIcon(current.condition, night) : ""
  readonly property string activeModel: provider === "windy"
    ? Model.modelLabel(modelId) : OpenMeteo.modelLabel(modelId)
  // Windy reports the preceding 3 hours; Open-Meteo the preceding hour.
  readonly property int precipWindowHours: forecast && forecast.precipWindowHours === 1 ? 1 : 3

  // A Windy testing key answers with "The testing API version is for
  // development purposes only. This data is randomly shuffled and slightly
  // modified." — surface it so shuffled values are not read as a widget bug.
  readonly property string apiWarning: forecast && typeof forecast.warning === "string"
    ? forecast.warning.replace(/^\s+|\s+$/g, "") : ""

  readonly property string tooltipText: {
    if (!current) {
      if (provider === "windy" && apiKey === "") return "Windy — no API key set"
      return providerName + " — waiting for forecast"
    }
    var text = speedLabel + " " + Model.unitLabel(unit)
    if (current.tempC !== null) text += " · " + Model.formatTemperature(current.tempC, temperatureUnit, true)
    if (current.feelsC !== null) text += " · feels " + Model.formatTemperature(current.feelsC, temperatureUnit, true)
    if (current.gustMs !== null) text += " · gust " + Model.formatSpeed(current.gustMs, unit) + " " + Model.unitLabel(unit)
    if (current.precipMm !== null && current.precipMm >= 0.05)
      text += " · rain " + Model.formatPrecip(current.precipMm, precipUnit)
    text += " · " + directionLabel
    if (location && location.name) text += " · " + location.name
    if (apiWarning !== "") text += " · testing key (shuffled data)"
    return text
  }

  readonly property string statusText: {
    if (provider === "windy" && apiKey === "") return "Set your Windy API key from the gear in this panel"
    if (locationError !== "") return locationError
    if (detectingLocation) return "Detecting location…"
    if (!location && locationFailed) return "Couldn't detect a location. Set one with: omarchy-weather-location --set City 48.2,16.4"
    if (errorText !== "") return errorText
    if (!current && loading) return "Fetching forecast…"
    if (!current) return "Waiting for forecast…"
    return ""
  }

  // Builds the provider-specific request. Returns false when the settings do
  // not describe a usable request; [errorText] then carries the reason.
  function buildForecastRequest() {
    if (!location) return false
    if (provider === "windy") {
      var model = Model.resolveModel(modelSetting, location.latitude, location.longitude)
      var payload = Model.requestPayload({
        latitude: location.latitude,
        longitude: location.longitude,
        model: model,
        levels: Model.requestLevels(level),
        parameters: Model.requestParameters(model),
        key: apiKey
      })
      var problem = Model.requestError(payload)
      if (problem) {
        errorText = problem
        return false
      }
      requestBody = Model.forecastRequestBody(payload)
      forecastProc.command = Model.forecastRequestCommand()
      return true
    }

    // Open-Meteo needs no key and carries no request body.
    requestBody = ""
    forecastProc.command = OpenMeteo.forecastCommand({
      latitude: location.latitude,
      longitude: location.longitude,
      level: level,
      model: openMeteoFallback ? "best_match" : OpenMeteo.resolveModel(modelSetting)
    })
    return true
  }

  function refresh(force) {
    if (provider === "windy" && apiKey === "") return
    if (!location) {
      if (!detectingLocation && !locationFailed) requestIpLocation()
      return
    }
    if (!force && forecast && Date.now() - lastUpdatedMs < 120000) return
    if (forecastProc.running) return
    if (!buildForecastRequest()) return
    loading = true
    retries = 0
    forecastProc.running = true
  }

  // A retry rebuilds the request, so the API key never has to be kept around
  // in memory after the body was piped to curl's stdin.
  function startForecastRequest() {
    if (forecastProc.running) return
    if (!buildForecastRequest()) return
    forecastProc.running = true
  }

  function scheduleRetry() {
    if (retries >= 3) return
    retries++
    retryTimer.restart()
  }

  Timer {
    id: retryTimer
    interval: 2500
    onTriggered: {
      if (forecastProc.running) return
      root.loading = true
      root.startForecastRequest()
    }
  }

  Process {
    id: forecastProc
    // No command argument ever holds the API key, and the child runs with a
    // closed environment so no inherited variable reaches curl.
    stdinEnabled: root.requestBody !== ""
    clearEnvironment: true
    environment: ({})
    onStarted: {
      root.forecastStarted = true
      if (root.requestBody === "") return
      write(root.requestBody)
      // Clearing the body flips stdinEnabled, which closes the pipe so curl
      // sees EOF and sends the request.
      root.requestBody = ""
    }
    onRunningChanged: {
      if (running) return
      var started = root.forecastStarted
      root.forecastStarted = false
      // A missing /usr/bin/curl fails to start and never emits onExited.
      if (started || !root.loading) return
      root.loading = false
      root.errorText = "curl is missing at " + Model.CURL_PATH
    }
    stdout: StdioCollector {
      id: forecastStdout
      waitForEnd: true
      property string raw: ""
      onStreamFinished: raw = String(text || "")
    }
    stderr: StdioCollector {
      id: forecastStderr
      waitForEnd: true
      property string raw: ""
      onStreamFinished: raw = String(text || "")
    }
    onExited: function(exitCode) {
      root.loading = false
      var parsed = root.provider === "windy"
        ? Model.parseResponse(forecastStdout.raw)
        : OpenMeteo.parseResponse(forecastStdout.raw)
      if (parsed.ok) {
        root.forecast = parsed.data
        root.errorText = ""
        root.retries = 0
        root.lastUpdatedMs = Date.now()
        return
      }
      var diagnostic = forecastStderr.raw.replace(/^\s+|\s+$/g, "")
      var failure = parsed.error || diagnostic
        || (root.provider === "windy" ? "Windy request failed" : "Open-Meteo request failed")
      // A mapped regional model can answer "No data is available for this
      // location"; retry once with best_match instead of failing the widget.
      if (root.provider === "openmeteo" && !root.openMeteoFallback
          && OpenMeteo.resolveModel(root.modelSetting) !== "best_match"
          && /no data/i.test(failure)) {
        root.openMeteoFallback = true
        root.errorText = ""
        root.loading = true
        Qt.callLater(root.startForecastRequest)
        return
      }
      root.errorText = failure
      root.scheduleRetry()
    }
  }

  Timer {
    id: refreshTimer
    interval: refreshMinutes * 60 * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh(false)
  }

  onLocationChanged: {
    forecast = null
    errorText = ""
    locationError = ""
    lastUpdatedMs = 0
    openMeteoFallback = false
    refresh(true)
  }
  onApiKeyChanged: if (provider === "windy" && apiKey !== "") refresh(true)
  // Switching providers (including "auto" flipping on a key arrival) drops the
  // other provider's data so no stale values leak into the panel.
  onProviderChanged: {
    forecast = null
    errorText = ""
    lastUpdatedMs = 0
    openMeteoFallback = false
    refresh(true)
  }
  onModelSettingChanged: {
    openMeteoFallback = false
    refresh(true)
  }

  function openWindy() {
    if (!location) return
    browserProc.command = ["omarchy-launch-browser",
      "https://www.windy.com/?" + location.latitude + "," + location.longitude + ",9"]
    browserProc.running = true
  }

  Process {
    id: browserProc
  }

  // ---- Panel lifecycle ------------------------------------------------------
  function open() {
    openedFromHotkey = false
    setCenterHoverRevealSuppressed(false)
    root.controller.show()
    locationFile.reload()
    refresh(false)
  }

  function openFromHotkey() {
    openedFromHotkey = true
    root.controller.show()
    locationFile.reload()
    refresh(false)
    // Set after showing so a handoff to another panel cannot strand the flag.
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    settingsMode = false
    root.controller.hide()
  }

  function toggle() {
    root.opened ? root.close() : root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function")
      root.bar.setCenterHoverRevealSuppressed(value)
    else if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  function dayLabel(index, dateMs) {
    if (index === 0) return "TODAY"
    if (index === 1) return "TOMORROW"
    return Qt.formatDate(new Date(dateMs), "ddd").toUpperCase()
  }

  function dailyRange(day) {
    if (!day) return ""
    return Model.formatTemperature(day.maxTempC, temperatureUnit, false)
      + " / " + Model.formatTemperature(day.minTempC, temperatureUnit, false)
  }

  function rainAmount(millimeters) {
    if (millimeters === null || millimeters === undefined || millimeters < 0.05) return ""
    return "\uf043 " + Model.formatPrecip(millimeters, precipUnit)
  }

  // ---- Settings -------------------------------------------------------------
  function openSettings() {
    settingsMode = true
    if (editingLocation) cancelEditingLocation()
    apiKeySaved = false
    Qt.callLater(function() {
      if (apiKeyField && root.provider === "windy") apiKeyField.forceActiveFocus()
      else settingsColumn.forceActiveFocus()
    })
  }

  function closeSettings() {
    settingsMode = false
    Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
  }

  // Persist one key on this widget's shell.json entry. Applied locally first
  // so the panel updates on the click itself; the shell.json write comes back
  // through the bar as the same value.
  function saveSetting(key, value) {
    var entry = { id: root.moduleName }
    for (var k in root.settings) if (k !== "id") entry[k] = root.settings[k]
    entry[key] = value
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  // Reads the key once at startup. The child keeps a closed environment except
  // for what D-Bus needs. A missing secret-tool or an unavailable keyring
  // simply leaves keyringKey empty, and the legacy value or WINDY_API_KEY
  // keeps working.
  Process {
    id: keyringLookupProc
    command: Model.secretLookupCommand()
    clearEnvironment: true
    environment: Model.keyringEnvironment(Quickshell.env("XDG_RUNTIME_DIR"),
      Quickshell.env("DBUS_SESSION_BUS_ADDRESS"))
    running: true
    stdout: StdioCollector {
      id: keyringLookupStdout
      waitForEnd: true
      property string raw: ""
      onStreamFinished: raw = String(text || "")
    }
    onExited: function(exitCode) {
      if (exitCode === 0) root.keyringKey = Model.trimSecret(keyringLookupStdout.raw)
      root.maybeMigrateLegacyKey()
    }
  }

  // Writes one credential to the keyring. The secret travels over stdin and is
  // never part of a command line.
  Process {
    id: keyringStoreProc
    stdinEnabled: root.keyringStoreBody !== ""
    clearEnvironment: true
    environment: Model.keyringEnvironment(Quickshell.env("XDG_RUNTIME_DIR"),
      Quickshell.env("DBUS_SESSION_BUS_ADDRESS"))
    onStarted: {
      root.keyringStoreStarted = true
      if (root.keyringStoreBody === "") return
      write(root.keyringStoreBody)
      // Clearing the body flips stdinEnabled, closing the pipe so secret-tool
      // sees EOF and stores the value.
      root.keyringStoreBody = ""
    }
    onExited: function(exitCode) {
      var value = root.keyringPendingValue
      var migrating = root.keyringStoreIsMigration
      root.keyringPendingValue = ""
      root.keyringStoreIsMigration = false
      if (exitCode !== 0) {
        root.keyringError = "Couldn't save the key to the login keyring"
        return
      }
      root.keyringError = ""
      root.keyringKey = value
      if (migrating) {
        root.stripLegacyApiKey()
        return
      }
      if (apiKeyField) apiKeyField.text = ""
      root.apiKeySaved = true
      apiKeySavedTimer.restart()
    }
    onRunningChanged: {
      if (running) return
      var started = root.keyringStoreStarted
      root.keyringStoreStarted = false
      if (started || root.keyringPendingValue === "") return
      root.keyringPendingValue = ""
      root.keyringStoreIsMigration = false
      root.keyringStoreBody = ""
      root.keyringError = "secret-tool is missing at " + Model.SECRET_TOOL_PATH
    }
  }

  Process {
    id: keyringClearProc
    command: Model.secretClearCommand()
    clearEnvironment: true
    environment: Model.keyringEnvironment(Quickshell.env("XDG_RUNTIME_DIR"),
      Quickshell.env("DBUS_SESSION_BUS_ADDRESS"))
    onStarted: root.keyringClearStarted = true
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.keyringError = "Couldn't clear the key from the login keyring"
        return
      }
      root.keyringError = ""
      root.keyringKey = ""
      root.stripLegacyApiKey()
      if (apiKeyField) apiKeyField.text = ""
      root.apiKeySaved = true
      apiKeySavedTimer.restart()
    }
    onRunningChanged: {
      if (running) return
      var started = root.keyringClearStarted
      root.keyringClearStarted = false
      if (started) return
      root.keyringError = "secret-tool is missing at " + Model.SECRET_TOOL_PATH
    }
  }

  function startKeyringStore(value, migrating) {
    if (keyringStoreProc.running) return
    keyringError = ""
    keyringPendingValue = String(value)
    keyringStoreIsMigration = migrating === true
    keyringStoreBody = String(value)
    keyringStoreProc.command = Model.secretStoreCommand()
    keyringStoreProc.running = true
  }

  // One-time migration: a pre-keyring install kept the key in shell.json.
  // The plaintext is removed only after the keyring write succeeded, so a
  // failure leaves the widget working from the legacy value.
  function maybeMigrateLegacyKey() {
    if (migrationAttempted || legacyKey === "") return
    migrationAttempted = true
    startKeyringStore(legacyKey, true)
  }

  // updateEntryInline replaces the whole entry, so omitting apiKey is what
  // removes the plaintext credential from shell.json.
  function stripLegacyApiKey() {
    if (legacyKey === "") return
    var entry = Model.entryWithoutApiKey(root.settings)
    entry.id = root.moduleName
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function commitApiKey() {
    var value = Model.trimSecret(apiKeyField.text)
    if (value === "") {
      if (keyringClearProc.running) return
      keyringError = ""
      keyringClearProc.running = true
      return
    }
    startKeyringStore(value, false)
  }

  Timer {
    id: apiKeySavedTimer
    interval: 2000
    onTriggered: root.apiKeySaved = false
  }

  // One-of-N pill used by the settings section.
  component SettingChip: Rectangle {
    id: chip
    property string label: ""
    property bool selected: false
    property color foreground: Color.foreground
    property string fontFamily: Style.font.family
    signal picked()

    width: chipLabel.implicitWidth + Style.space(18)
    height: chipLabel.implicitHeight + Style.space(8)
    radius: Style.cornerRadius
    color: (chip.selected || chipArea.containsMouse)
      ? Style.hoverFillFor(chip.foreground, Color.accent) : "transparent"
    border.width: Style.spacing.hairline
    border.color: chip.foreground
    opacity: chip.selected || chipArea.containsMouse ? 1 : 0.75

    Text {
      id: chipLabel
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: chip.label
      color: chip.foreground
      font.family: chip.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    MouseArea {
      id: chipArea
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: chip.picked()
    }
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function show(): void { root.openFromHotkey() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function edit(): void { root.openFromHotkey(); root.startEditingLocation() }
    function settings(): void { root.openFromHotkey(); root.openSettings() }
    function refresh(): void { root.refresh(true) }
    function status(): string {
      return JSON.stringify({
        location: root.location,
        detecting: root.detectingLocation,
        error: root.errorText,
        loading: root.loading,
        updated: root.lastUpdatedMs,
        model: root.modelId,
        provider: root.provider,
        unit: root.unit,
        temperatureUnit: root.temperatureUnit,
        precipUnit: root.precipUnit,
        countryHint: root.countryHint,
        tooltip: root.tooltipText,
        warning: root.apiWarning,
        current: root.current,
        hourly: root.hourly,
        daily: root.daily
      })
    }
  }

  // ---- UI -------------------------------------------------------------------
  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(560))
    contentHeight: panel.fittedContentHeight(weatherColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.editingLocation || root.settingsMode
      onCloseRequested: root.close()
      onReturnRequested: root.startEditingLocation()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        id: weatherScroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: weatherColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: weatherColumn
          width: weatherScroll.width
          spacing: Style.space(14)

          // ---- Hero: condition + temperature on the left, location on the right.
          Item {
            visible: !root.settingsMode
            width: parent.width
            height: Math.max(heroLeft.height, locationColumn.height)

            // Condition + temperature pin to the top-left corner, location to
            // the top-right — the stock weather header layout.
            Row {
              id: heroLeft
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(16)

              Text {
                id: heroCondition
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.conditionGlyph !== "" ? root.conditionGlyph : "\uf72e"
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: 64
              }

              Column {
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)

                Row {
                  spacing: Style.space(2)

                  Text {
                    id: tempBig
                    textFormat: Text.PlainText
                    text: root.heroTemperatureText !== "" ? root.heroTemperatureText : "—"
                    color: root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: 56
                    font.bold: true
                  }
                  Text {
                    textFormat: Text.PlainText
                    text: root.current ? root.temperatureUnitLabel : ""
                    color: root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.display
                    anchors.top: tempBig.top
                    anchors.topMargin: Style.space(10)
                  }
                }

                Text {
                  anchors.horizontalCenter: parent.horizontalCenter
                  visible: root.heroCaptionText !== ""
                  textFormat: Text.PlainText
                  text: root.heroCaptionText
                  color: Qt.darker(root.barForeground, 1.4)
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  font.letterSpacing: 1
                }
              }
            }

            Column {
              id: locationColumn
              width: root.editingLocation
                ? Math.max(locationRow.implicitWidth, editorRow.implicitWidth)
                : locationRow.implicitWidth
              anchors.right: parent.right
              anchors.rightMargin: Style.space(20)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(6)

              Row {
                id: locationRow
                visible: !root.editingLocation && root.location && root.location.name !== ""
                spacing: Style.space(6)

                TapHandler {
                  onTapped: root.startEditingLocation()
                }
                HoverHandler {
                  cursorShape: Qt.PointingHandCursor
                }

                Text {
                  textFormat: Text.PlainText
                  text: ""  // nf-fa-map_marker
                  color: Qt.darker(root.barForeground, 1.4)
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.body
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  textFormat: Text.PlainText
                  text: (root.location && root.location.name ? root.location.name : "").toUpperCase()
                  color: Qt.darker(root.barForeground, 1.4)
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.body
                  font.letterSpacing: 1
                  anchors.verticalCenter: parent.verticalCenter
                }
              }

              Row {
                id: editorRow
                visible: root.editingLocation
                spacing: Style.space(6)

                TextField {
                  id: locationField
                  width: Style.space(190)
                  enabled: !root.savingLocation
                  placeholderText: "Search city"
                  foreground: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family

                  onTextChanged: if (root.editingLocation && !root.savingLocation) geocodeDebounce.restart()

                  Keys.onPressed: function(event) {
                    if (event.key === Qt.Key_Escape) {
                      root.cancelEditingLocation()
                      event.accepted = true
                    } else if (event.key === Qt.Key_Down) {
                      if (root.suggestionIndex < root.locationSuggestions.length - 1) root.suggestionIndex++
                      event.accepted = true
                    } else if (event.key === Qt.Key_Up) {
                      if (root.suggestionIndex > 0) root.suggestionIndex--
                      event.accepted = true
                    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                      root.commitLocation()
                      event.accepted = true
                    }
                  }
                }

                // Clear back to IP auto-detect; doubles as the save spinner.
                Rectangle {
                  width: Style.space(18)
                  height: Style.space(18)
                  anchors.verticalCenter: parent.verticalCenter
                  radius: Math.min(4, Style.cornerRadius)
                  color: !root.savingLocation && clearLocationArea.containsMouse
                    ? Style.hoverFillFor(root.barForeground, Color.accent) : "transparent"

                  Text {
                    anchors.centerIn: parent
                    textFormat: Text.PlainText
                    text: root.savingLocation ? "󰦖" : "✕"
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    color: Qt.darker(root.barForeground, 1.4)
                    font.pixelSize: Style.font.bodySmall

                    RotationAnimator on rotation {
                      running: root.savingLocation
                      from: 0; to: 360
                      duration: 800
                      loops: Animation.Infinite
                    }
                  }

                  MouseArea {
                    id: clearLocationArea
                    anchors.fill: parent
                    enabled: !root.savingLocation
                    hoverEnabled: true
                    cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: root.clearLocation()
                  }
                }
              }

              Text {
                textFormat: Text.PlainText
                visible: root.current && root.current.condition !== ""
                anchors.left: parent.left
                text: root.current ? Model.conditionLabel(root.current.condition) : ""
                color: Qt.darker(root.barForeground, 1.5)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.letterSpacing: 1
              }
            }
          }

          // ---- Geocoding suggestions while the location is being edited.
          Column {
            visible: !root.settingsMode && root.editingLocation && !root.savingLocation && root.locationSuggestions.length > 0
            width: parent.width
            spacing: 0

            Repeater {
              model: root.locationSuggestions

              Rectangle {
                required property var modelData
                required property int index
                width: parent.width
                height: suggestionRow.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: index === root.suggestionIndex
                  ? Style.hoverFillFor(root.barForeground, Color.accent) : "transparent"

                Row {
                  id: suggestionRow
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(16)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(8)

                  Text {
                    textFormat: Text.PlainText
                    text: modelData.name
                    color: index === root.suggestionIndex
                      ? Style.hoverStateColor(root.barForeground, Color.accent) : root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                  }
                  Text {
                    textFormat: Text.PlainText
                    visible: text !== ""
                    text: modelData.description
                    color: Qt.darker(root.barForeground, 1.5)
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.bodySmall
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }

                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onPositionChanged: root.suggestionIndex = index
                  onClicked: root.pickSuggestion(modelData)
                }
              }
            }
          }

          // ---- Settings: provider, API key and display units.
          Column {
            id: settingsColumn
            visible: root.settingsMode
            width: parent.width
            spacing: Style.space(14)
            focus: visible
            Keys.onEscapePressed: root.closeSettings()

            Text {
              textFormat: Text.PlainText
              text: "SETTINGS"
              color: Qt.darker(root.barForeground, 1.4)
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.bodySmall
              font.letterSpacing: 1
            }

            Column {
              width: parent.width
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                text: "DATA PROVIDER"
                color: Qt.darker(root.barForeground, 1.5)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.letterSpacing: 1
              }

              Row {
                spacing: Style.space(8)

                Repeater {
                  model: [
                    { id: "openmeteo", label: "Open-Meteo" },
                    { id: "windy", label: "Windy" },
                    { id: "auto", label: "Auto" }
                  ]

                  SettingChip {
                    required property var modelData
                    label: modelData.label
                    selected: String(root.setting("provider", "openmeteo")) === modelData.id
                    foreground: root.barForeground
                    fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                    onPicked: root.saveSetting("provider", modelData.id)
                  }
                }
              }

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: root.provider === "windy"
                  ? "Windy uses the API key from your login keyring. Testing keys return shuffled data; a Professional key is required for real forecasts."
                  : "Open-Meteo needs no API key and is free for non-commercial use. Auto uses Windy only when a key is stored."
                color: Qt.darker(root.barForeground, 1.5)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
              }
            }

            Column {
              width: parent.width
              spacing: Style.space(6)
              visible: root.provider === "windy"

              Text {
                textFormat: Text.PlainText
                text: "API KEY"
                color: Qt.darker(root.barForeground, 1.5)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.letterSpacing: 1
              }

              Item {
                width: parent.width
                height: Math.max(apiKeyField.implicitHeight, apiKeySaveButton.implicitHeight)

                TextField {
                  id: apiKeyField
                  anchors.left: parent.left
                  anchors.right: apiKeySaveButton.left
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  password: true
                  placeholderText: root.apiKey === "" ? "Paste your Windy API key" : "Key set — paste to replace"
                  foreground: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family

                  Keys.onPressed: function(event) {
                    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                      root.commitApiKey()
                      event.accepted = true
                    } else if (event.key === Qt.Key_Escape) {
                      root.closeSettings()
                      event.accepted = true
                    }
                  }
                }

                Button {
                  id: apiKeySaveButton
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.apiKeySaved ? "Saved" : "Save"
                  foreground: root.barForeground
                  fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                  bordered: true
                  selected: root.apiKeySaved
                  verticalPadding: Style.spacing.inputPaddingY
                  onClicked: root.commitApiKey()
                }
              }

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: "Stored in your login keyring. Leave blank and save to clear; WINDY_API_KEY is the fallback."
                color: Qt.darker(root.barForeground, 1.5)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
              }

              Text {
                visible: root.keyringError !== ""
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: root.keyringError
                color: root.bar ? root.bar.urgent : Color.urgent
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
              }
            }

            Column {
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                text: "WIND SPEED"
                color: Qt.darker(root.barForeground, 1.5)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.letterSpacing: 1
              }

              Row {
                spacing: Style.space(8)

                Repeater {
                  model: [
                    { id: "kn", label: "kn" },
                    { id: "kmh", label: "km/h" },
                    { id: "mph", label: "mph" },
                    { id: "ms", label: "m/s" }
                  ]

                  SettingChip {
                    required property var modelData
                    label: modelData.label
                    selected: root.unit === modelData.id
                    foreground: root.barForeground
                    fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                    onPicked: root.saveSetting("unit", modelData.id)
                  }
                }
              }
            }

            Column {
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                text: "TEMPERATURE"
                color: Qt.darker(root.barForeground, 1.5)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.letterSpacing: 1
              }

              Row {
                spacing: Style.space(8)

                Repeater {
                  model: [
                    { id: "auto", label: "Auto" },
                    { id: "c", label: "°C" },
                    { id: "f", label: "°F" }
                  ]

                  SettingChip {
                    required property var modelData
                    label: modelData.label
                    selected: String(root.setting("temperatureUnit", "auto")) === modelData.id
                    foreground: root.barForeground
                    fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                    onPicked: root.saveSetting("temperatureUnit", modelData.id)
                  }
                }
              }
            }

            Column {
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                text: "TEMPERATURE SHOWN"
                color: Qt.darker(root.barForeground, 1.5)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.letterSpacing: 1
              }

              Row {
                spacing: Style.space(8)

                Repeater {
                  model: [
                    { id: "air", label: "Air" },
                    { id: "feels", label: "Feels like" }
                  ]

                  SettingChip {
                    required property var modelData
                    label: modelData.label
                    selected: root.temperatureMetric === modelData.id
                    foreground: root.barForeground
                    fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                    onPicked: root.saveSetting("temperatureMetric", modelData.id)
                  }
                }
              }
            }

            Column {
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                text: "BAR DISPLAY"
                color: Qt.darker(root.barForeground, 1.5)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.letterSpacing: 1
              }

              Row {
                spacing: Style.space(8)

                Repeater {
                  model: [
                    { id: "temp", label: "Temp" },
                    { id: "wind", label: "Wind" },
                    { id: "both", label: "Both" }
                  ]

                  SettingChip {
                    required property var modelData
                    label: modelData.label
                    selected: String(root.setting("display", "temp")) === modelData.id
                    foreground: root.barForeground
                    fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                    onPicked: root.saveSetting("display", modelData.id)
                  }
                }
              }
            }
          }

          // ---- Stats: wind, direction, gust, rain, humidity, feels-like.
          Item {
            visible: !root.settingsMode && !!root.current
            width: parent.width
            height: statsRow.height

            Row {
              id: statsRow
              anchors.horizontalCenter: parent.horizontalCenter
              spacing: Style.space(34)

              Column {
                spacing: Style.space(5)
                Text {
                  textFormat: Text.PlainText
                  text: "WIND"
                  color: Qt.darker(root.barForeground, 1.5)
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  font.letterSpacing: 1
                }
                Row {
                  spacing: Style.space(3)
                  Text {
                    textFormat: Text.PlainText
                    anchors.verticalCenter: parent.verticalCenter
                    text: "\uf062"
                    rotation: root.arrowRotation
                    color: root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.title
                  }
                  Text {
                    textFormat: Text.PlainText
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.speedLabel + " " + Model.unitLabel(root.unit)
                    color: root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.title
                  }
                }
              }

              Column {
                spacing: Style.space(5)
                Text {
                  textFormat: Text.PlainText
                  text: "FROM"
                  color: Qt.darker(root.barForeground, 1.5)
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  font.letterSpacing: 1
                }
                Text {
                  textFormat: Text.PlainText
                  text: root.directionLabel
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.title
                }
              }

              Column {
                spacing: Style.space(5)
                Text {
                  textFormat: Text.PlainText
                  text: "GUST"
                  color: Qt.darker(root.barForeground, 1.5)
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  font.letterSpacing: 1
                }
                Text {
                  textFormat: Text.PlainText
                  text: root.gustLabel !== "" ? root.gustLabel : "—"
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.title
                }
              }

              Column {
                spacing: Style.space(5)
                Text {
                  textFormat: Text.PlainText
                  text: "RAIN " + root.precipWindowHours + "H"
                  color: Qt.darker(root.barForeground, 1.5)
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  font.letterSpacing: 1
                }
                Text {
                  textFormat: Text.PlainText
                  text: root.rainLabel !== "" ? root.rainLabel : "—"
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.title
                }
              }

              Column {
                spacing: Style.space(5)
                Text {
                  textFormat: Text.PlainText
                  text: "HUMID"
                  color: Qt.darker(root.barForeground, 1.5)
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  font.letterSpacing: 1
                }
                Text {
                  textFormat: Text.PlainText
                  text: root.humidityLabel !== "" ? root.humidityLabel : "—"
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.title
                }
              }

              Column {
                spacing: Style.space(5)
                Text {
                  textFormat: Text.PlainText
                  text: "FEELS"
                  color: Qt.darker(root.barForeground, 1.5)
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  font.letterSpacing: 1
                }
                Text {
                  textFormat: Text.PlainText
                  text: root.feelsLikeLabel !== "" ? root.feelsLikeLabel : "—"
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.title
                }
              }
            }
          }

          // A testing key gets shuffled data on every request; say so rather
          // than letting the values look like a parsing bug.
          Text {
            visible: !root.settingsMode && root.apiWarning !== ""
            width: parent.width
            wrapMode: Text.WordWrap
            textFormat: Text.PlainText
            text: "Windy testing key — the API returns randomly shuffled data. A Professional key is required for real forecasts."
            color: root.bar ? root.bar.urgent : Color.urgent
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.caption
          }

          Text {
            visible: !root.settingsMode && root.statusText !== ""
            width: parent.width
            wrapMode: Text.WordWrap
            textFormat: Text.PlainText
            text: root.statusText
            color: Qt.darker(root.barForeground, 1.4)
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.bodySmall
            font.italic: true
          }

          Rectangle {
            visible: !root.settingsMode && root.hourly.length > 0
            width: parent.width
            height: Style.spacing.hairline
            color: root.barForeground
            opacity: 0.12
          }

          // ---- Hourly: time, condition, temperature, wind, rain.
          Item {
            visible: !root.settingsMode && root.hourly.length > 0
            width: parent.width
            height: hourlyRow.height

            Row {
              id: hourlyRow
              anchors.horizontalCenter: parent.horizontalCenter
              spacing: Style.space(10)

              Repeater {
                model: root.hourly

                Column {
                  required property var modelData
                  // Fixed width so every hour gets the same pitch regardless
                  // of whether a rain value or a one-digit speed is present.
                  width: Style.space(56)
                  spacing: Style.space(5)

                  Text {
                    textFormat: Text.PlainText
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: Qt.formatDateTime(new Date(modelData.ms), "HH:mm")
                    color: Qt.darker(root.barForeground, 1.4)
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.caption
                  }
                  Text {
                    textFormat: Text.PlainText
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: Model.conditionIcon(modelData.condition, root.night)
                    color: root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.display
                  }
                  Text {
                    textFormat: Text.PlainText
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: Model.formatTemperature(modelData.tempC, root.temperatureUnit, false)
                    color: root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                  }
                  Row {
                    anchors.horizontalCenter: parent.horizontalCenter
                    spacing: Style.space(3)
                    Text {
                      textFormat: Text.PlainText
                      anchors.verticalCenter: parent.verticalCenter
                      text: "\uf062"
                      rotation: modelData.toward
                      color: root.barForeground
                      font.family: root.bar ? root.bar.fontFamily : Style.font.family
                      font.pixelSize: Style.font.body
                    }
                    Text {
                      textFormat: Text.PlainText
                      anchors.verticalCenter: parent.verticalCenter
                      text: Model.formatSpeed(modelData.speedMs, root.unit)
                      color: root.barForeground
                      font.family: root.bar ? root.bar.fontFamily : Style.font.family
                      font.pixelSize: Style.font.body
                    }
                  }
                  Text {
                    textFormat: Text.PlainText
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: root.rainAmount(modelData.precipMm)
                    color: Qt.darker(root.barForeground, 1.3)
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.caption
                  }
                }
              }
            }
          }

          Rectangle {
            visible: !root.settingsMode && root.daily.length > 0
            width: parent.width
            height: Style.spacing.hairline
            color: root.barForeground
            opacity: 0.12
          }

          // ---- Daily outlook: day, condition, hi/lo, rain.
          Item {
            visible: !root.settingsMode && root.daily.length > 0
            width: parent.width
            height: dailyRow.height

            Row {
              id: dailyRow
              anchors.horizontalCenter: parent.horizontalCenter
              spacing: Style.space(20)

              Repeater {
                model: root.daily

                Column {
                  required property var modelData
                  required property int index
                  width: Style.space(84)
                  spacing: Style.space(4)

                  Text {
                    textFormat: Text.PlainText
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: root.dayLabel(index, modelData.dateMs)
                    color: Qt.darker(root.barForeground, 1.4)
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.caption
                    font.letterSpacing: 1
                  }
                  Text {
                    textFormat: Text.PlainText
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: Model.conditionIcon(modelData.condition, false)
                    color: root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.display
                  }
                  Text {
                    textFormat: Text.PlainText
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: root.dailyRange(modelData)
                    color: root.barForeground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                  }
                  Text {
                    textFormat: Text.PlainText
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: root.rainAmount(modelData.precipMm)
                    color: Qt.darker(root.barForeground, 1.3)
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.caption
                  }
                }
              }
            }
          }

          // ---- Footer: attribution + windy.com jump.
          Item {
            width: parent.width
            height: footerRow.height

            Row {
              id: footerRow
              anchors.right: parent.right
              anchors.rightMargin: Style.space(16)
              anchors.bottom: parent.bottom
              spacing: Style.space(16)

              Text {
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                text: "Data: " + (root.provider === "windy" ? "Windy" : "Open-Meteo (CC BY 4.0)") + " · " + root.activeModel
                  + (root.lastUpdatedMs > 0 ? " · " + Qt.formatDateTime(new Date(root.lastUpdatedMs), "HH:mm") : "")
                color: Qt.darker(root.barForeground, 1.5)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
              }

              Rectangle {
                width: openLabel.implicitWidth + Style.space(16)
                height: openLabel.implicitHeight + Style.space(8)
                radius: Style.cornerRadius
                color: openArea.containsMouse
                  ? Style.hoverFillFor(root.barForeground, Color.accent)
                  : "transparent"
                border.width: Style.spacing.hairline
                border.color: root.barForeground
                opacity: root.location ? 1 : 0.4

                Text {
                  id: openLabel
                  anchors.centerIn: parent
                  textFormat: Text.PlainText
                  text: "Open windy.com"
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }

                MouseArea {
                  id: openArea
                  anchors.fill: parent
                  hoverEnabled: true
                  enabled: !!root.location
                  cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: root.openWindy()
                }
              }

              // Configuration toggle.
              Rectangle {
                width: Style.space(24)
                height: Style.space(24)
                radius: Style.cornerRadius
                color: gearArea.containsMouse
                  ? Style.hoverFillFor(root.barForeground, Color.accent) : "transparent"

                Text {
                  anchors.centerIn: parent
                  textFormat: Text.PlainText
                  text: root.settingsMode ? "\uf00d" : "\uf013"  // nf-fa-times / nf-fa-cog
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.body
                }

                MouseArea {
                  id: gearArea
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.settingsMode ? root.closeSettings() : root.openSettings()
                }
              }
            }
          }
        }
      }
    }
  }
}
