# Reply to App Review (Guideline 2.1 – Information Needed)

Draft for the reply in App Store Connect, and for the Notes field of App Review Information.
The screen recording goes with it as an attachment.

---

Hello, and thank you for the review. Here is the information you asked for. A screen recording
from an iPhone is attached.

1. SCREEN RECORDING
Attached. It starts with launching the app on an iPhone and shows the typical flow: connecting
to the built-in simulator, live data, capturing a log, a dyno run and a drag run, analyzing the
log, settings, and connecting to a real BMW through a WiFi OBD adapter. The app has no account
registration or login, no user-generated content and no paid content.

2. PURPOSE AND AUDIENCE
Boostline is a data logger for BMW cars, for owners and enthusiasts, many of whom have their
engine tuned. It shows what the engine is doing in real time (engine speed, boost pressure and
target, air/fuel ratio, fuel pressure, ignition timing, temperatures), records it to CSV log
files that owners share with their tuner, and analyzes those logs (graphs, full-throttle pulls,
heatmaps, an estimated road dyno and acceleration timing). This helps owners check that the
engine runs safely and spot problems early. The app is free, has no accounts, ads or tracking,
and keeps all data on the device.

3. SETUP AND MAIN FEATURES
No login is needed.
Without a car (for review): the built-in Simulator is selected on first launch. Tap
"Connect · Simulator" in the top bar; live data starts. Tap the red record button to capture a
log and tap the timer to stop. Dyno tab: "Arm run", confirm the one-time "Closed courses only"
notice; a pull is captured within about 30 seconds. Drag tab: "Arm run"; a 0–100 km/h run
finishes within about 20 seconds. Analyze tab: open the captured log for graphs and heatmaps.
No sample files are needed; the simulator creates them.
With a car: plug a WiFi OBD adapter (MHD or bootmod3) into the car's OBD port and switch the
ignition on, join the adapter's WiFi network, choose the adapter in Settings › Connection, tap
Connect and allow local network access.

4. EXTERNAL SERVICES
- The car's diagnostic adapter on the local network (MHD or bootmod3 WiFi adapter, or BMW's ENET
  cable). The app talks to it directly over the local network using BMW's diagnostic protocol
  (HSFZ, TCP port 6801) and read-only UDS (ISO 14229) requests. It never writes to the car.
- GitHub, only when the user taps "Download & import" in Settings › BMW DME data: the app
  downloads the latest release file of the open-source bmw-unified-db project and its checksum.
No authentication services, payment processors, analytics, advertising or AI services.

5. REGIONAL DIFFERENCES
The app works the same in every region where it is offered. Units (metric or imperial) are a
user setting. It is not offered in the European Union storefronts.

6. REGULATED INDUSTRY AND THIRD-PARTY MATERIAL
The app is not in a regulated industry. It does not include or redistribute any third-party
material: it ships with the standard OBD-II channel definitions (SAE J1979, a public standard).
Optionally, when the user asks for it, it downloads the publicly available open-source
bmw-unified-db database from GitHub, which describes the measurements BMW engine computers
report. The app uses it only to name and scale the values the user's own car sends. Boostline is
not affiliated with BMW.
