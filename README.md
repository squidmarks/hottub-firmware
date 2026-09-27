# Hot tub controller firmware

ESPHome firmware for a DIY hot tub controller built on a
**Waveshare ESP32-S3-POE-ETH-8DI-8RO-C**. It runs a two-speed pump and a
4.8 kW heater through external 25 A relays, handles thermostat control,
interlock diagnostics and power estimates, and serves a local web page.
Scheduling, guest access and the rest of the "tub service" run on a separate
server and will talk to this firmware over MQTT (not built yet).

> ⚠️ This controls 240 V loads and water that people sit in. The hardware
> interlocks are the primary safety system; this firmware is not. Use at your
> own risk.

## Safety model

The firmware is designed to be a well-behaved user of hardware that is
already safe on its own:

- **Pump LOW and HIGH can't both be energized.** CH2 is a changeover contact
  that feeds either the LOW coil (K1) or the HIGH coil (K2), never both.
- **The heater can't run without flow, above the hi-limit, or on pump HIGH.**
  K3's coil is fed from the pump-LOW supply through the pressure switch (PS1),
  the hi-limit (HL1) and then CH3. The firmware asking for heat is necessary
  but not sufficient.

On top of that, the firmware:

- forces every relay OFF at boot and sends no relay commands for the first 5 s
- changes pump speed only through one script: drop RUN, set SELECT, wait 1 s,
  raise RUN
- runs everything as **time-bounded holds**. When a hold runs out, the tub
  reverts to idle on its own, so no command stands forever.
- never reboots because Wi-Fi is down, and keeps working with no network at all

## Hardware map

| Board | Function |
|---|---|
| CH1 | RUN: 24 V to the pump coils |
| CH2 | SELECT: NC = pump LOW (K1), NO = pump HIGH (K2) |
| CH3 | HEAT: heater coil (K3), fed via PS1 + HL1 |
| DI1 | SENSE_FLOW: high = pump on LOW and PS1 closed |
| DI2 | SENSE_TEMP: high = flow present and HL1 not tripped |
| GPIO1 | 1-Wire bus, DS18B20 probes (4.7 kΩ pull-up at the header) |
| I²C (GPIO42/41) | TCA9554 relay expander @ 0x20, PCF85063 RTC @ 0x51 |

Wi-Fi only. Don't enable `ethernet:`, because it conflicts with Wi-Fi on this board.

## Layout

```
hottub.yaml            main config + all tunable constants (substitutions)
packages/
  network.yaml         Wi-Fi, logging, OTA, web server
  board.yaml           I²C, relays (forced off), DI1/DI2, RTC + SNTP
  sensors.yaml         1-Wire bus and DS18B20 probes
  pump.yaml            pump_set: the only script that moves CH1/CH2
  control.yaml         1 s control loop: holds, thermostat, faults, web controls
  power.yaml           estimated power and energy
secrets.example.yaml   template for secrets.yaml (gitignored)
```

## Getting started

```bash
pipx install esphome
cp secrets.example.yaml secrets.yaml   # then fill in real values
esphome run hottub.yaml                # first flash over USB
```

After the first flash, updates can go over Wi-Fi:

```bash
esphome upload hottub.yaml --device hottub.local
```

Network log streaming isn't enabled (no native API yet), so read logs over USB:
`esphome logs hottub.yaml --device /dev/cu.usbmodem*`.

## Web page

`http://hottub.local/`, protected by digest auth (`web_username` /
`web_password` in `secrets.yaml`).

- **Control:** Mode (Off / Pump Low / Pump High / Heat), target temperature
  (60–104 °F), duration (1–240 min), Start, Stop. Heat means pump LOW plus the
  thermostat.
- **Status:** water temperature, active hold, time remaining, pump state, heat
  requested, fault
- **Relays and inputs:** CH1–CH3 and DI1/DI2 live states
- **Power:** estimated power, energy today, energy total

## Control behavior

- **Holds:** starting a hold runs the chosen mode for the chosen duration.
  Starting a new hold replaces the current one and clears any latched fault.
- **Hold expiry:** heat drops immediately, and the pump keeps running for a 30 s
  grace period before going OFF. **Stop** skips the grace period.
- **Heater run-on:** whenever heat drops, the pump keeps running on LOW for 60 s.
- **Thermostat:** heat comes on at target − 0.5 °F and goes off at target + 0.5 °F.
  Heat is only requested once the pump has been on LOW for 10 s.
- **Faults** latch a heat lockout until the next hold:

  | Fault | Condition |
  |---|---|
  | `NO_FLOW` | pump settled on LOW, DI1 low |
  | `OVER_TEMP` | pump settled on LOW, DI1 high, DI2 low |
  | `HEATER_UNKNOWN` | heat on 15 min, water rose < 0.5 °F (suspect K3/CH3/wiring) |
  | `SENSOR_FAIL` | Heat mode and the water probe is missing or stale (> 30 s) |

- **Power** is estimated from relay state, not measured: pump LOW 1056 W
  (4.4 A), HIGH 2880 W (12 A), heater 4800 W (12 Ω at 240 V). The heater only
  counts while CH3 is on and DI2 is high.

All timings and limits are substitutions at the top of `hottub.yaml`.

## Status

**Bench-verified** (no loads connected):
- relays off at boot
- pump sequencing for LOW / HIGH / OFF, including LOW→HIGH directly
- hold start, stop and expiry with the 30 s grace
- `NO_FLOW` detection and heat lockout
- 1-Wire probe discovery
- web auth

**Not yet verified:**
- heater on/off path, run-on and `HEATER_UNKNOWN` (needs 24 V on DI1/DI2)
- `OVER_TEMP`
- everything with real loads (spec bench test 8)

## Roadmap

- [ ] MQTT integration with the tub service (`hottub/<unit>/state` and
      `/command`, holds as `hold_s` durations, publishing power and energy too)
- [ ] Second DS18B20 (outdoor) and choosing water/outdoor probe roles from the web page
- [ ] Freeze protection: forces pump LOW and heat below a threshold, works with
      no network
- [ ] Decide on an idle eco setpoint (currently idle means no heat)
- [ ] Handle ESPHome safe mode: the relay expander keeps its outputs across an
      ESP32 reset, so a boot loop could leave a relay latched
