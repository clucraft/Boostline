import type { ChannelDef } from '@shared/types'
import { BMW_CATALOG } from '@shared/catalog'
import type { SampleFrame, StreamHandle, VehicleAdapter, VehicleInfo } from './adapter'

// A physics-based stand-in for a real car so every screen (live data, log
// viewer, dyno, drag) can be used without hardware. Models a stage-1-ish B58
// with an 8-speed automatic running a repeating drive cycle:
//   idle → standing launch to ~190 km/h → brake → cruise in 4th → 4th-gear WOT
//   pull to the limiter → brake to a stop → repeat.

const GEARS = [0, 5.25, 3.36, 2.172, 1.72, 1.316, 1.0, 0.822, 0.64]
const FINAL_DRIVE = 3.15
const TIRE_RADIUS = 0.334 // m
const MASS = 1835 // kg incl. driver
const CDA = 0.62
const CRR = 0.012
const DRIVELINE_EFF = 0.86
const SHIFT_RPM = 6800
const STALL_RPM = 3000
const IDLE_RPM = 750
const G = 9.81
const TAU = 2 * Math.PI

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const smoothstep = (e0: number, e1: number, x: number): number => {
  const f = clamp((x - e0) / (e1 - e0), 0, 1)
  return f * f * (3 - 2 * f)
}
const noise = (amp: number): number => (Math.random() * 2 - 1) * amp

/** Piecewise-linear lookup over [x, y] breakpoints. */
function table(points: [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]
    if (x <= x1) {
      const [x0, y0] = points[i - 1]
      return lerp(y0, y1, (x - x0) / (x1 - x0))
    }
  }
  return points[points.length - 1][1]
}

const MAX_TORQUE: [number, number][] = [
  [800, 260], [1500, 430], [2000, 560], [2500, 620], [3000, 630], [4000, 630],
  [5000, 600], [5500, 565], [6000, 525], [6500, 475], [7000, 420]
]
const BOOST_CURVE: [number, number][] = [
  [800, 0.2], [1500, 0.9], [2000, 1.45], [3000, 1.52], [4500, 1.45],
  [5500, 1.32], [6500, 1.15], [7000, 1.05]
]

type Phase = 'idle' | 'launch' | 'slow' | 'cruise' | 'pull' | 'stop'

const wheelRpm = (vMs: number, gear: number): number =>
  ((vMs / TIRE_RADIUS) * GEARS[gear] * FINAL_DRIVE * 60) / TAU

/** Lowest-rpm-sensible gear for relaxed driving at a given speed. */
function cruiseGear(vMs: number): number {
  for (let g = 8; g >= 1; g--) if (wheelRpm(vMs, g) >= 1350) return g
  return 1
}

export class SimEngine {
  private phase: Phase = 'idle'
  private phaseTime = 0
  private cruiseSpeed = 45 / 3.6
  private v = 0 // m/s
  private gear = 1
  private rpm = IDLE_RPM
  private shiftTimer = 0
  private pedal = 0
  private brakeDecel = 0
  private torque = 0
  private boost = -0.45
  private throttle = 30
  private rail = 60
  private lambda = 1
  private wg = 60
  private intakeVanos = 80
  private exhaustVanos = -100
  private iat = 28
  private coolant = 91
  private oil = 104
  private trans = 78
  private egt = 380
  private slip = 0
  private knock = [0, 0, 0, 0, 0, 0]
  private readonly cylTrim = [0.3, -0.2, 0.1, -0.4, 0.2, 0]
  private readonly ambient = 20
  private readonly baro = 1.013

  /** Advance the simulation by dt seconds (internally sub-stepped). */
  step(dt: number): void {
    const sub = Math.max(1, Math.ceil(dt / 0.005))
    const h = dt / sub
    for (let i = 0; i < sub; i++) this.tick(h)
  }

