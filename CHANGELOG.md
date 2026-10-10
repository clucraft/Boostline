# Changelog

All notable changes to Boostline are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-10-09

A new look and a new layout. Every feature from 0.4 is still there; some have moved.

### Changed

- **New look:** a near-black theme with an amber accent, the Inter and JetBrains Mono typefaces (bundled, so the app looks the same offline), new icons (Phosphor), and a new logo and app icon.
- **New layout:** a rail on the left switches between **Live**, **Analyze**, **Dyno**, **Drag** and **Settings**. The top bar shows the connection, the car's VIN (click it for the DME data and ECU software) and the capture control. The status bar is gone.
- **Live** is a dashboard of value tiles. Actual and target channels (boost, lambda, rail pressure, throttle, wastegate, load, torque, VANOS) share one tile, with a bar showing how far apart they are. Channels are picked in a searchable picker (**Ctrl+K**, ⌘K on a Mac). The live graphs sit below the tiles.
- **Analyze** has a log library: your recorded logs grouped by day, with search. Click one to open it. Graphs, WOT pull tools, log comparison and heatmaps work as before.
- **Dyno** and **Drag** show the results first: large peak power and torque or final-time figures, a set up → capture → results indicator, and the setup and saved runs in a panel on the right. Drag splits are drawn as bars, and gear changes are marked on the speed graph.
- **Record** is now **Start capture** and works from any screen. **Start live / Stop live** are now **Resume stream / Pause stream**.
- Channel names are shorter and in sentence case, e.g. *Boost pressure* and *Boost target* instead of *Boost Pressure · Actual* and *Boost Pressure · Target*. Logs still use the same channel ids, so older logs open with every channel recognised.
- New installs start with accelerator pedal and intake air temperature on the dashboard as well.
- Graphs, heatmaps and exported PNGs use the new colors. Time and sample heatmaps use an amber scale, and a moment picked from a heatmap is shaded blue in the graphs.

## [0.4.1] - 2026-10-09

### Fixed

- Heatmap rows were stretched to about 46 px instead of 30 px, so a full map didn't fit on screen without scrolling.

### Changed

- The README's Heatmaps guide now walks through every step with screenshots: the toolbar, the presets, jumping from a cell to the graphs, the axes editor and an exported PNG.

## [0.4.0] - 2026-10-09

Heatmaps: see where in the map timing gets pulled, the mixture runs lean, or boost misses its target.

### Added

- **Heatmaps (RPM × load)** in the Log Viewer. A new **Graphs | Heatmap** toggle sorts every sample into an RPM × load grid and colors each cell by the chosen value.
  - Presets: knock map (beta), lambda map, boost map, rail pressure map and coverage, or any channel.
  - Statistics: mean, worst, min, max, std deviation, samples and time spent.
  - Editable axes, with auto sizing from data.
  - Filters: warm engine, exclude transients, exclude fuel cut, throttle, gear and visible range only, plus a minimum-samples threshold.
  - Several logs can be combined into one grid, time-weighted so different sample rates combine fairly.
  - Clicking a cell shows its statistics and every moment that landed there. Each moment jumps to the graphs, zoomed in and shaded.
  - Export as a table (clipboard), CSV or PNG.
