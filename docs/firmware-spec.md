# Hot Tub Controller — ESP32 Firmware Specification

*Revision 2 (2026-09-27). Revision 1 was the original bring-up spec. Changes
since then are listed in [§14](#14-revision-history); the firmware in this
repo implements this revision except where §13 says otherwise.*

## 1. Purpose and scope

This firmware runs on the in-tub controller and owns **low-level pump and
heater control, safety interlocks, temperature sensing, filter cycles, the
tub-side button, freeze protection and local status indication**. It talks
to a separate "tub service" (on a Linux server in the house) over MQTT. That
service owns scheduling, guest access, the main web UI and anything
AI/MCP-related, none of which is in scope here.

**Design principle: the firmware is not the primary safety system.**
The hardware already guarantees the two things that matter most:

- The pump's LOW and HIGH windings **cannot both be energized at once**.
  CH2 is a changeover (SPDT) contact whose COM can only connect to NC or NO,
  never both.
- The heater **cannot run without pump flow, above the hi-limit, or while the
  pump is on high speed**. K3's coil is wired in series through the pressure
  switch (PS1), the hi-limit (HL1) and the `24V_LOW` tap (live only when the
  pump relay is in its LOW position) before it reaches CH3.

The firmware's job is to use that hardware well, to fail safe on its own
errors, and to give the server (and anyone looking at the enclosure) enough
visibility to diagnose problems it can't fix itself.

## 2. Hardware reference

**Board:** Waveshare ESP32-S3-POE-ETH-8DI-8RO-C (ESP32-S3, 16 MB flash,
8 MB PSRAM), running on **Wi-Fi**. Don't enable the `ethernet:` component,
because it conflicts with `wifi:` on this board.

| Board terminal | Function | Notes |
|---|---|---|
| **CH1** | RUN | Dry contact, COM→+24 V, NO→`24V_RUN` |
| **CH2** | SELECT | Changeover: NC→`24V_LOW` (K1, pump LOW), NO→K2 (pump HIGH) |
| **CH3** | HEAT | Dry contact, COM→downstream of PS1+HL1, NO→K3 (heater) |
| **CH4** | LAMP_RED | Dry contact, COM→+24 V, NO→red 24 V panel indicator |
| **CH5** | LAMP_GREEN | Dry contact, COM→+24 V, NO→green 24 V panel indicator |
| **CH6** | BUZZER | Dry contact, COM→+24 V, NO→24 V buzzer |
| CH7–CH8 | spare | driven OFF at boot |
| **DI1** | SENSE_FLOW | `24V_LOW` after PS1. High = pump on LOW **and** flow |
| **DI2** | SENSE_TEMP | `24V_LOW` after PS1 **and** HL1. High = flow and hi-limit OK |
| **DI3** | TUB_BUTTON | +24 V through the pneumatic tub-button switch (inside the enclosure) |
| DI4–DI8 | spare | unused |
| Internal header, row 2 | 1-Wire bus | **GPIO1** data, 3V3/G power. 4.7 kΩ pull-up at the header |
| VIN | 24 V DC | Mean Well HDR-30-24 |

On-board I/O (verified against Waveshare's docs and demo code): I²C
SDA = GPIO42, SCL = GPIO41. TCA9554 relay expander @ 0x20 (EXIO1–8 = CH1–8).
PCF85063 RTC @ 0x51. DI1–DI8 = GPIO4–11 (optocoupled, active-low at the GPIO).
TF card = GPIO45/47/48, buzzer = GPIO46, RGB LED = GPIO38, BOOT = GPIO0.
**GPIO1 is not used by anything else on the board.**

**External relays** (Omron G7L-2A, 25 A): K1 = pump LOW, K2 = pump HIGH,
K3 = heater. The firmware only ever drives CH1–CH3.

**Loads (for power estimation):** pump LOW ≈ 4.4 A, HIGH ≈ 12 A, heater 12 Ω
(≈ 20 A, 4.8 kW) at 240 V.

**Sensors:** two DS18B20 on the shared 1-Wire bus: **water**, in the tub wall
at about ¾ depth and in contact with the water (so it reads the tub even with
the pump off), and **outdoor** air. They're identified by their 64-bit ROM
address, which the bus logs at boot. Use ESPHome's `one_wire:` (platform
`gpio`) plus `dallas_temp` sensors. The old `dallas:` component has been
removed from ESPHome.

## 3. Framework

**ESPHome** with the ESP-IDF framework. The relays go through `pca9554`, the
DIs through `binary_sensor: platform: gpio`, and the RTC through `pcf85063`,
with SNTP writing back to the RTC. The logic lives in `script:`, `globals:`
and a 1 s `interval:` control loop.

Wi-Fi must not reboot the device when it's down (`reboot_timeout: 0s`): the
tub has to keep running with no network.

## 4. Boot and reset behavior

- **All relay outputs (CH1–CH8) default OFF/NC** on power-up, reset, OTA and
  crash recovery, before any network connection.
- No relay is commanded by control logic within the first **5 s** of boot.
  The only exception is the boot lamp test (both lamps on for 2 s).
- The TCA9554 keeps its outputs across an ESP32 reset (it stays powered), so
  outputs hold their last state until the firmware's setup runs again. Keep
  that window short, and see §13 for safe mode.

## 5. Pump control

Pump state: `PUMP_OFF | PUMP_LOW | PUMP_HIGH`.

**Every transition goes through one script (`pump_set`), with no exceptions:**

1. Drop CH3 (heat) and CH1 (RUN).
2. Wait 100 ms so CH1's contact has opened.
3. Set CH2: NC = LOW (also used for OFF), NO = HIGH.
4. Wait at least 1 s.
5. If the target is LOW or HIGH, raise CH1.

Only this script writes CH1/CH2 after boot. A request that arrives while a
transition is in progress is rejected, and the control loop re-issues it on
its next tick.

### 5.1 Pump demand (priority, highest first)

| # | Source | Pump |
|---|---|---|
| — | Freeze protection (§8) | LOW, overrides everything |
| 1 | Quiet period (§10) | OFF |
| 2 | Tub-button session (§10) | LOW or HIGH |
| 3 | Hold (§9): PUMP_LOW / PUMP_HIGH / HEAT | LOW / HIGH / LOW |
| 4 | Filter cycle (§6.2) | LOW |
| 5 | Hold-expiry grace (30 s) | unchanged |
| 6 | Idle | OFF |

**Heater run-on:** whenever heat drops, the pump runs on LOW for at least
**60 s** (time spent on HIGH counts). This overrides OFF, including quiet mode.

## 6. Heater control

### 6.1 Thermostat

- Heat is only requested while the pump has been settled on LOW for 10 s
  (enough for PS1 to close) and no fault is latched. Hardware still has the
  final say.
- Target: the hold's `target_f` during a HEAT hold, otherwise the
  **eco temperature** (only during a filter cycle).
- Hysteresis: heat on at target − 0.5 °F, off at target + 0.5 °F (config constant).
- Heat is always dropped before any pump change.

### 6.2 Eco temperature and filter cycles

- **Eco temperature** is a user setting (web page / MQTT), 34–104 °F. At about
  34 °F it amounts to frost protection only.
- **A filter cycle starts** when there has been **no flow for the filter
  interval** (default 12 h). Flow means DI1 high on LOW, or the pump running on
  HIGH (DI1 can't see flow on HIGH). Any pump activity (a heat hold, a soak,
  run-on) therefore resets the timer.
- **A filter cycle also starts early** when the water is below eco − 0.5 °F
  and no fault is latched.
- A cycle runs the pump on LOW for the **filter length** (default 60 min) and
  heats toward eco. If eco isn't reached, the cycle extends while heating, up
  to 4 h in total.
- Filter cycles don't start during quiet, a hold or a button session. An
  active cycle pauses during quiet and resumes afterwards.
- A filter cycle started by the interval clears a latched fault, so heat is
  retried at most once per interval. Starting early (below eco) does not.

## 7. Faults and diagnostics

Evaluated only while the pump is settled on LOW (DI1/DI2 read 0 V otherwise):

| Fault | Condition |
|---|---|
| `NO_FLOW` | DI1 low |
| `OVER_TEMP` | DI1 high, DI2 low (HL1 tripped) |
| `HEATER_UNKNOWN` | CH3 on for 15 min and water rose < 0.5 °F. Suspect K3/CH3/wiring; don't guess further |
| `SENSOR_FAIL` | Heat is wanted but the water probe is missing, reads implausibly, or is stale (> 30 s) |

A fault **latches a heat lockout** until the next hold or interval filter
cycle. Faults are logged, published over MQTT and shown on the lamps (§11).
DS18B20 readings of exactly 85 °C (the power-on value) or outside −40…60 °C
are discarded.

## 8. Freeze protection (not built yet)

**Must work with no Wi-Fi and no MQTT.**

- If `outdoor_temp` (or `water_temp`, whichever is more conservative) falls
  below a threshold (config, e.g. 38 °F), force pump LOW and heat to at least
  eco, overriding quiet, idle and button OFF, for as long as the condition
  holds plus a hysteresis margin.
- If the outdoor probe is missing in freezing conditions, fail toward running
  the pump.
- Show both lamps alternating, or both solid (relay wear, see §11), while active.

## 9. Holds and MQTT

**Fail-safe is the central contract:** commands are **holds that expire**,
not standing commands.

- A hold is `{mode, target_f, hold_s}`: mode `PUMP_LOW | PUMP_HIGH | HEAT`,
  and **`hold_s` is a duration in seconds** (1 s … 4 h), counted locally. The
  firmware doesn't need a correct wall clock. The server re-sends holds to
  extend them.
- Starting a hold replaces the current one, cancels any button session or
  quiet period, and clears a latched fault.
- Expiry: heat drops immediately, and the pump keeps running for a 30 s grace
  period, then follows the lower-priority sources (filter cycle, idle).
- **Stop** (web/MQTT): cancels holds, the button session and any filter cycle,
  then enters the quiet period, so an eco filter cycle doesn't immediately
  restart the pump.
- Malformed commands, or values out of range, are ignored and logged.

**Topics (not built yet; shape to keep):**

```
hottub/<unit>/state    (published, retained, ~every 30 s or on change)
  { "water_temp_f": 101.2, "outdoor_temp_f": 44.0,
    "pump": "LOW", "heater": true, "fault": "NONE",
    "activity": "HOLD_HEAT", "hold_remaining_s": 3120,
    "target_f": 102.0, "eco_f": 85.0,
    "power_w": 5856, "energy_today_kwh": 12.4, "energy_total_kwh": 311.2,
    "uptime_s": 3600, "rssi": -58 }

hottub/<unit>/command  (subscribed)
  { "mode": "HEAT", "target_f": 102.0, "hold_s": 3600 }
  { "mode": "STOP" }
```

- On MQTT disconnect: drop the current hold as if it had expired. Filter
  cycles, eco and freeze protection keep running locally.
- Republish full state on reconnect.

### 9.1 Keep warm (deliberate exception to expiring holds)

`keep_warm` (switch) + `keep_warm_f` (number), both restored across reboots:
while on, the idle maintenance temperature is `keep_warm_f` instead of eco, so
a heating cycle starts whenever the water is below it and runs until reached
(no 4 h cap). The pump does not run continuously. It is a local, explicit
choice ("we're here this week"), not a server command, so it does not expire;
Stop turns it off, quiet pauses it. API action `keep_warm(enable, target_f)`.

### 9.2 Eco mode (admin)

`eco_mode` (switch) + `eco_after` (2/4/8/12/24 h, default 4 h). When on, a set
temperature (Keep warm) falls back to eco after `eco_after`; the countdown
restarts whenever a temperature is set, is saved to flash (a reboot neither
resets nor ends it), and is published as `eco_countdown` (seconds). When off,
a set temperature holds until changed or Stop. Detecting "a temperature was
set" is done by edge detection in the control loop, not restore callbacks, so
boot-time restores don't restart the countdown.

## 10. Tub button and quiet mode

A pneumatic (air) button on the tub top drives a switch **inside the
enclosure** (air tube through a gland), which switches +24 V to **DI3**.

| Jets when pressed | Result |
|---|---|
| off | jets **on** (pump HIGH) for the jets session |
| on | jets **off**: straight back to normal heating |

- Presses are judged against where the pump is heading, so two quick presses
  can't double-toggle. 400 ms debounce.
- **Button session:** 30 min by default (setting). Pressing again restarts it.
  When it ends, the pump follows whatever is underneath (hold, filter or idle).
- **Quiet period:** everything off for 10 min by default (setting), **even
  during a HEAT hold**. PUMP_LOW/PUMP_HIGH holds are cancelled. HEAT holds and
  filter cycles resume when quiet ends. A press during quiet starts LOW and
  ends quiet. Heater run-on and freeze protection still override quiet.
- Switch type is a setting: **momentary** (act on press) or **latching** (act
  on every change of state). The installed switch is **latching**.
- Turning jets off (button, web app or API) goes straight back to normal
  heating, as does a session timing out. Quiet is a separate action.

## 11. Indicator lamps and buzzer

Two 24 V panel indicators on the side of the enclosure, red (CH4) and green
(CH5). They're for diagnostics at a distance, e.g. confirming from the house
that an iPad command reached the tub. Because they're switched by mechanical
relays (about 10⁷ operations), **continuous states are solid and blinks are
rare events**:

| Lamps | Meaning |
|---|---|
| both on 2 s | lamp test at boot |
| green solid | pump running |
| green 3 quick flashes | command received (hold, Stop, tub button) |
| green goes off 1 s every 30 s | heater on |
| red solid | fault latched (which one is on the web page / MQTT) |
| red blinks 1 s every 60 s | Wi-Fi down (control still works) |

**Buzzer (CH6)**, events only, mutable with the "Buzzer enabled" setting:

| Sound | Meaning |
|---|---|
| 1 short | tub button → LOW (also a chirp at boot) |
| 2 short | tub button → HIGH |
| 1 long | tub button → quiet |
| 3 short | fault latched |

Remote commands (web/MQTT) don't beep, so nobody in the tub is startled.

## 12. Local web page

`http://hottub.local/`, with digest authentication.

- **Control:** mode, target, duration, Start, Stop, Filter now
- **Status:** water and outdoor temperature, activity, active hold, time left, pump, heat
  requested, fault
- **Relays and inputs:** CH1–CH3, DI1–DI3
- **Power:** estimated power, energy today, energy total. Estimated from relay
  state: pump LOW 1056 W, HIGH 2880 W, heater 4800 W counted only while CH3 is
  on **and** DI2 is high.
- **Settings:** water probe (A or B; the other is outdoor), eco temperature, filter interval and length, button session,
  quiet period, button type
- **Diagnostics:** Wi-Fi RSSI, uptime, raw Probe A/B readings, 1-Wire
  devices found at boot, "Simulate tub button"

Holds started from the page go through the same path as MQTT holds.

## 13. Open items

- Build MQTT (§9) and freeze protection (§8). Decide whether outdoor or water
  temperature drives freeze protection.
- Confirm the tub button type (momentary vs latching).
- Bench-verify the heat path, run-on, eco heating, `OVER_TEMP` and
  `HEATER_UNKNOWN` (needs 24 V on DI1/DI2), then everything with real loads.
- **Safe mode:** after repeated boot failures ESPHome boots into a minimal
  safe mode that doesn't set up the relay expander, so a relay latched before
  the crash could stay on. Handle this explicitly.
- Confirm final values for the thresholds and timings (all are config constants).

## 14. Revision history

**2026-10-08**
- Tub button and web Jets are a simple on/off; jets off returns to heating.
- Eco mode (§9.2): set temperatures fall back to eco after a chosen period.
- Keep warm (§9.1). Power estimate calibrated against the house panel's
  circuit meter: pump LOW 515 W, heater 5140 W.

**Revision 2 (2026-09-27)**
- Holds are **durations** (`hold_s`), not `hold_until` timestamps.
- Added eco temperature (user setting) and **filter cycles** (§6.2).
- Added the **tub air button** on DI3 and **quiet mode** (§10).
- Added **indicator lamps** on CH4/CH5 and a **buzzer** on CH6 (§11).
- Added heater run-on (60 s), hold-expiry grace (30 s), `SENSOR_FAIL`, fault
  latching, and Stop ending in quiet.
- Added power/energy estimation and the local web page (§12).
- Pump sequencing waits 100 ms between dropping CH1 and moving CH2.
- Confirmed GPIO1 is free and I²C is on GPIO42/41. Replaced `dallas:` with
  `one_wire:` + `dallas_temp`.
- Wi-Fi must never reboot the device.
- Removed the optional CT clamp from the hardware.
