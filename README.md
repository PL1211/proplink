# BuildingConnect

BuildingConnect is a React dashboard and Express API for monitoring the office and data-center models and tracking maintenance. The local demo uses simulated UNO Q snapshots and a persistent embedded Postgres database. The Supabase mode uses the same SQL schema and workflow with Supabase Postgres and Auth.

The office dashboard shows ambient light, temperature sensor readings, and fan status. The data center shows flame sensor status, temperature sensor readings, and fan status. The dashboard monitors the equipment; it does not send LED or fan commands.

## Run the local demo

Use Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

Open [the local dashboard](http://127.0.0.1:5173/). The first launch seeds the office with a pending low-light incident. Review the request, approve the visit, simulate contact and acceptance, and record repair findings. Open **Demo controls** and restore office lighting. After several seconds of in-range readings, select **Verify with readings**. You can also trigger an IR incident or pause the controller to see both buildings become stale.

The demo stores progress in `.data/demo` and binds to loopback. To start another scenario without losing existing demo data, set `DEMO_DB_PATH` to a new directory under `.data/`. For a production-style local build, use `npm run build` followed by `npm start`.

## Connect a Supabase development project

1. Apply the migration under `supabase/migrations/` to the intended development database. The migration creates the private `bc` schema and seeds the two buildings and their shared device. The [BuildingConnect Supabase project](https://supabase.com/dashboard/project/epsdkfzwlyxyzjegamxn) already has migration `20261108074434` applied. For a fresh project, use a linked Supabase CLI project to track deployment. [Supabase CLI local development](https://supabase.com/docs/guides/local-development/cli/getting-started)
2. Create a test owner in Supabase Auth using email and password. Add building memberships using that user's UUID in the SQL Editor. Use a separate account to check the scope of building access.

   ```sql
   insert into bc.memberships (user_id, building_id)
   values ('<owner-auth-user-uuid>', 'office'),
          ('<owner-auth-user-uuid>', 'data_center');
   ```

3. Copy `.env.example` to `.env` if it doesn't exist, set `APP_MODE=supabase`, and fill in `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `DEVICE_TOKEN`. On IPv4-only networks, copy the **Session pooler** connection string from the project's **Connect** dialog. Use a database role that can access the private `bc` schema. Keep the database URL and device credential on the server. The browser receives only the project URL and publishable key. [Supabase connection options](https://supabase.com/docs/guides/database/connecting-to-postgres)
4. Start the app and sign in. The hosted view starts with no telemetry. Configure the office `bc.buildings.light_min_ratio` using real bench calibration before expecting automatic low-light detection. The default `null` leaves that rule disabled. Set `lights_expected_on` to false during periods when office lighting is intentionally off.

In Supabase mode, an authorized owner can manually record technician contact and acceptance. The app records one queued contact action after approval. Live dispatch and automated technician updates require the future communications integration.

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
