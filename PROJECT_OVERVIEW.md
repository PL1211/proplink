# BuildingConnect project overview and implementation plan

BuildingConnect is a building-maintenance prototype for two scale models, an office and a data center. A shared Arduino UNO Q observes conditions and drives demonstration equipment. The software turns selected sensor anomalies into incidents, helps the owner understand what happened, requests approval for a technician visit, and records whether the repair worked. The strongest demo is a complete maintenance loop for the office lighting, followed by a shorter data-center IR investigation that shows how the same workflow handles different evidence.

## Current state and scope

The team reports that hardware is close to completion and plans to use Supabase. This checkout contains five local specifications and no firmware, backend, frontend, migrations, or integration code. The specifications describe intended behavior. The actual wiring, calibration, device behavior, and provider access still need confirmation from the people building those pieces.

| Spec | Role | Deliverable |
| --- | --- | --- |
| [Hardware](hardware.pdf), MVP 1 | One UNO Q serving two models | Sketch, Linux adapter, verified pin map, calibration notes, real telemetry fixture, and hardware command acknowledgments |
| [Backend](Backend.pdf), MVP 2 | Shared maintenance records and workflow | Telemetry intake, incident rules, approvals, work orders, command tracking, repair verification, and audit history |
| [Frontend](Frontend.pdf), MVP 3 | Owner dashboard | React + Vite app with Overview, Activity, and Sensor Data views, approval controls, and service progress |
| [Nemotron](Nemotron.pdf), MVP 4 | Evidence-driven investigation | A bounded tool-calling agent that can recommend monitoring, inspection, or human review and explain its uncertainty |
| [Photon](Photon.pdf), MVP 5 | Owner and technician communications | Request-specific owner messages, approved technician notification, explicit acceptance, and repair updates |

The office has a Grove light sensor, three white LEDs, and an SG90 servo that represents a fan. The data center has a flame/IR module, three green LEDs, and another SG90. Keep temperature outside the demo scope until the actual modules are confirmed. Use relative ADC counts for lighting. A low reading can show reduced illumination, while identifying a failed LED requires additional evidence. An IR alert is a sensor event that warrants review. An LED or servo acknowledgment reports the state applied by the controller in software. The dashboard should use those distinctions in its labels.

## Recommended architecture

```text
Office and data-center sensors and outputs
        ↕
UNO Q STM32 sketch ↔ Arduino Bridge ↔ Python adapter on UNO Q Linux
                                          ↕ HTTPS
React + Vite dashboard ──────────────→ Node/Express API
       ↕ Supabase Auth                   ↕
                                    Supabase Postgres
                                         ↕
                             Integration worker ──→ Nemotron
                                         └────────→ Photon messaging + SIP
```

**Use Supabase for Postgres and owner authentication. Keep the proposed Express routes as a thin API.** This keeps the hardware and dashboard contracts recognizable and gives the team a Node entry point for provider SDKs and callbacks. Replace the specified local JSON file with versioned Postgres migrations and fixtures. Use the API for initial dashboard reads and mutations, with the proposed two-second polling as a starting point. If hosted separately, deploy the API somewhere the board can reach over HTTPS on the demo network.

**Use a worker for jobs that outlive an HTTP request.** Start it when integrating Nemotron and Photon. Keep investigation progress, waiting states, and queued communications in Postgres. The worker can share the API's codebase and use the same workflow services, with a separate process entry point when needed. If the team later prefers Supabase Edge Functions, move short request handlers there when there is a reason to do so. A long-lived Photon stream or SIP process still needs a suitable host, and hosted Edge Functions have execution limits. [Supabase Edge Function limits](https://supabase.com/docs/guides/functions/limits)

**Give each caller a distinct identity.** The dashboard uses Supabase Auth, and the API verifies the session and checks owner membership for the requested building. The Python adapter uses its own revocable credential over HTTPS, scoped to its device. Derive the device identity from the credential and check the payload against it. Verify provider callbacks using the configured integration's mechanism and match replies to known sender and conversation records. Keep privileged database access and provider credentials on the server. Keep internal tables outside the exposed Data API where possible. Where tables are exposed, set explicit grants and enable row-level security. Test owner access with a second account. [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api) · [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)