  private tick(dt: number): void {
    this.drive(dt)
    const rpm = this.rpm
    const maxTq = table(MAX_TORQUE, rpm)
    const driverWish = this.pedal < 1 ? -45 : (this.pedal / 100) * maxTq
    const loadFrac = clamp(driverWish / maxTq, 0, 1)

    // Boost follows its target with an rpm-dependent spool lag.
    const boostTarget = -0.45 + (table(BOOST_CURVE, rpm) + 0.45) * smoothstep(0.35, 1, loadFrac)
    const spoolTau = lerp(0.4, 0.12, smoothstep(1800, 4000, rpm))
    this.boost += ((boostTarget - this.boost) * dt) / spoolTau

    // Available torque scales with how much of the boost target is present.
    const fullMap = this.baro + table(BOOST_CURVE, rpm)
    const avail = maxTq * clamp((this.baro + this.boost) / fullMap, 0.05, 1.03)
    let tqTarget = Math.min(driverWish, avail)
    if (this.shiftTimer > 0) tqTarget *= 0.35
    this.torque += ((tqTarget - this.torque) * dt) / 0.08

    // Vehicle longitudinal dynamics.
    const ratio = GEARS[this.gear] * FINAL_DRIVE
    let drive = (this.torque * ratio * DRIVELINE_EFF) / TIRE_RADIUS
    const traction = 1.25 * MASS * G * 0.62
    this.slip = drive > traction ? clamp(((drive - traction) / traction) * 40, 0, 15) : this.slip * 0.9
    drive = Math.min(drive, traction)
    const resist = 0.5 * 1.2 * CDA * this.v * this.v + (this.v > 0.05 ? CRR * MASS * G : 0)
    const inertia = MASS * (1.04 + 0.0005 * ratio * ratio)
    const a = (drive - resist) / inertia - this.brakeDecel
    this.v = Math.max(0, this.v + a * dt)
    if (this.v === 0 && this.pedal < 1) this.torque = Math.min(this.torque, 20)

    // Engine speed: torque converter stall at launch, locked otherwise.
    const locked = wheelRpm(this.v, this.gear)
    const floor = this.pedal > 50 && this.gear === 1 ? lerp(IDLE_RPM, STALL_RPM, smoothstep(50, 90, this.pedal)) : IDLE_RPM
    const rpmTarget = Math.max(locked, floor)
    this.rpm += ((rpmTarget - this.rpm) * dt) / 0.05
    if (this.shiftTimer > 0) this.shiftTimer -= dt

    // Slow-moving systems.
    const railTarget = lerp(60, 350, Math.pow(loadFrac, 0.8))
    this.rail += ((railTarget - this.rail) * dt) / 0.12
    const enrich = loadFrac > 0.85 ? 0.18 * smoothstep(3000, 6500, rpm) : 0
    const lambdaTarget = this.pedal < 1 && this.v > 3 ? 1.2 : 1 - enrich
    this.lambda += ((lambdaTarget - this.lambda) * dt) / 0.15
    const boostErr = boostTarget - this.boost
    const wgSteady = clamp(15 + (55 * (boostTarget + 0.4)) / 1.9 + 30 * (1 - rpm / 7000), 0, 100)
    const wgTarget = boostErr > 0.12 ? 98 : clamp(wgSteady + boostErr * 120, 0, 100)
    this.wg += ((wgTarget - this.wg) * dt) / 0.05
    const vanosIn = 75 + 40 * Math.sin((Math.PI * rpm) / 7600) * (0.4 + 0.6 * loadFrac)
    this.intakeVanos += ((vanosIn - this.intakeVanos) * dt) / 0.15
    const vanosEx = -(92 + 22 * loadFrac + 8 * smoothstep(4000, 7000, rpm))
    this.exhaustVanos += ((vanosEx - this.exhaustVanos) * dt) / 0.15
    const iatTarget = this.ambient + (loadFrac > 0.8 ? 26 : 9)
    this.iat += ((iatTarget - this.iat) * dt) / (loadFrac > 0.8 ? 14 : 45)
    this.coolant += (((loadFrac > 0.8 ? 101 : 91) - this.coolant) * dt) / 25
    this.oil += (((loadFrac > 0.8 ? 114 : 104) - this.oil) * dt) / 60
    this.trans += (((loadFrac > 0.8 ? 88 : 79) - this.trans) * dt) / 80
    const egtTarget = 340 + 620 * loadFrac * clamp(rpm / 6500, 0.3, 1)
    this.egt += ((egtTarget - this.egt) * dt) / 1.2

    // Knock: occasional single-cylinder events under load, slow recovery.
    for (let i = 0; i < 6; i++) {
      this.knock[i] = Math.min(0, this.knock[i] + 0.8 * dt)
      if (loadFrac > 0.9 && rpm > 2400 && rpm < 5200 && Math.random() < 0.06 * dt) {
        this.knock[i] = Math.max(-5, this.knock[i] - (1.5 + Math.random() * 1.5))
      }
    }
    this.lastLoadFrac = loadFrac
    this.lastDriverWish = driverWish
    this.lastBoostTarget = boostTarget
    this.lastRailTarget = railTarget
    this.lastLambdaTarget = lambdaTarget
    this.lastWgTarget = wgTarget
    this.lastVanosIn = vanosIn
    this.lastVanosEx = vanosEx
  }

