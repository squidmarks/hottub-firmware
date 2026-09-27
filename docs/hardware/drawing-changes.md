# Drawing changes needed (2026-09-27)

For whoever maintains the source drawings. The PNGs in this folder are
exports, so these changes need to be made in the source and re-exported.
The text in `README.md` here is already updated. Firmware behavior is in
`../firmware-spec.md` (revision 2).

## 1. Sheet 1 — 240 V power

- **Remove the optional CT clamp** and its "to sheet 3" label on the heater
  leg (H1 side). It won't be used. *(Already painted out of the exported PNG
  so the repo is correct in the meantime; the source still has it.)*

## 2. Sheet 2 — 24 V DC control

Add three new circuits off the +24 V rail. All the board channels are dry
contacts, the same as CH1–CH3.

**a. Indicator lamps**
- **CH4 — LAMP_GREEN** (board relay channel 4): COM → +24 V, NO → **LP1**
  (green 24 V panel indicator) + terminal, LP1 − → 0 V.
- **CH5 — LAMP_RED** (board relay channel 5): COM → +24 V, NO → **LP2**
  (red 24 V panel indicator) + terminal, LP2 − → 0 V.
- No flyback diodes needed (lamps, not coils).

**b. Tub air button**
- **S1**, a pneumatic (air) switch mounted **inside the enclosure**: one side
  → +24 V, other side → **DI3**, with DI COM → 0 V as for DI1/DI2. Label it
  "S1 — tub air button (air tube from tub top)". Note it may be momentary or
  latching.

**c. Board block and footer text**
- Board block: change "CH1–CH3 and DI1/DI2 used, CH4–CH8 and DI3–DI8 spare"
  to **"CH1–CH5 and DI1–DI3 used, CH6–CH8 and DI4–DI8 spare"**.
- Optionally add a lamp-meaning legend (see the firmware spec §11), or
  reference it.
- The Cat5/6 wire table is **unchanged**. Neither the button nor the lamps use
  the Cat5 run.

## 3. Sheet 3 — Sensing

- No wiring change. Optionally note that the **water probe is in the tub
  wall at about ¾ depth, in contact with the water**.

## 4. Backplate layout

- Add **S1 (air switch)** in the low-voltage area, near a new gland.
- Add a gland along the bottom edge: **"G5 air-button tube"**. It's small;
  existing G4 is "sensors / IP67 vent".
- Show **LP1 (green) and LP2 (red) lamps** on the **enclosure side wall**
  (outside the backplate outline, with a note "enclosure side, visible from
  the house") and the wiring route to CH4/CH5.
- Board label: "CH1–CH3 to K1/K2/K3, top edge" → **"CH1–CH3 to K1–K3,
  CH4/CH5 to lamps, top edge"**, and "DI1/DI2, COM, DGND" → **"DI1–DI3, COM,
  DGND, bottom edge"**.

## 5. Parts key / shopping list

Already updated in `README.md`: S1 air switch and button, LP1/LP2 lamps (not L1/L2 — those are the 240 V legs),
glands 4 → 5. Carry these into the source if it has its own parts list.
