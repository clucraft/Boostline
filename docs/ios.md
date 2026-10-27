# Boostline for iPhone and iPad

The iOS app is the same Boostline: the same screens, the same connection and protocol code,
and the same dyno, drag and heatmap analysis. On an iPhone it has a tab bar at the bottom in
portrait and a compact side rail in landscape; on an iPad it keeps the side rail, and in
landscape it has the same layout as the desktop.

On an **iPhone Duo** it fills both screens. Unfolded (held sideways), the page splits into two
halves at the fold: the Live tiles beside the live graphs, the Dyno and Drag results beside the
setup and saved runs, and a slim log list beside the graphs on Analyze. Larger iPhones on their
side get the same two halves, with more room for the results.

## Status

Version 0.6.0 is submitted to the App Store (iPhone and iPad; not offered in the EU for now).
Builds also go to TestFlight.

Checked automatically on every pull request that touches the app (GitHub workflow **iOS**), in
the iPhone Duo and iPhone 18 Pro Simulators:

- The app builds (Xcode 27.1, iOS 27.1 SDK) and starts.
- It connects over TCP, through the native Swift socket code, to the fake BMW gateway used by
  the unit tests: identifies the car, streams at about 45 Hz and saves a CSV log with real values.
- **Download & import** of the BMW DME data works on the phone: 130 MB download, checksum,
  unpack, import (26 engine ECUs, 12,541 measurements in about 5 seconds).

Tested on a real car (2026-10-10): an iPhone with the TestFlight build connected through the
MHD WiFi adapter and showed live data. Not checked yet: the bootmod3 adapter and the ENET cable.

## What works and what's different

| | iPhone / iPad |
|---|---|
| Simulator, Live, Analyze, Dyno, Drag, Settings | Yes |
| MHD WiFi adapter | Works (tested on a car) |
| bootmod3 WiFi adapter | Built in, not yet tested on a car |
| ENET cable | Needs a USB-C Ethernet adapter on the phone. Untested. |
| Finding the adapter | iOS doesn't allow the broadcast that finds the gateway on a desktop, so Boostline tries the likely adapter addresses instead (the WiFi network's x.x.x.1 and common defaults). If that fails, enter the adapter's IP in **Settings → Connection → Gateway IP**. |
| Logs, dyno and drag runs | Saved in the **Files** app under **On My iPhone › Boostline** (folders `Logs`, `Dyno`, `Drag`, `Exports`). |
| CSV / PNG exports | Saved to `Exports` (CSV pulls go to `Logs`). |
| BMW DME data | **Settings → BMW DME data → Download & import** (about 130 MB). Do this on a WiFi network with internet *before* going to the car: the adapter's WiFi has no internet. **Import file…** also works with a `bmw.sqlite.gz` in the Files app. |
| Background | iOS pauses apps in the background, so keep Boostline on screen while logging. It keeps the screen awake while connected. |
| Graph controls | Drag a finger across a graph to read values, pinch to zoom, double-tap to reset, long-press for the graph menu. |

The first time you connect, iOS asks to let Boostline find devices on your local network.
Tap **Allow**: without it the adapter can't be reached (you can change it later in iOS
**Settings → Privacy & Security → Local Network**).

## Installing it on your iPhone

Apple only lets apps onto an iPhone through Xcode on a Mac, TestFlight, or the App Store.
Pick one:

### Option A: a Mac with Xcode (free)

You need a Mac with Xcode 16 or newer and a free Apple ID. Apps installed this way expire
after 7 days (just run it from Xcode again).

1. Install Node.js 22 or newer, then in the repository:

   ```bash
   npm ci
   npm run mobile:sync
   ```

2. Open `ios/App/App.xcodeproj` in Xcode.
3. Select the **App** target → **Signing & Capabilities** → choose your **Team** (your Apple ID).
   If Xcode says the bundle ID is taken, change `app.boostline.logger` to something unique.
4. Connect the iPhone with a cable, select it at the top of Xcode, and press **Run**.
5. On the iPhone: **Settings → General → VPN & Device Management** → trust your developer
   certificate, and turn on **Developer Mode** if iOS asks.

### Option B: TestFlight (set up)

The GitHub workflow **TestFlight** builds the app, has Apple sign it (cloud-managed
certificates, through an App Store Connect API key) and uploads it to App Store Connect. It
runs when a tag like `ios-v0.6.0-1` is pushed. The app version comes from `package.json` (the
tag must match it) and the build number is the workflow's run number.

It uses four repository secrets: `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID` and
`ASC_KEY_P8` (the contents of the App Store Connect API key file, Admin access). After Apple
has processed a build (10–30 minutes), it appears in the **TestFlight** app on the phones of
the testers in the app's **Internal Testing** group.

## Developing

| Command | What it does |
|---|---|
| `npm run mobile:dev` | Runs the mobile UI in a browser at http://localhost:5199 (the simulator works; real adapters need the app) |
| `npm run mobile:build` | Builds the web bundle into `dist-mobile/` |
| `npm run mobile:sync` | Builds and copies it into the iOS project (`npx cap sync ios`) |

Where the code is:

```text
src/core/              Connection, protocols, recorder, BMW data import (shared with the desktop)
src/mobile/            The app API in-process, the native-socket runtime, phone layout (mobile.css)
native/boostline-native/  Swift: TCP sockets (Network.framework) and the BMW data download/SQLite
ios/                   The Xcode project (generated by Capacitor, plus icon, launch image and Info.plist)
```

The GitHub workflow **iOS** compiles the app (unsigned, for the simulator) and runs it against
the fake gateway on every pull request that touches it.

Layout checks on Windows or a Mac, with the mobile dev server running (`npm run mobile:dev`):

| Command | What it does |
|---|---|
| `W=466 H=678 OUTDIR=duo npx electron scripts/checks/mobile-walkthrough.cjs` | Walks through every screen at that size (in points) and checks the layout; screenshots and results in `.checks/duo/` |
| `W=402 H=874 DPR=3 OUTDIR=iphone npx electron scripts/checks/mobile-screens.cjs` | App Store style screenshots at that exact size, in `.checks/screens/iphone/` |
| `npm run build && npx electron scripts/checks/desktop-e2e.cjs` | The desktop app's end-to-end check (120 checks), in `.checks/desktop/` |

iPhone Duo sizes, in points (estimated: Apple doesn't publish them; the iOS workflow's
smoke.json records the real ones): folded 466 × 678, unfolded 890 × 626 (held sideways).