  private lastLoadFrac = 0
  private lastDriverWish = 0
  private lastBoostTarget = -0.45
  private lastRailTarget = 60
  private lastLambdaTarget = 1
  private lastWgTarget = 60
  private lastVanosIn = 80
  private lastVanosEx = -100

  /** The scripted driver: sets pedal, brake and gear for the current phase. */
  private drive(dt: number): void {
    this.phaseTime += dt
    const kmh = this.v * 3.6
    const next = (p: Phase): void => {
      this.phase = p
      this.phaseTime = 0
    }
    this.brakeDecel = 0
    switch (this.phase) {
      case 'idle':
        this.pedal = 0
        this.gear = 1
        this.brakeDecel = 2
        if (this.phaseTime > 4) next('launch')
        break
      case 'launch':
        this.pedal = 100
        if (this.rpm >= SHIFT_RPM && this.gear < 8 && this.shiftTimer <= 0) this.shift(this.gear + 1)
        if (kmh >= 190) {
          this.cruiseSpeed = (40 + Math.random() * 10) / 3.6
          next('slow')
        }
        break
      case 'slow':
        this.pedal = 0
        this.brakeDecel = 4.5
        this.autoGear()
        if (this.v <= this.cruiseSpeed) next('cruise')
        break
      case 'cruise': {
        if (this.gear !== 4 && this.shiftTimer <= 0) this.shift(4)
        const ratio = GEARS[this.gear] * FINAL_DRIVE
        const resist = 0.5 * 1.2 * CDA * this.v * this.v + CRR * MASS * G
        const needed = ((resist + MASS * (this.cruiseSpeed - this.v) * 0.8) * TIRE_RADIUS) / (ratio * DRIVELINE_EFF)
        this.pedal = clamp((needed / table(MAX_TORQUE, this.rpm)) * 100, 2, 45)
        if (this.phaseTime > 5 + Math.random() * 0.02) next('pull')
        break
      }
      case 'pull':
        // Manual-mode 4th gear pull to the limiter, like a dyno run.
        this.pedal = 100
        if (this.rpm >= 6900) next('stop')
        break
      case 'stop':
        this.pedal = 0
        this.brakeDecel = 5
        this.autoGear()
        if (this.v <= 0.01) next('idle')
        break
    }
  }

  private autoGear(): void {
    const g = cruiseGear(this.v)
    if (g !== this.gear && this.shiftTimer <= 0) this.shift(g)
  }

  private shift(gear: number): void {
    this.gear = clamp(gear, 1, 8)
    this.shiftTimer = 0.18
  }

