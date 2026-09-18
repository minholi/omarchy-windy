# Windy for Omarchy

A wind, rain, and temperature bar widget for [Omarchy](https://omarchy.org) Quattro, backed by the [Open-Meteo API](https://open-meteo.com) by default and optionally by the [Windy Point Forecast API](https://api.windy.com/point-forecast).

![Windy panel](preview.png)

![Windy panel showing the feels-like temperature](screenshot-feels.png)

![Windy settings](screenshot-settings.png)

![Windy bar pill](screenshot-bar.png)

![Windy bar pill showing wind](screenshot-bar-wind.png)

- **Bar pill**: condition icon + temperature by default; optionally the rotating wind arrow + speed, or both.
- **Panel**: current conditions, a feels-like temperature stat, an 8-point hourly outlook (condition, temperature, wind, rain), and a 4-day forecast.
- **Location**: shares `weather.json` with Omarchy's stock weather widget. Click the location to search (Open-Meteo geocoding), or let it auto-detect by IP.
- **Settings**: provider, wind unit, temperature unit, header temperature, and bar display, from the gear in the panel or the CLI.
- **Credentials**: only the Windy provider needs an API key; it is stored in the login keyring (Secret Service), never in a config file.

## Requirements

- Omarchy with the Omarchy shell (Quattro).
- `curl` at `/usr/bin/curl` (preinstalled on Omarchy).
- No API key for the default provider; Open-Meteo's free tier is for non-commercial use.
- Optional, for the Windy provider: a Windy **Point Forecast** API key: <https://account.windy.com/keys>. Testing keys are free but Windy returns randomly shuffled, slightly modified data on every request; a Professional plan key is required for real forecasts. Windy keys also need `secret-tool` at `/usr/bin/secret-tool` and a running Secret Service provider; Omarchy's default `gnome-keyring` passwordless keyring qualifies.

The widget uses these network services at runtime:

| Service | Purpose |
| --- | --- |
| `api.open-meteo.com` | Forecast data for the default provider (no key) |
| `api.windy.com` | Forecast data when the Windy provider is selected (requires your API key) |
| `geocoding-api.open-meteo.com` | Location search suggestions |
| `ipwho.is` | First-run location auto-detection when no location is configured |
| `www.windy.com` | Opened in your browser by the panel's "Open windy.com" button |

## Providers

The `provider` setting selects where forecasts come from:

- `openmeteo` (default): the [Open-Meteo API](https://open-meteo.com). Needs no key, returns real data, and is free for non-commercial use under the [CC BY 4.0 licence](https://open-meteo.com/en/licence); the free tier allows 10 000 calls/day. The panel credits it in the footer.
- `windy`: the Windy Point Forecast API. Requires a key from the login keyring; testing keys return randomly shuffled data (the panel warns when it detects this), and real forecasts need a Windy Professional plan.
- `auto`: Windy when a key is stored, Open-Meteo otherwise.

Windy model ids map to Open-Meteo models, so the same `model` setting works with both providers:

| Windy | Open-Meteo |
| --- | --- |
| `auto` | `best_match` (highest-resolution model for the coordinates) |
| `gfs` | `gfs_seamless` |
| `icon` | `icon_seamless` |
| `iconEu` | `icon_eu` |
| `iconD2` | `icon_d2` |
| `aromeFrance` | `meteofrance_arome_france_hd` |
| `hrrrConus` | `gfs_hrrr` |
| `canHrdps` | `gem_hrdps_continental` |
| `namConus`, `namAlaska`, `namHawaii` | `best_match` |

Regional models reject coordinates outside their domain; the widget then retries once with `best_match`. The rain stat covers the preceding 3 hours with Windy and the preceding hour with Open-Meteo, so the label reads `RAIN 3H` or `RAIN 1H` accordingly.

The feels-like reading is the provider's apparent temperature when it has one — Open-Meteo's includes solar radiation — and otherwise a shade apparent temperature derived from air temperature, relative humidity, and wind (Steadman's formula), which is what the Windy provider gets.

## Request handling

Every request runs `/usr/bin/curl` by absolute path with a closed environment, so
nothing from the shell environment (including `WINDY_API_KEY`) reaches it and no
`PATH` entry can substitute another binary. Open-Meteo requests carry no secret;
the API key only applies to the Windy provider.

The Windy API expects the key inside the JSON request body. That body is piped to
curl's stdin (`--data-binary @-`) instead of being passed as an argument, so the
key never appears in a process command line, where `/proc/<pid>/cmdline` and
failed-start diagnostics would expose it.

Responses are bounded by curl itself (256 KiB for forecasts, 64 KiB for the
location and geocoding lookups) and by a request timeout, so a hostile or
malformed response cannot grow the shell's in-memory buffer without limit.
Because the environment is closed, proxy variables such as `https_proxy` do not
apply to these requests.

## Credentials

The API key is stored in the login keyring through `secret-tool` under the
attributes `service windy account minholi.windy`. It is never written
to `shell.json`: the widget talks to the keyring with `lookup`, `store`, and
`clear`, pipes the key to `store` over stdin so it never appears in a process
command line, and runs `secret-tool` by absolute path with a minimal
environment limited to the D-Bus session address.

Set the key through the gear icon in the panel (leave the field blank and save
to remove it). From the CLI, use the same keyring entry:

```bash
printf '%s' '<your-key>' | secret-tool store --label='Windy API key' service windy account minholi.windy
secret-tool clear service windy account minholi.windy   # remove
```

Versions before 1.0.3 kept the key in `shell.json`. On first load the widget
migrates that value into the keyring and strips the plaintext entry; the
migration only removes the legacy value after the keyring write succeeded.

As a fallback, the plugin reads the `WINDY_API_KEY` environment variable when
neither the keyring nor a legacy value holds a key.

## Install

```bash
omarchy plugin add https://github.com/minholi/omarchy-windy.git --enable
```

Nothing else is required: the default Open-Meteo provider needs no key. To use Windy instead, add your API key through the gear icon in the panel or from the CLI as shown under [Credentials](#credentials).

## Remove

```bash
omarchy plugin remove minholi.windy --yes
```

## Settings

Set values with `omarchy bar set minholi.windy <key> <value>` or through the panel's gear icon.

The API key is a credential and lives in the keyring — see [Credentials](#credentials).

| Key | Values | Default | Description |
| --- | --- | --- | --- |
| `provider` | `openmeteo`, `windy`, `auto` | `openmeteo` | Forecast data source; see [Providers](#providers). |
| `unit` | `kn`, `kmh`, `mph`, `ms` | `kn` | Wind speed unit. |
| `temperatureUnit` | `auto`, `c`, `f` | `auto` | Auto resolves by the location's country, then the locale. Rain follows: mm with °C, inches with °F. |
| `temperatureMetric` | `air`, `feels` | `air` | Which temperature the panel header shows large; `feels` uses the apparent feels-like value. The FEELS stat and the tooltip show it either way. |
| `display` | `temp`, `wind`, `both` | `temp` | Bar pill: condition + temperature, rotating arrow + speed, or all four. |
| `level` | `surface`, `850h`, `700h`, `500h`, `300h` | `surface` | Wind level; temperature and rain stay at the surface. |
| `model` | `auto`, `gfs`, `icon`, `iconEu`, `iconD2`, `aromeFrance`, `hrrrConus`, `namConus`, `namAlaska`, `namHawaii`, `canHrdps` | `auto` | Auto picks the highest-resolution model covering your coordinates (Windy falls back to GFS, Open-Meteo resolves to `best_match`). See [Providers](#providers) for the mapping. |
| `refreshMinutes` | integer 5–180 | `15` | Forecast refresh interval. |

## Location

The widget reads and writes the same state file as Omarchy's stock weather widget (`~/.local/state/omarchy/settings/weather.json`, owned by `omarchy-weather-location`), so both stay in sync. Click the location label in the panel to search for a city, press Enter to commit, or click ✕ to return to IP auto-detection. A hand-written `{"name": "Malibu"}` entry is resolved to exact coordinates once and upgraded in place.

## Commands

```bash
omarchy-shell minholi.windy status    # JSON snapshot (location, current, hourly, daily, tooltip)
omarchy-shell minholi.windy refresh   # force a fetch
omarchy-shell minholi.windy toggle    # open/close the panel
omarchy-shell minholi.windy edit      # open the location editor
omarchy-shell minholi.windy settings  # open the settings view
```

## Development

```bash
node --test                                  # pure data-shaping tests (Model.js and OpenMeteo.js)
omarchy plugin validate .                   # manifest/repository validation
```

QML changes require `omarchy restart shell`; the plugin hot-reload does not rebuild entry-point QML.

## Data and attribution

Weather data comes from [Open-Meteo](https://open-meteo.com) by default, which is free for non-commercial use and requires the [CC BY 4.0 attribution](https://open-meteo.com/en/licence) the panel shows in its footer. When the Windy provider is selected, data comes from the Windy Point Forecast API and is subject to [Windy's terms](https://api.windy.com/point-forecast/pricing); testing keys get randomly shuffled, slightly modified data on every request, and the panel shows a warning whenever the API marks a response that way. Geocoding is provided by Open-Meteo; IP auto-detection by ipwho.is. This plugin is unofficial and not affiliated with Windyty, S.E. or OpenMeteo GmbH.

## License

MIT — see [LICENSE](LICENSE).
