import { randomUUID } from 'node:crypto';
import { deviceId } from './contracts.js';
import { acknowledgeCommand, ingest, pendingCommands } from './workflow.js';

export const demoOwner = '00000000-0000-4000-8000-000000000001';

export function demoSnapshot({ boot, sequence, captured, dark, ir, outputs }) {
  const thermistor = (raw, hot = false) => ({ raw, adc_max: 1023, unit: 'adc_counts', hot });
  return {
    schema_version: 1, device_id: deviceId, boot_id: boot, sequence, mcu_uptime_ms: sequence * 1500,
    captured_at: captured.toISOString(), source: 'simulated',
    buildings: {
      office: {
        sensors: { light: { raw: outputs.office.leds.some(Boolean) ? (dark ? 280 : 744) + sequence % 19 : 64,
          adc_max: 1023, unit: 'adc_counts' }, thermistor: thermistor(490 + sequence % 10) },
        commanded: outputs.office,
      },
      data_center: {
        sensors: { flame_ir: { digital_level: ir ? 1 : 0, ir_alert: ir, alert_seen_since_last_report: ir },
          thermistor: thermistor((ir ? 590 : 510) + sequence % 13, ir) },
        commanded: outputs.data_center,
      },
    },
  };
}

export async function createDemo(db) {
  await db.query('insert into bc.memberships select $1,id from bc.buildings on conflict do nothing', [demoOwner]);
  await db.query("update bc.buildings set light_min_ratio=0.48 where id='office'");
  const { latest } = (await db.query('select latest from bc.devices where id=$1', [deviceId])).rows[0];
  const outputs = Object.fromEntries(['office', 'data_center'].map((building) => [
    building, latest?.buildings[building].commanded ?? { leds: [true, true, true], fan: 'running' },
  ]));
  const boot = randomUUID();
  let sequence = 0;
  let dark = latest ? latest.buildings.office.sensors.light.raw < 490 && outputs.office.leds.some(Boolean) : true;
  let ir = latest?.buildings.data_center.sensors.flame_ir.ir_alert ?? false;
  let paused = false;
  let busy = false;

  async function tick(captured = new Date(), darkReading = dark, now = new Date()) {
    if (paused || busy) return;
    busy = true;
    try {
      for (const command of await pendingCommands(db, deviceId)) {
        const next = structuredClone(outputs[command.building_id]);
        if (command.output === 'fan') next.fan = command.enabled ? 'running' : 'stopped';
        else next.leds[Number(command.output.at(-1)) - 1] = command.enabled;
        try {
          await acknowledgeCommand(db, deviceId, command.id, { status: 'applied', commanded: next });
          outputs[command.building_id] = next;
        } catch (error) {
          if (error.status !== 409) throw error;
        }
      }
      await ingest(db, demoSnapshot({ boot, sequence: sequence++, captured, dark: darkReading, ir, outputs }), now);
    } finally {
      busy = false;
    }
  }

  if (!latest) {
    const start = Date.now() - 60000;
    for (let index = 0; index < 31; index++) {
      const at = new Date(start + index * 2000);
      await tick(at, index >= 25, at);
    }
  }
  await tick();
  const timer = setInterval(() => tick().catch((error) => console.error('Simulator:', error.message)), 1500);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    async apply(scenario) {
      switch (scenario) {
        case 'office-dark': dark = true; break;
        case 'office-normal': dark = false; break;
        case 'ir-alert': ir = true; break;
        case 'ir-clear': ir = false; break;
        case 'pause': paused = true; break;
        case 'resume': paused = false; break;
      }
      await tick();
    },
  };
}
