export const staleMs = 5000;
const sustainMs = 3000;

export function requireCondition(condition, status, message) {
  if (!condition) throw Object.assign(new Error(message), { status });
}

async function one(db, sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function activity(tx, building, incident, kind, message) {
  await tx.query('insert into bc.activity (building_id, incident_id, kind, message, created_at) values ($1,$2,$3,$4,clock_timestamp())',
    [building, incident, kind, message]);
}

async function detect(tx, building, kind, snapshot, evidence) {
  const previous = await one(tx, "select id from bc.incidents where building_id=$1 and kind=$2 and status <> 'resolved'", [building, kind]);
  if (previous) {
    await tx.query('update bc.incidents set last_seen_at=$2 where id=$1', [previous.id, snapshot.captured_at]);
    return;
  }
  const { id } = await one(tx, `
    insert into bc.incidents (building_id, kind, source, evidence, last_seen_at)
    values ($1,$2,$3,$4,$5) returning id`, [building, kind, snapshot.source, evidence, snapshot.captured_at]);
  await activity(tx, building, id, 'detected', kind === 'low_light' ? 'Unexpected low lighting detected' : 'IR sensor activation detected');
  const recommendation = kind === 'low_light'
    ? 'Inspect the office lighting circuit and confirm why illumination is below its calibrated range.'
    : 'Inspect the area and sensor to determine what triggered the IR signal.';
  await tx.query('insert into bc.service_requests (incident_id, version, recommendation) values ($1,1,$2)', [id, recommendation]);
  await activity(tx, building, id, 'proposal', 'Inspection proposed for owner approval');
}

export async function ingest(db, snapshot, now = new Date()) {
  const captured = new Date(snapshot.captured_at);
  requireCondition(captured - now <= 2000, 422, 'Device timestamp is ahead of the server clock');
  requireCondition(now - captured <= 86400000, 422, 'Reading is outside the 24-hour ingest window');
  return db.transaction(async (tx) => {
    const device = await one(tx, 'select * from bc.devices where id=$1 for update', [snapshot.device_id]);
    requireCondition(device, 404, 'Unknown device');
    const inserted = await one(tx, `
      insert into bc.telemetry (device_id, boot_id, sequence, captured_at, received_at, payload)
      values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning sequence`,
    [snapshot.device_id, snapshot.boot_id, snapshot.sequence, captured, now, snapshot]);
    if (!inserted) return { duplicate: true, current: false };
    const lastCaptured = device.captured_at && new Date(device.captured_at);
    if (now - captured >= staleMs || (lastCaptured && captured <= lastCaptured) ||
        (device.latest?.boot_id === snapshot.boot_id && snapshot.sequence <= device.latest.sequence)) {
      return { duplicate: false, current: false };
    }

    const office = await one(tx, "select light_min_ratio, lights_expected_on from bc.buildings where id='office'");
    const light = snapshot.buildings.office.sensors.light;
    const lightsOn = snapshot.buildings.office.commanded.leds.some(Boolean);
    const calibrated = office.light_min_ratio !== null && office.lights_expected_on && lightsOn;
    const dark = calibrated && light.raw / light.adc_max < Number(office.light_min_ratio);
    const continuous = lastCaptured && captured - lastCaptured <= staleMs && device.latest.boot_id === snapshot.boot_id;
    const darkSince = dark ? (continuous && device.dark_since || captured) : null;
    const recoveredSince = calibrated && !dark ? (continuous && device.light_recovered_since || captured) : null;
    await tx.query(`
      update bc.devices set latest=$2, captured_at=$3, received_at=$4, dark_since=$5, light_recovered_since=$6 where id=$1`,
    [snapshot.device_id, snapshot, captured, now, darkSince, recoveredSince]);
    if (!lastCaptured || now - lastCaptured >= staleMs) {
      for (const building of Object.keys(snapshot.buildings)) {
        await activity(tx, building, null, 'connection', lastCaptured ? 'Controller connection restored' : 'First controller snapshot received');
      }
    }
    if (darkSince && captured - new Date(darkSince) >= sustainMs) {
      await detect(tx, 'office', 'low_light', snapshot, { ...light, min_ratio: Number(office.light_min_ratio), captured_at: snapshot.captured_at });
    }
    const ir = snapshot.buildings.data_center.sensors.flame_ir;
    if (ir.ir_alert || ir.alert_seen_since_last_report) {
      await detect(tx, 'data_center', 'ir_alert', snapshot, { ...ir, captured_at: snapshot.captured_at });
    }
    if (snapshot.sequence % 60 === 0) {
      await tx.query("delete from bc.telemetry where device_id=$1 and captured_at < $2::timestamptz - interval '1 day'", [snapshot.device_id, now]);
    }
    return { duplicate: false, current: true };
  });
}

export async function recordDecision(db, owner, requestId, input) {
  return db.transaction(async (tx) => {
    const request = await one(tx, `
      select r.*, i.building_id, i.status as incident_status
      from bc.service_requests r join bc.incidents i on i.id=r.incident_id
      join bc.memberships m on m.building_id=i.building_id and m.user_id=$2
      where r.id=$1 for update of r`, [requestId, owner]);
    requireCondition(request, 404, 'Service request not found');
    requireCondition(request.version === input.version, 409, 'Proposal version has changed');
    if (request.status === input.decision) return request;
    requireCondition(request.status === 'pending' && new Date(request.expires_at) > new Date() &&
      request.incident_status === 'open', 409, 'This request is no longer awaiting a decision');
    const recorded = await one(tx, 'update bc.service_requests set status=$2, decided_at=now(), decided_by=$3 where id=$1 returning *',
      [requestId, input.decision, owner]);
    await activity(tx, request.building_id, request.incident_id, input.decision,
      input.decision === 'approved' ? 'Owner approved the technician visit' : 'Owner declined the technician visit');
    if (input.decision === 'approved') {
      const work = await one(tx, 'insert into bc.work_orders (request_id) values ($1) returning id', [requestId]);
      await tx.query('insert into bc.outbound_actions (work_order_id) values ($1)', [work.id]);
      await activity(tx, request.building_id, request.incident_id, 'queued', 'Technician contact queued');
    }
    return recorded;
  });
}

const steps = {
  contact: { before: 'queued', after: 'contacted', message: 'Technician contact recorded' },
  accept: { before: 'contacted', after: 'accepted', message: 'Technician acceptance recorded' },
  report: { before: 'accepted', after: 'repair_reported', message: 'Repair findings recorded' },
  verify: { before: 'repair_reported', after: 'verified', message: 'Repair verified and incident resolved' },
};

export async function advanceWork(db, owner, workId, action, { notes, method } = {}, demo = false) {
  const step = steps[action];
  return db.transaction(async (tx) => {
    const work = await one(tx, `
      select w.*, i.id as incident_id, i.building_id, i.kind, b.device_id
      from bc.work_orders w join bc.service_requests r on r.id=w.request_id
      join bc.incidents i on i.id=r.incident_id join bc.buildings b on b.id=i.building_id
      join bc.memberships m on m.building_id=i.building_id and m.user_id=$2
      where w.id=$1 and r.status='approved' for update of w`, [workId, owner]);
    requireCondition(work, 404, 'Work order not found');
    if (work.status === step.after) return work;
    requireCondition(work.status === step.before, 409, 'This action is unavailable at the current service stage');
    if (action === 'contact') {
      await tx.query("update bc.outbound_actions set status=$2 where work_order_id=$1", [workId, demo ? 'simulated' : 'recorded']);
    }
    if (action === 'report') {
      await tx.query("update bc.incidents set status='awaiting_verification' where id=$1", [work.incident_id]);
    }
    if (action === 'verify') {
      if (method === 'sensor') {
        const device = await one(tx, 'select captured_at, light_recovered_since from bc.devices where id=$1 for update', [work.device_id]);
        requireCondition(work.kind === 'low_light' && device?.light_recovered_since &&
          Date.now() - new Date(device.captured_at) < staleMs &&
          new Date(device.captured_at) - new Date(device.light_recovered_since) >= sustainMs,
        409, 'Wait for fresh lighting readings to remain in range, or record a manual verification.');
      }
      await tx.query('insert into bc.repair_cases (incident_id, work_order_id, verification, notes, verified_by) values ($1,$2,$3,$4,$5)',
        [work.incident_id, workId, method, notes || 'Sustained lighting recovery', owner]);
      await tx.query("update bc.incidents set status='resolved', resolved_at=now() where id=$1", [work.incident_id]);
    }
    const updated = await one(tx, 'update bc.work_orders set status=$2, findings=coalesce($3,findings) where id=$1 returning *',
      [workId, step.after, action === 'report' ? notes : null]);
    await activity(tx, work.building_id, work.incident_id, action, demo ? step.message + ' (demo)' : step.message);
    return updated;
  });
}

export async function state(db, owner, demo) {
  return db.transaction(async (tx) => {
    const buildings = (await tx.query(`
      select b.id,b.name,b.light_min_ratio,b.lights_expected_on,d.id as device_id,d.latest,d.captured_at
      from bc.buildings b join bc.devices d on d.id=b.device_id
      join bc.memberships m on m.building_id=b.id where m.user_id=$1 order by b.id desc`, [owner])).rows;
    requireCondition(buildings.length, 403, 'Your account has no assigned buildings.');
    const incidentRows = (await tx.query(`
      select i.*, r.id as request_id, r.version, r.recommendation,
        case when r.status='pending' and r.expires_at<=now() then 'expired' else r.status end as approval,
        w.id as work_id,w.status as work_status,w.findings,c.verification,c.notes as verification_notes
      from bc.incidents i join bc.memberships m on m.building_id=i.building_id
      left join lateral (select * from bc.service_requests where incident_id=i.id order by version desc limit 1) r on true
      left join bc.work_orders w on w.request_id=r.id
      left join bc.repair_cases c on c.incident_id=i.id
      where m.user_id=$1 order by (i.status='resolved'),i.opened_at desc limit 100`, [owner])).rows;
    const events = (await tx.query(`
      select a.* from bc.activity a join bc.memberships m on m.building_id=a.building_id
      where m.user_id=$1 order by a.created_at desc limit 60`, [owner])).rows;
    const commands = (await tx.query(`
      select distinct on (c.building_id,c.output) c.id,c.building_id,c.output,c.enabled,
        case when c.status='pending' and c.expires_at<=now() then 'expired' else c.status end as status
      from bc.commands c join bc.memberships m on m.building_id=c.building_id
      where m.user_id=$1 order by c.building_id,c.output,c.created_at desc,c.id desc`, [owner])).rows;
    return { demo, buildings: buildings.map(({ latest, ...building }) => ({
      ...building,
      source: latest?.source ?? null,
      reading: latest?.buildings[building.id] ?? null,
      connection: !building.captured_at ? 'no_data' : Date.now() - new Date(building.captured_at) >= staleMs ? 'stale' : 'fresh',
    })), incidents: incidentRows, activity: events, commands };
  });
}

export async function readings(db, owner, building) {
  const access = await one(db, `
    select b.device_id from bc.buildings b join bc.memberships m on m.building_id=b.id
    where b.id=$1 and m.user_id=$2`, [building, owner]);
  requireCondition(access, 404, 'Building not found');
  const { rows } = await db.query(`
    select captured_at, payload->>'source' as source, payload->'buildings'->$2->'sensors' as sensors
    from bc.telemetry where device_id=$1 and captured_at >= now() - interval '10 minutes'
    order by captured_at desc limit 300`, [access.device_id, building]);
  return rows.reverse();
}

export async function queueCommand(db, owner, input) {
  return db.transaction(async (tx) => {
    const building = await one(tx, `
      select b.device_id from bc.buildings b join bc.memberships m on m.building_id=b.id
      where b.id=$1 and m.user_id=$2 for update of b`, [input.building_id, owner]);
    requireCondition(building, 404, 'Building not found');
    await tx.query(`
      update bc.commands set status=case when expires_at<=now() then 'expired' else 'superseded' end
      where building_id=$1 and output=$2 and status='pending'`, [input.building_id, input.output]);
    return one(tx, 'insert into bc.commands (building_id,device_id,output,enabled) values ($1,$2,$3,$4) returning *',
      [input.building_id, building.device_id, input.output, input.enabled]);
  });
}

export async function pendingCommands(db, device) {
  return (await db.query(`
    select id,building_id,output,enabled,expires_at from bc.commands
    where device_id=$1 and status='pending' and expires_at>now() order by created_at`, [device])).rows;
}

export async function acknowledgeCommand(db, device, command, input) {
  return db.transaction(async (tx) => {
    const row = await one(tx, 'select * from bc.commands where id=$1 and device_id=$2 for update', [command, device]);
    requireCondition(row, 404, 'Command not found');
    if (row.status === input.status) return row;
    requireCondition(row.status === 'pending' && new Date(row.expires_at) > new Date(), 409, 'Command is no longer pending');
    if (input.status === 'applied') {
      const enabled = row.output === 'fan' ? input.commanded.fan === 'running' : input.commanded.leds[Number(row.output.at(-1)) - 1];
      requireCondition(enabled === row.enabled, 422, 'Acknowledged state does not match the command');
    }
    return one(tx, 'update bc.commands set status=$2, acknowledged_at=now(), acknowledgment=$3 where id=$1 returning *',
      [command, input.status, input]);
  });
}