  /** Current value of every catalog channel, in catalog units. */
  snapshot(): Record<string, number> {
    const rpm = this.rpm
    const loadFrac = this.lastLoadFrac
    const tqPos = Math.max(0, this.torque)
    const maf = Math.max(16 + noise(0.5), tqPos * rpm * 0.000335 + noise(1.5))
    const mafTarget = Math.max(16, Math.max(0, this.lastDriverWish) * rpm * 0.000335)
    const maxTq = table(MAX_TORQUE, rpm)
    const ignBase = lerp(27 + 8 * (1 - loadFrac), 3 + clamp((rpm - 2000) / 4500, 0, 1) * 11, smoothstep(0.5, 1, loadFrac))
    const ignAvg = ignBase + this.knock.reduce((s, k) => s + k, 0) / 6
    const throttle = clamp(28 + loadFrac * 150, 0, 100)
    this.throttle += (throttle - this.throttle) * 0.3
    const lambda = this.lambda + noise(0.006)
    const out: Record<string, number> = {
      'engine.rpm': rpm + noise(4),
      'engine.idle_target': IDLE_RPM,
      'engine.oil_pressure': 1.4 + (rpm / 7000) * 3.1 + noise(0.03),
      'throttle.pedal': this.pedal,
      'throttle.position': this.throttle + noise(0.2),
      'throttle.target': throttle,
      'load.maf': maf,
      'load.maf_target': mafTarget,
      'load.calc': clamp((tqPos / maxTq) * 100, 0, 100),
      'load.engine': ((this.baro + this.boost) / this.baro) * 95 + noise(0.5),
      'load.engine_target': ((this.baro + this.lastBoostTarget) / this.baro) * 95,
      'load.torque.driver': this.lastDriverWish,
      'load.torque.actual': this.torque + noise(2),
      'load.torque.target': Math.min(this.lastDriverWish, maxTq),
      'load.torque.limit': maxTq * 1.02,
      'boost.actual': this.boost + noise(0.008),
      'boost.target': this.lastBoostTarget,
      'boost.map': this.baro + this.boost + noise(0.008),
      'boost.ambient': this.baro + noise(0.001),
      'boost.wg_actual': clamp(this.wg + noise(0.3), 0, 100),
      'boost.wg_target': this.lastWgTarget,
      'fuel.rail.actual': this.rail - Math.max(0, ((rpm - 6000) / 1000) * 22) * loadFrac + noise(2),
      'fuel.rail.target': this.lastRailTarget,
      'fuel.lpfp': 5.5 - (0.6 * maf) / 1300 + noise(0.04),
      'fuel.lambda.actual': lambda,
      'fuel.lambda.target': this.lastLambdaTarget,
      'fuel.stft': 0.5 + noise(2),
      'fuel.ltft': 1.6,
      'fuel.inj_time': 0.25 + ((maf / (rpm + 1)) * 26) / Math.max(0.7, this.lastLambdaTarget),
      'fuel.ethanol': 10,
      'ign.avg': ignAvg,
      'temp.intake': this.iat + noise(0.1),
      'temp.coolant': this.coolant,
      'temp.oil': this.oil,
      'temp.ambient': this.ambient,
      'temp.charge': this.iat + 2.2 + noise(0.1),
      'temp.exhaust': this.egt,
      'temp.trans': this.trans,
      'vanos.intake.actual': this.intakeVanos + noise(0.3),
      'vanos.intake.target': this.lastVanosIn,
      'vanos.exhaust.actual': this.exhaustVanos + noise(0.3),
      'vanos.exhaust.target': this.lastVanosEx,
      'vanos.valvelift': 0.3 + loadFrac * 9.5,
      'vehicle.speed': this.v * 3.6 + (this.v > 0 ? noise(0.15) : 0),
      'vehicle.gear': this.gear,
      'vehicle.wheel_slip': this.slip,
      'elec.battery': (loadFrac > 0.8 ? 14.0 : 14.3) + noise(0.03)
    }
    for (let i = 0; i < 6; i++) {
      out[`ign.cyl${i + 1}`] = ignBase + this.cylTrim[i] + this.knock[i]
      out[`knock.cyl${i + 1}`] = this.knock[i]
    }
    return out
  }
}

export class SimulatorAdapter implements VehicleAdapter {
  readonly kind = 'simulator' as const
  private engine = new SimEngine()
  private stream: { stop(): Promise<void> } | null = null

  async connect(signal?: AbortSignal): Promise<VehicleInfo> {
    await new Promise((r) => setTimeout(r, 350))
    signal?.throwIfAborted()
    return {
      label: 'Simulator',
      vin: 'BOOSTLINESIM00001',
      ecu: { address: 0x12, softwareVersion: 'SIM-B58TU-001', definitionSet: 'Simulator (BMW B58)' }
    }
  }

  channels(): ChannelDef[] {
    return BMW_CATALOG
  }

  async startStreaming(
    channelIds: string[],
    onFrame: (frame: SampleFrame) => void,
    opts?: { maxRateHz?: number }
  ): Promise<StreamHandle> {
    await this.stream?.stop()
    // Frames are produced on a fixed virtual clock and caught up on every
    // timer tick, so the rate is exact even with coarse OS timer resolution.
    const period = 1 / Math.min(opts?.maxRateHz ?? 50, 100)
    const t0 = performance.now()
    let nextT = 0
    const timer = setInterval(() => {
      const now = (performance.now() - t0) / 1000
      while (nextT <= now) {
        this.engine.step(period)
        const snap = this.engine.snapshot()
        onFrame({ t: nextT, values: channelIds.map((id) => snap[id] ?? NaN) })
        nextT += period
      }
    }, 10)
    const handle = {
      stop: async () => {
        clearInterval(timer)
        if (this.stream === handle) this.stream = null
      }
    }
    this.stream = handle
    return handle
  }

  async disconnect(): Promise<void> {
    await this.stream?.stop()
  }
}
