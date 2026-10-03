# Hot tub web app

Phone-first control page for the tub, plus an admin page for the settings
stored on the controller. Talks to the controller over the ESPHome native API
(the same encrypted connection Home Assistant uses; both can be connected).

- **Everyone** (anyone who can reach the page): water/outdoor temperature,
  what the tub is doing, heat to a temperature (60–104 °F, 1–4 h), jets
  off/low/high, quiet, stop.
- **Admin** (`/admin`, `/api/admin/*`): eco temperature, filter cycle, jets
  session and quiet lengths, which probe is water, button type, buzzer, run a
  filter cycle now, and a live diagnostic table. The reverse proxy puts these
  paths behind Google login and passes the verified email in
  `X-Auth-Request-Email` (stripping any client copy); the app also checks it
  against `ADMIN_EMAILS`.

Every command maps to the controller's own time-bounded holds and limits.

## Configuration (environment)

| Variable | |
|---|---|
| `CONTROLLER_HOST` | controller address (give it a DHCP reservation) |
| `CONTROLLER_API_KEY` | `api_encryption_key` from the firmware's `secrets.yaml` |
| `ADMIN_EMAILS` | comma-separated admin emails |
| `GUEST_MAX_F`, `GUEST_MAX_MIN` | guest caps (default 104 °F, 240 min) |
| `HOTTUB_FAKE=1` | simulated tub, for UI work; also a stand-in admin, since there is no login in front |

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
HOTTUB_FAKE=1 .venv/bin/uvicorn app.main:app --port 8078
```

Deployed on `home` by the homelab repo (`hottub/`).
