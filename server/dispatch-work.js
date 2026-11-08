import { beginDelivery, finishJob, saveRecipient } from './jobs.js';
import { activity, advanceWork, one } from './workflow.js';

const updates = {
  accept: 'The technician accepted the visit.',
  decline: 'The technician declined the visit. The incident is still open.',
  report: 'Repair findings are ready for your verification in the dashboard.',
  verify: 'The repair was verified and the incident is resolved.',
};
const issue = { low_light: 'sustained low light', ir_alert: 'an IR sensor activation' };

export function createPhotonClient(config) {
  let sdk;
  const init = async () => {
    const { Spectrum } = await import('@spectrum-ts/core');
    const { imessage } = await import('@spectrum-ts/imessage');
    const app = await Spectrum({
      projectId: config.projectId, projectSecret: config.projectSecret, providers: [imessage.config()],
    });
    return { app, im: imessage(app) };
  };
  return {
    async open(address, spaceId) {
      sdk ??= init().catch((error) => { sdk = undefined; throw error; });
      const { im } = await sdk;
      const route = config.line ? { phone: config.line } : undefined;
      return spaceId ? im.space.get(spaceId, route) : im.space.create(await im.user(address), route);
    },
    async close() {
      if (sdk) await (await sdk).app.stop();
    },
  };
}

async function requestContext(db, job, lock = false) {
  const { requestId, investigationId = requestId } = job.payload;
  return one(db, `
    select i.id,i.kind,i.building_id,b.name,r.status,r.recommendation,r.expires_at,n.assessment,n.status as investigation_status
    from bc.incidents i join bc.buildings b on b.id=i.building_id join bc.service_requests r on r.incident_id=i.id
    left join bc.investigations n on n.request_id=$3
    where i.id=$1 and r.id=$2 and i.source='hardware' and i.status='open'${lock ? ' for update of r' : ''}`,
  [job.incident_id, requestId, investigationId]);
}

async function workContext(db, job, lock = false) {
  return one(db, `
    select i.id,i.building_id,i.kind,b.name,w.id as work_id,w.status as work_status,a.status as contact_status
    from bc.incidents i join bc.buildings b on b.id=i.building_id join bc.service_requests r on r.incident_id=i.id
    join bc.work_orders w on w.request_id=r.id join bc.outbound_actions a on a.work_order_id=w.id
    where i.id=$1 and w.id=$2 and i.source='hardware' and r.status='approved'${lock ? ' for update of w' : ''}`,
  [job.incident_id, job.payload.workId]);
}

async function currentContact(db, config, building) {
  const contact = config.contacts?.[building];
  if (!contact) return null;
  const member = await one(db, 'select 1 from bc.memberships where building_id=$1 and user_id=$2',
    [building, contact.ownerUserId]);
  return member ? contact : null;
}

async function messagePlan(db, job, lock = false) {
  if (job.kind === 'owner_approval' || job.kind === 'owner_question') {
    const context = await requestContext(db, job, lock);
    if (context?.status !== 'pending' || new Date(context.expires_at) <= new Date()) return null;
    const ref = `REQ-${job.payload.requestId}`;
    if (job.kind === 'owner_question') {
      if (context.investigation_status !== 'waiting') return null;
      return { context, role: 'owner', body: `BuildingConnect · ${context.name}\n${context.assessment.question}\nReply ANSWER ${ref} followed by your answer.` };
    }
    const { observation, uncertainty } = context.assessment ?? {};
    const summary = observation && uncertainty ? `${observation}\nUncertainty: ${uncertainty}` : `Observed ${issue[context.kind]}. The cause needs inspection.`;
    return { context, role: 'owner', body: `BuildingConnect · ${context.name}\n${summary}\nProposed inspection: ${context.recommendation}\nReply APPROVE ${ref} or DECLINE ${ref}.` };
  }
  if (job.kind === 'reply_help') {
    const context = await one(db, 'select building_id from bc.incidents where id=$1', [job.incident_id]);
    const { role, address, spaceId } = job.payload;
    return { context, role, address, spaceId, body: 'BuildingConnect could not apply that reply. Copy the command and reference from your latest request or check the dashboard for its status.' };
  }
  const context = await workContext(db, job, lock && job.kind === 'technician_message');
  if (!context) return null;
  const ref = `WO-${context.work_id}`;
  if (job.kind === 'owner_update') {
    return { context, role: 'owner', body: `BuildingConnect · ${context.name}\n${updates[job.payload.action]}\n${ref}` };
  }
  if (context.work_status !== 'queued' || context.contact_status !== 'queued') return null;
  return { context, role: 'technician', body: `BuildingConnect · ${context.name}\nThe owner approved an inspection for ${issue[context.kind]}. Please inspect and report what you find.\nReply ACCEPT ${ref} or DECLINE ${ref}. After the visit, reply REPORT ${ref} followed by your findings.` };
}

function timed(promise, ms = 25_000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Provider request timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function sendMessageJob(db, job, config, photon) {
  const plan = await messagePlan(db, job);
  if (!plan) return finishJob(db, job);
  const { context, role, address, spaceId } = plan;
  const contact = await currentContact(db, config, context.building_id);
  const recipient = contact?.[role + 'Phone'];
  if (!recipient || (address && address !== recipient)) return finishJob(db, job);
  await saveRecipient(db, job, recipient);
  const space = await timed(photon.open(recipient, spaceId));
  const expectedLine = config.photon.line ?? 'shared';
  if (!space?.id || space.type !== 'dm' || space.phone !== expectedLine) throw new Error('Unexpected Spectrum direct conversation');
  const delivery = await db.transaction(async (tx) => {
    const current = await messagePlan(tx, job, true);
    if (!current) {
      await finishJob(tx, job);
      return null;
    }
    if (!await beginDelivery(tx, job)) return null;
    await tx.query(`insert into bc.photon_threads (building_id,role,address,space_id) values ($1,$2,$3,$4)
      on conflict do nothing`, [context.building_id, role, recipient, space.id]);
    return current.body;
  });
  if (!delivery) return;
  const sent = await timed(space.send(delivery));
  if (!sent?.id) throw new Error('Spectrum did not confirm a message ID');
  await db.transaction(async (tx) => {
    if (job.kind === 'technician_message') {
      const transactionalDb = { transaction: (run) => run(tx) };
      try { await advanceWork(transactionalDb, contact.ownerUserId, context.work_id, 'contact'); }
      catch (error) { if (![404, 409].includes(error.status)) throw error; }
    }
    if (!await finishJob(tx, job, { providerId: sent.id })) throw new Error('Delivery lease expired');
    await activity(tx, context.building_id, job.incident_id, 'message', `Photon accepted the ${role} message`);
  });
}