- Derived channels for any log: lambda error, boost error, rail pressure drop and estimated per-cylinder timing correction (beta, from the spread between cylinders after removing each cylinder's normal offset).

## [0.3.0] - 2026-10-09

Boostline now runs on macOS, and real-car setup is documented.

### Added

- **macOS support.** A universal `.dmg` for Apple Silicon and Intel Macs is built and published with every release, alongside the Windows installers.
  - The Mac build isn't signed by Apple (only ad-hoc signed), so the first launch needs **Open Anyway**. The README has step-by-step instructions.
  - On macOS, Boostline uses the native window buttons and the system font, and ⌘+scroll or a trackpad pinch zooms the Log Viewer.
- Release builds of both platforms are launch-tested in CI: the packaged app is started and has to render its UI. The macOS ad-hoc signature is also verified.
- 1024 px app icon (needed for macOS).
- README guide **Setting up BMW DME data**, with screenshots: downloading and importing, reading the coverage list, when to choose the DME data manually (e.g. 2016–2019 B58 by I-level), checking it works, offline import and troubleshooting. The BMW DME data card in Settings links to it.

### Changed

- MHD WiFi adapter confirmed working on a real car. Connection help now says to join the **MHD ENET** network (the adapter also broadcasts **MHD ECA**, which doesn't carry diagnostics).

## [0.2.0] - 2026-10-09

Real cars get the full BMW channel set, including the S55 and S58 M engines.

### Added

- **BMW DME data import** (Settings → BMW DME data). One click downloads the open-source bmw-unified-db release, verifies its checksum and extracts every UDS petrol DME's measurement table: 26 DME files covering B38/B48/B58, S58, S55, N55, N20, N13, N54, N63, S63 and N74.
  - Brings the full BMW channel set to real cars: boost actual/target, wastegate, rail pressure actual/target, lambda actual/target, per-cylinder timing and knock signal, VANOS, air mass through throttle, driver wish torque, torque reserve and hundreds more.
  - Up to about 950 channels on MG1 DMEs (B58 TU / S58) and about 430 on the S55.
  - The data is BMW-copyrighted. It stays on the user's PC and is never bundled. A local `bmw.sqlite` / `.sqlite.gz` can be imported instead of downloading.
- **Automatic DME identification:** on connect, the DME's diagnostic index (`22 F150`) selects the matching data. It can be overridden manually in Settings, and the status bar shows which data is in use.
- **Fast block logging:** composable measurements are packed into dynamically defined data identifiers (`2C 01`), falling back to batched `22` reads when the ECU refuses.
- Curated mapping of the most important measurements onto Boostline's standard channels with English names, so presets, Dyno and Drag work on every DME family. Everything else is listed in a new "DME" channel group.
- Relative boost (actual and target) derived from absolute charge pressure and ambient pressure.

## [0.1.0] - 2026-10-09

First public release.

### Added

- **Logger**: live data tiles with a value and sparkline for up to 40 channels, a grouped and searchable channel list (Engine, Throttle, Load, Boost, Fuel, Ignition, Knock, Temperatures, VANOS, Vehicle, Electrical), channel presets, Start/Stop live and one-click CSV recording.
- **Log Viewer**: up to 5 graphs with up to 5 channels each, a colored Y axis per channel, Ctrl+scroll zoom, Shift+scroll pan, drag-to-zoom, synced cursors, cursor value pop-ups, per-channel manual scales, rename, pin, reorder, fullscreen, and a right-click menu.
- Log Viewer live mode that plots incoming data while logging, with pause/resume.
- Automatic **WOT pull detection** with pull-by-pull navigation, plus export of a pull or the visible range as CSV and of any graph as PNG.
- **Log comparison**: overlay a second log, automatically aligned on its first WOT pull, with an adjustable time offset.
- Reads Boostline, MHD, bootmod3 and generic CSV logs (auto-detects delimiter, decimal commas, units and the time column).
- Graph layouts that can be saved and reapplied.
- **Dyno**: road-dyno estimate of engine power, wheel power and torque vs. RPM from a single-gear WOT pull. Inputs: vehicle mass, drivetrain loss, RPM window, minimum pedal, smoothing, temperature, humidity, air pressure, drag area and rolling resistance. Optional SAE J1349 or DIN 70020 correction.
- Dyno runs can be armed live, analyzed from any log, saved automatically and overlaid for comparison.
- **Drag timing**: 0–100, 100–200 and 200–300 km/h, 0–60 and 60–130 mph, 1/8 mile and 1/4 mile, with standing-start detection.
- Drag results include splits every 10 km/h (or mph), gear changes with time and speed, and raw vs. calibrated speed curves.
- **GPS speed calibration** table with saved profiles (calibration plus altitude, temperature and humidity).
- **ENET (HSFZ over TCP 6801)** connection with UDP vehicle discovery, VIN and ECU software ID readout, and standard OBD-II channels read via UDS `ReadDataByIdentifier` (0xF4xx), with adaptive multi-DID batching.
- MHD and bootmod3 WiFi adapters are supported through the same ENET gateway path.
- **Custom channel definitions**: JSON files with DIDs or ECU memory addresses, matched against the ECU software version.
- **Connection diagnostics**: network scan, discovery, a read-only VIN request and a byte-level capture file for troubleshooting adapters.
- **Simulator**: a physics-based B58 drive cycle (launches, a 4th-gear pull, shifts, boost spool, knock events) so every screen works without a car.
- Safety: the UDS client has a hard allowlist of read-only services (session control, read data/memory, dynamic DID definition, tester present, read DTCs). Nothing that writes, codes or flashes can be sent.
- Settings for units (bar/psi/kPa, °C/°F, km/h/mph, Nm/lb-ft, hp/PS/kW, kg/h/g/s/lb/min, λ/AFR), Log Viewer behavior, data folder, and auto-recording of WOT pulls.

[Unreleased]: https://github.com/clucraft/Boostline/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/clucraft/Boostline/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/clucraft/Boostline/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/clucraft/Boostline/releases/tag/v0.4.0
