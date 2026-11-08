# proplink

proplink is a React dashboard and Express API for monitoring the office and data-center models and tracking maintenance. The local demo uses simulated UNO Q snapshots and a persistent embedded Postgres database. The Supabase mode uses the same SQL schema and workflow with Supabase Postgres and Auth.

[Open the live dashboard](https://proplink-ops.vercel.app/).

The office dashboard shows ambient light, temperature sensor readings, and fan status. The data center shows flame sensor status, temperature sensor readings, and fan status. The dashboard monitors the equipment; it does not send LED or fan commands.

See the [project overview](PROJECT_OVERVIEW.md) for the deployed architecture, verified hardware snapshot, five MVP specs, and remaining work.

## Run the local demo

Use Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

Open [the local dashboard](http://127.0.0.1:5173/). The first launch seeds the office with a pending low-light incident. Review the request, approve the visit, simulate contact and acceptance, and record repair findings. Open **Demo controls** and restore office lighting. After several seconds of in-range readings, select **Verify with readings**. You can also trigger an IR incident or pause the controller to see both buildings become stale.

The demo stores progress in `.data/demo` and binds to loopback. To start another scenario without losing existing demo data, set `DEMO_DB_PATH` to a new directory under `.data/`. For a production-style local build, use `npm run build` followed by `npm start`.

## Connect a Supabase development project

1. Apply the migration under `supabase/migrations/` to the intended development database. The migration creates the private `bc` schema and seeds the two buildings and their shared device. The [Supabase project for proplink](https://supabase.com/dashboard/project/epsdkfzwlyxyzjegamxn) already has migration `20261108074434` applied. For a fresh project, use a linked Supabase CLI project to track deployment. [Supabase CLI local development](https://supabase.com/docs/guides/local-development/cli/getting-started)
2. Create a test owner in Supabase Auth using email and password. Add building memberships using that user's UUID in the SQL Editor. Use a separate account to check the scope of building access.

   ```sql
   insert into bc.memberships (user_id, building_id)
   values ('<owner-auth-user-uuid>', 'office'),
          ('<owner-auth-user-uuid>', 'data_center');
   ```

3. Copy `.env.example` to `.env` if it doesn't exist, set `APP_MODE=supabase`, and fill in `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `DEVICE_TOKEN`. On IPv4-only networks, copy the **Session pooler** connection string from the project's **Connect** dialog. Use a database role that can access the private `bc` schema. Keep the database URL and device credential on the server. The browser receives only the project URL and publishable key. [Supabase connection options](https://supabase.com/docs/guides/database/connecting-to-postgres)
4. Start the app and sign in. A fresh project shows no data until the first telemetry upload. Leave the office light sensor uncovered with the LEDs on until the dashboard shows a learned baseline. Set `lights_expected_on` to false during periods when office lighting is intentionally off.

In Supabase mode, an authorized owner can manually record technician contact and acceptance. The app records one queued contact action after approval. Use the integration setup below to send live notifications and process technician updates.

## OpenRouter and Photon setup

Keep secrets in the ignored `.env` or your host's environment. The full list and a per-building contact example are in [`.env.example`](.env.example). Apply the new migration under `supabase/migrations/` to the test database before deploying the updated API. The API and worker must use the same database and integration configuration. The Vercel API keeps serving HTTP, while `npm run worker` runs on a machine or service that stays on. For the rehearsal, you can run the worker on a laptop using the test database connection.

1. **OpenRouter.** Set `OPENROUTER_API_KEY` and optionally `OPENROUTER_MODEL` (default `nvidia/nemotron-3-ultra-550b-a55b:free`). Run `npm run smoke:openrouter` with the key in `.env`. It uses labeled synthetic evidence, prints the tool names, and returns a recommendation. A configured API queues investigations for new hardware incidents. The model receives bounded readings, relevant verified repair notes and any answer supplied to its question. [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
2. **Spectrum iMessage.** Use a Stable Spectrum test project. Set `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET` (the `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` names also work). Add an owner and technician who agree to receive test messages. Use their **Own number** values in `PHOTON_CONTACTS`, alongside the owner’s Supabase Auth UUID. That user must already have membership in the corresponding building. For shared lines, each person uses the number in their **Texts on** column in the Messages app. Set `PHOTON_LINE_NUMBER` only for a dedicated line. Register a Native Spectrum webhook at `https://<your-test-host>/api/photon/webhook` and set its signing secret as `PHOTON_WEBHOOK_SECRET`. Set `PHOTON_ENABLED=true` in the API and worker. [Spectrum iMessage routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing) · [Spectrum webhook setup](https://photon.codes/docs/spectrum-ts/webhooks)

Jobs persist in Postgres. If an iMessage send times out after delivery was attempted, review the provider logs before sending again. The Activity timeline shows that delivery is uncertain, and the dashboard can record contact manually.

Open `/api/photon/webhook` in a browser to check whether the deployed API has Photon enabled. Photon delivers signed messages to that same URL with POST.

### Hardware and live rehearsal

Choose **Test office light** in the dashboard to replay a cover, brief shadow, or recovery without the Arduino. The simulation uses the live timing rule and leaves real incidents and messages alone.

For the live demo, leave the office sensor uncovered with the LEDs on. proplink learns a baseline from at least 15 seconds of stable fresh samples and alerts below 65% of that baseline. The baseline stays fixed through changes and restarts. Use **Relearn baseline** in the test panel to start over with the sensor uncovered.

1. Stop the uploader. Both buildings should become stale after five seconds. Restart it and verify both are fresh. Data center IR is shown for reference by default. To enable its alerts after verifying the hardware, set `MONITOR_DATA_CENTER_IR=true` on the API.
2. Shade the office sensor for more than three seconds. Verify one incident, a Nemotron assessment, and the approval message. Reply with the exact `APPROVE REQ-…` command from the message. Confirm the technician receives one iMessage with the work order and that the dashboard records the contact.
3. From the technician's configured number, send `ACCEPT WO-…`, then `REPORT WO-…` followed by the findings. Restore normal light and verify with fresh recovered readings.
4. Repeat with a new incident and `DECLINE REQ-…`. The incident stays open and no technician action is queued. Replay an already handled reply in the test environment and confirm no additional work order or send is created.

## UNO Q interface

The [UNO Q adapter](hardware/uno-q/README.md) uploads telemetry over HTTPS using `Authorization: Bearer <DEVICE_TOKEN>`. Command routes remain available for a future adapter that supports controls. `GET /api/state`, owner decisions, work-order progress, and command creation use the owner's Supabase session.

| Method and route | Contract |
| --- | --- |
| `POST /api/hardware/telemetry` | Send the snapshot below. Retries reuse `boot_id` and `sequence`. Use a new boot ID when the sequence resets. Keep the adapter clock synchronized. Samples older than five seconds may appear in history and do not update freshness or open incidents. |
| `GET /api/hardware/commands` | Returns unexpired pending commands with `id`, `building_id`, `output`, `enabled`, and `expires_at`. Output is `led_1`, `led_2`, `led_3`, or `fan`. Treat these as idempotent set-state commands. Skip expired commands. |
| `POST /api/hardware/commands/:id/ack` | Send `{"status":"applied","commanded":{"leds":[true,true,true],"fan":"running"}}` or `{"status":"rejected","error":"reason"}`. The acknowledgment is controller-reported software state. |

```json
{
  "schema_version": 1,
  "device_id": "unoq-main",
  "boot_id": "example-boot-id",
  "sequence": 42,
  "mcu_uptime_ms": 42000,
  "captured_at": "2026-11-08T14:00:00Z",
  "source": "hardware",
  "buildings": {
    "office": {
      "sensors": {
        "light": { "raw": 744, "adc_max": 1023, "unit": "adc_counts" },
        "thermistor": { "raw": 498, "adc_max": 1023, "unit": "adc_counts", "hot": false }
      },
      "commanded": { "leds": [true, true, true], "fan": "running" }
    },
    "data_center": {
      "sensors": {
        "flame_ir": { "digital_level": 0, "ir_alert": false, "alert_seen_since_last_report": false },
        "thermistor": { "raw": 512, "adc_max": 1023, "unit": "adc_counts", "hot": false }
      },
      "commanded": { "leds": [true, true, true], "fan": "stopped" }
    }
  }
}
```

Use the actual capture time, ADC maximum, and verified IR polarity. `thermistor` is optional for older firmware and carries a raw count and a controller heat flag. The backend calculates temperature estimates using the separate [KY-028 calibration profiles](hardware/uno-q/README.md#calibrate-the-ky-028-temperature-sensors), and the dashboard displays Celsius and Fahrenheit. The `commanded` fan state reflects the controller's request; the adapter has no fan speed or motion feedback. For local simulator scenarios, use the dashboard's **Demo controls**.

## Checks

```sh
npm test
npm run build
```

The automated tests exercise the migration against embedded Postgres and verify membership scope, duplicate telemetry, concurrent approval, decline, repair verification, and the device command round trip.
