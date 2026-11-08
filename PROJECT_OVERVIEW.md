# proplink project overview

**Status as of November 8, 2026.** proplink monitors two scale models, an office and a data center, with one Arduino UNO Q. It records sensor evidence, opens maintenance incidents, asks an owner to approve a visit, and tracks work through verification. The dashboard and API are deployed on [Vercel](https://proplink-ops.vercel.app/), with Supabase for Postgres and owner sign-in. A hardware upload containing readings from both buildings is in the production database.

| MVP | Current state | Remaining work |
| --- | --- | --- |
| 1 · [Hardware](hardware.pdf) | UNO Q sketch and Python uploader report both models through Arduino Bridge and HTTPS. The LEDs stay on and both servo fan models are configured to sweep. | Verify IR polarity and capture an activation and a brief pulse. Measure office light thresholds and rehearse a disconnect and restart on the demo network. |
| 2 · [Backend](Backend.pdf) | Deployed Express API, private Supabase schema, authenticated telemetry, incident rules, approvals, work orders, repair records and audit timeline. | Set the production low-light threshold from bench data. Add provider adapters and durable job processing when integrating Nemotron and Photon. |
| 3 · [Frontend](Frontend.pdf) | Deployed React dashboard with Supabase sign-in, Overview, Activity, Sensor Data and interactive 3D. Physical equipment is displayed for monitoring. | Rehearse the hosted workflow with the owner account and the actual board. |
| 4 · [Nemotron](Nemotron.pdf) | Planned. The backend currently proposes inspections using built-in rules. | Prove a real tool call with the chosen model endpoint, then implement evidence gathering, recommendation and resume behavior. |
| 5 · Photon iMessage | Implemented locally. Signed replies use the same approval and work-order rules as the dashboard. | Verify a live iMessage round trip for owner approval and technician acceptance and reporting. |

## System and data flow

```text
Office and data-center sensors
  -> UNO Q STM32 sketch -> Arduino Bridge -> Python uploader on the UNO Q
  -> HTTPS POST /api/hardware/telemetry -> Express on Vercel -> Supabase Postgres

Owner browser -> React + Vite on Vercel -> same-origin Express API
             -> Supabase Auth for sign-in

Planned: durable jobs in Postgres -> Nemotron investigation / Photon communications
```

The production board and owner browser only need internet access to reach the hosted system. They can use separate networks. Vercel serves the frontend and routes API requests to Express. The board authenticates with its device credential. The API verifies the owner's Supabase session and checks membership for the requested building. The database connection and device credential are kept outside the frontend and documentation. The local demo runs the same workflow against embedded Postgres with labeled simulated readings.

## Hardware and confirmed readings

| Building | Inputs in the sketch | Outputs in the sketch | Example from production |
| --- | --- | --- | --- |
| Office | Grove light on A0. KY-028 temperature module on A1 (analog) and D2 (digital). | White LEDs on D5, D6, D11. Servo on D9. | Light 545/1023 ADC counts. Thermistor 243 counts, about 21.1 °C / 70.0 °F. Fan reported running. |
| Data center | Flame/IR module on D4. KY-028 temperature module on A5 (analog) and D3 (digital). | Green LEDs on A2, A3, A4. Servo on D10. | Flame/IR input clear at digital level 0. Thermistor 390 counts, about 22.5 °C / 72.5 °F. Fan reported running. |

The example is a stored hardware snapshot from **November 8, 2026, at 8:44 a.m. Central**. It demonstrates successful ingest, rather than continuous board availability. Fan status reports what the controller requests from the servo. There is no RPM or motion feedback. Ambient light is relative to the ADC range. Flame/IR activation is a sensor observation that warrants inspection.

Both temperature profiles use the room display's **71.7 °F (22.1 °C)** as a reference, at **235 counts for the office** and **395 for the data center**. The backend assumes the KY-028's analog count falls as it warms and uses a nominal thermistor curve. It labels the resulting °C/°F values as estimates and shows raw counts beyond ±10 °C from the reference. The sketch's separate heat flag can trigger from a change against the startup baseline or the module's digital output. It is independent of the temperature estimate. See the [UNO Q setup and calibration guide](hardware/uno-q/README.md).

## Workflow and operating rules

1. The uploader sends one versioned snapshot for both buildings. The backend deduplicates by device, boot ID and sequence. Old and out-of-order samples cannot replace the latest reading or open an incident. Both buildings show stale data after five seconds without a fresh sample.
2. The office can open one low-light incident when the lights are expected and reported on and readings stay below the configured threshold for three seconds. The production threshold is currently unset. The local demo has a threshold and seeds a low-light incident.
3. A fresh active or briefly latched flame/IR signal can open one data-center incident. The backend records evidence and proposes inspection. Temperature is informational and does not open incidents.
4. The owner approves or declines the versioned request. Approval creates one work order and one queued contact action in a transaction. Decline leaves the issue open. The owner can then record contact, acceptance and repair findings.
5. A repair report moves the incident to awaiting verification. Fresh office light recovery must hold for three seconds to support sensor verification. The owner can record a manual check. Data-center incidents use manual verification because clearing the IR input establishes only that the signal cleared. Verified repairs are recorded for future lookup.

The main API surfaces are `POST /api/hardware/telemetry` for device writes, `GET /api/state` and `GET /api/buildings/:id/readings` for owner reads, and `POST /api/service-requests/:id/decision` and `POST /api/work-orders/:id/progress` for maintenance. Hardware command endpoints are implemented and tested in software. The current uploader and dashboard do not perform remote LED or fan control. The [repository README](README.md) gives the snapshot and device API contracts.

## Next steps and demo checks

| Priority | Work | Exit check |
| --- | --- | --- |
| 1 · Hardware and office rule | On the actual network, confirm both sensor streams, time sync, IR polarity and short-pulse capture. Record repeated office readings under normal and deliberately reduced light while the LEDs are reported on. Configure the production threshold only after those ranges are distinct. | Both buildings show a fresh sample. Stopping the uploader makes both stale and restarting restores freshness. Sustained darkness opens one office incident, and restored light qualifies for verification. |
| 2 · Rehearse the current app | Run the office maintenance loop through the dashboard. Show a data-center IR inspection separately. Use the local demo if the network or hardware is unavailable. | Approve, record contact and acceptance, enter findings, verify, and see the final timeline. A decline leaves the issue open and queues no contact. |
| 3 · Nemotron | Prove one read-only tool call on the chosen model endpoint. Scope evidence tools to an incident, record the tool trace, and persist progress when a run waits. | The model branches on real evidence, explains uncertainty, and returns an inspection recommendation for backend validation. The backend continues to own approval. |
| 4 · Photon iMessage | Run a live rehearsal on the team's configured line. Check owner approval, technician acceptance and repair reporting over iMessage. | An approval sends one work order to the technician. Replayed replies do not send it again. The technician explicitly accepts before work advances. |

The repository tests pass for membership, telemetry freshness and deduplication, concurrent approvals, declined requests, repair verification, and the software command round trip. Production checks returned HTTP 200 for the dashboard, public API configuration, and authenticated device command endpoint. Provider-specific smoke tests are part of MVPs 4 and 5.