## Shared contract to settle first

| Surface | Proposed contract |
| --- | --- |
| `POST /api/hardware/telemetry` | One versioned snapshot per report. Include `device_id`, `boot_id`, `sequence`, MCU uptime, adapter capture time, and `source`. Include readings for `office` and `data_center`, raw values, ADC configuration or calibration reference, normalized IR status and brief activation evidence, and commanded states. Stamp receipt time on the server. |
| `GET /api/hardware/commands` and `POST /api/hardware/commands/:id/ack` | Return device-scoped, unexpired set-state commands. Each command has an ID, building, output, and target state. Return the same ID with applied/rejected status and resulting commanded state. Make retries safe and keep superseded or expired commands from being applied after reconnect. |
| `GET /api/state` | Return building summaries, readings and timestamps, connection state, incidents, pending proposals, and work-order progress. Show whether readings are hardware or simulated and distinguish no data, stale data, and browser/API connection errors. |
| `POST /api/service-requests/:id/decision` | Accept a request ID, proposal version, and approval/decline decision from an authorized owner. The same workflow operation handles verified Photon replies. A retry of a recorded decision returns the existing result. A conflicting, expired, or superseded decision is rejected. |

Make `boot_id` identify the sequence's lifetime. If the sketch owns the sequence, an adapter-only restart should retain the same boot identity. Deduplicate by `(device_id, boot_id, sequence)`. Process repeated requests without repeating incident or communication side effects. Track the last fresh snapshot separately from historical uploads so duplicates and buffered readings cannot make the device look live. For brief IR pulses, prefer a counter or a latched event that survives retries until acknowledged. Keep hardware and replay runs separate in storage and detection, or isolate them by environment. Disable real outbound communications in the replay environment.

## Database and workflow

| Record group | Store in Postgres |
| --- | --- |
| Configuration | Buildings, owner memberships, devices, building-to-device mapping, sensor calibration, operating expectations |
| Device state | Recent telemetry, latest accepted live state, command history and acknowledgments |
| Maintenance | Incidents and supporting evidence, versioned service requests and decisions, work orders, technician findings, verification and repair cases |
| Integrations | Investigation runs, activity events, outbound actions, inbound provider event IDs, delivery references and outcomes |

