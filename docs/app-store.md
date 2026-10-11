# App Store listing

What is entered in App Store Connect for the iOS app (app id 6821409701, bundle id
`app.boostline.logger`). Keep it in step with the app when features change.

## App information

| Field | Value |
|---|---|
| Name | Boostline |
| Subtitle | Data logger for BMW engines |
| Category | Utilities |
| Content rights | See the note under Review |
| Age rating | 4+ (no objectionable content, no web browser, no user-generated content) |
| Privacy policy URL | https://clucraft.github.io/boostline-site/privacy.html |

## Pricing and availability

Free. Every country and region except the 27 EU member states (Austria, Belgium, Bulgaria,
Croatia, Cyprus, Czechia, Denmark, Estonia, Finland, France, Germany, Greece, Hungary, Ireland,
Italy, Latvia, Lithuania, Luxembourg, Malta, the Netherlands, Poland, Portugal, Romania,
Slovakia, Slovenia, Spain, Sweden). The EU needs a public trader address and phone number
under the Digital Services Act.

## App privacy

**Data Not Collected.** The app has no accounts, analytics or ads. Logs stay on the device. The
only internet connection is the optional BMW data download from GitHub, which sends nothing
but the request itself.

## Version page

| Field | Value |
|---|---|
| Support URL | https://clucraft.github.io/boostline-site/support.html |
| Marketing URL | https://clucraft.github.io/boostline-site/ |
| Keywords | `obd,obd2,datalog,logger,dyno,boost,tuning,ecu,drag,0-60,lambda,turbo,b58,s58,s55,n55,n54,gauges` |
| Copyright | 2026 + the account holder's name |

Promotional text:

> Live data, logging, road dyno and drag timing for your BMW. Free, with no ads, no accounts and no tracking.

Description:

```text
Boostline turns your iPhone or iPad into a data logger for your BMW. Plug an MHD or bootmod3 WiFi adapter into the OBD port, join its WiFi network and see what your engine is doing, live.

LIVE
• A dashboard of value tiles: engine speed, boost, lambda, rail pressure, timing, temperatures and more
• Actual and target side by side, with a bar that shows how far apart they are
• Live graphs with touch controls: drag to read values, pinch to zoom

LOGS
• Capture a log with one tap
• Logs are CSV files in the Files app, ready to share with your tuner

ANALYZE
• Graphs with the full-throttle pulls found for you
• Compare two logs
• Heatmaps of boost, lambda, rail pressure and timing against engine speed and load

ROAD DYNO
• Estimated engine and wheel power and torque from a pull
• Uses your car's weight, drivetrain loss and the weather
• Save runs and overlay them

DRAG TIMING
• 0–100 km/h, 0–60 mph, 100–200 km/h, 60–130 mph, 1/8 and 1/4 mile
• Splits and gear changes
• Calibrate the car's speed reading against GPS

BMW DME DATA
Import BMW's engine measurement tables once (a free download from the open-source bmw-unified-db project) for boost target, wastegate position, per-cylinder timing and knock, VANOS and hundreds more channels on B38, B48, B58, S58, S55, N55, N20, N54, N63 and S63 engines. Without it, Boostline reads the standard OBD-II channels.

WHAT YOU NEED
• A BMW with an MHD WiFi adapter or a bootmod3 WiFi adapter
• An internet connection once, to download the BMW data (about 130 MB)

READ-ONLY AND PRIVATE
Boostline only reads data. It doesn't flash, code or change anything in the car. No accounts, no ads, no tracking: your logs stay on your device.

Dyno and drag runs belong on a closed course or a dyno, never on public roads. Road-dyno figures are estimates, not dynamometer measurements.

Boostline is not affiliated with or endorsed by BMW AG, MHD or bootmod3.
```

## Screenshots

Made with the simulator from the mobile web build at the exact device sizes (see the
`appstore-shoot` script in the 0.6.0 work):

- iPhone 6.9" (1320 × 2868): Live, live graphs, Dyno, Drag, Analyze.
- iPad 13" (2752 × 2064, landscape): Live, Dyno, Drag, Analyze.

## Review

Sign-in required: no.

Notes for the reviewer:

```text
Boostline reads live engine data from BMW cars through a WiFi diagnostic adapter (MHD or bootmod3) plugged into the car's OBD port. Without a car, every feature can be tried with the built-in simulator, which is selected on first launch:

1. Tap "Connect · Simulator" in the top bar. Live data starts streaming (a simulated engine doing repeated full-throttle pulls).
2. Live tab: value tiles and live graphs. Tap the red record button in the top bar ("Start capture" on iPad) to record a log; tap the recording timer to stop it.
3. Dyno tab: tap "Arm run" and confirm the one-time "Closed courses only" notice. A pull is captured within about 30 seconds and shows power and torque.
4. Drag tab: tap "Arm run". A 0-100 km/h run finishes within about 20 seconds.
5. Analyze tab: open the captured log for graphs and heatmaps.

The app only reads data from the car and never changes anything in it. The local network permission is needed to reach the adapter on its WiFi network. "Download & import" in Settings > BMW DME data is optional; it downloads a public data file (about 130 MB) from the bmw-unified-db project on GitHub.
```

Content rights: the app downloads the bmw-unified-db data only when the user asks for it; it
is not bundled. How to answer Apple's third-party content question is the account holder's
decision.