- **Telemetry and incidents.** Start at roughly one report per second and trial a five-second stale threshold on the demo network. One continuous device produces about 86,400 snapshot envelopes per day at that rate. Keep a short recent history for the demo, preserve evidence on incidents separately, and index the recent history by device and timestamp. Open or update one active incident per building, sensor, and issue category. A unique constraint scoped to active incidents makes this reliable under concurrent requests. Detect office darkness only when lights are expected on and calibrated readings stay low for the configured window. Record a sustained recovery window for later verification.
- **Approvals and dispatch.** Track incident, investigation, approval, and work-order state separately. For example, a declined visit leaves the incident open. Approval should lock or conditionally update the pending proposal version and record the decision, work order, and one outbound technician-contact action in a single transaction. Give the action a unique key tied to the approved request version. The worker claims the committed action and records the provider result. If a call may have started before a timeout or crash, mark the attempt uncertain and reconcile it before retrying. Call completion and explicit technician acceptance are separate events. [Photon recovery guidance](https://photon.codes/docs/best-practices/recovery-and-state)
- **Verification and repair memory.** After a technician reports completion, keep the incident awaiting verification until sustained lighting recovery or a recorded human check supports closure. For the data center, a cleared IR input only confirms the signal cleared. Store suspected cause, technician finding, repair action, verification method, and provenance separately. Start retrieval with equipment type, issue category, and confirmed outcome. Label synthetic cases and return no match when the evidence is weak.

## Build order and exit criteria

| Phase | Work | Exit criterion |
| --- | --- | --- |
| 1. Hardware handoff and contract | Agree on the snapshot, command, acknowledgment, and error formats. Capture a replay with normal lighting, abnormal lighting, recovery, an IR pulse, and a reboot. Share the sketch and Python adapter. | Teammates can replay the same fixtures into a test receiver while hardware work finishes. |
| 2. Supabase and device connection | Create a development project and first migrations. Seed the two buildings and one device. Add authenticated telemetry, a state summary, device freshness, and the command round trip. | A real snapshot reaches Postgres and the dashboard. An LED command reaches the correct output and returns an acknowledgment. Unplugging the network makes both buildings stale and reconnecting restores fresh state. |
| 3. Office workflow with fixtures | Add calibrated rules, incidents, owner login and dashboard decisions, work orders, mock communications, technician findings, and verification. | Persistent darkness opens one incident. Declining blocks dispatch. Repeated or concurrent approvals produce one outbound action. A repair report awaits verification, then sustained recovery closes the incident. The workflow survives an API restart. |
| 4. Nemotron and Photon | In parallel with phases 1–3, run a single real Nemotron tool call and prove Photon outbound/inbound messaging and a programmatic SIP call with audible audio on the team's actual line. Then replace the mocks with the verified adapters. | Nemotron gathers relevant evidence through scoped tools and generates a proposal. Photon approval and dashboard approval use the same gate. An approved request produces one technician call attempt with explicit acceptance captured by text. |
| 5. Rehearse and add the IR case | Run the full office demo, then show an IR incident with its own evidence and inspection criteria. Rehearse failure paths with a replay and mocked provider outcomes. | The team can repeat the live office loop and clearly identify simulated evidence and mock outcomes in fallback mode. |

### Hardware handoff checklist

1. Publish the verified pin map, exact IR module model, measured output levels, and active polarity. Validate the module against the UNO Q maker-header voltage limits before connecting it. Verify both externally powered servos together, with a common ground and repeated motion during sampling. [Arduino UNO Q power specifications](https://docs.arduino.cc/tutorials/uno-q/power-specification/)
2. Log office ADC readings with the LEDs off, all on, and each LED toggled. Choose a repeatable reduction in light for the demo based on those readings. Capture a brief IR event with a verified test source or a labeled simulation.
3. Confirm Bridge operation and servo-library compatibility on the installed board package. Test predictable startup states, missed acknowledgments, restart, and reconnect. Capture the snapshots and commands from the actual board for backend and frontend fixtures. [Arduino UNO Q user manual](https://docs.arduino.cc/tutorials/uno-q/user-manual/)

### Integration risks to retire early

- **Photon line and audio.** Stable Spectrum outbound voice requires a project-owned iMessage line and a SIP application. Confirm the team's account and project mode, place a programmatic call to a teammate, and verify audible playback. A fixed spoken summary followed by an explicit text acceptance is sufficient for the first live demo. If the call is unavailable, use real text if it works and label the call step as simulated. [Photon outbound calls](https://photon.codes/docs/spectrum-ts/providers/voice/outbound-calls) · [Photon webhooks](https://photon.codes/docs/spectrum-ts/webhooks)
- **Nemotron tool support.** Verify the exact endpoint, model, and tool-call response format with a small read-only tool before building orchestration. Bound each run, persist its state when it waits for a reply, and record the tools and results needed to explain the recommendation. Leave approval and dispatch authority with the backend. [NVIDIA NIM function calling](https://docs.nvidia.com/nim/large-language-models/1.15.0/function-calling.html)
- **Demo reliability.** Test from the actual Wi-Fi network. Rehearse stale telemetry, a duplicate snapshot, an expired command, an unauthorized decision, and a provider timeout. Keep the fallback replay on the same API contract so it exercises the same dashboard and workflow.

## Next work session

Have the hardware owner publish one real snapshot, the proposed v1 command and acknowledgment, and the bench-test results. Have the backend owner set up the Supabase development project and implement telemetry intake plus a minimal state endpoint against that fixture. Have the frontend owner wire the two building cards to the same state fixture. Give the integration owner the two provider smoke tests while those tasks proceed. End the session with one measurable target: a real office light reading shown with its timestamp and source in the dashboard, and the same device shown as stale when the adapter stops reporting.
