import { verifySpectrumSignature } from '@spectrum-ts/core/webhook';
import { z } from 'zod';
import { id } from './contracts.js';
import { enqueue } from './jobs.js';
import { answerInvestigation } from './nemotron.js';
import { advanceWork, one, recordDecision, requireCondition } from './workflow.js';

const envelope = z.object({
  event: z.string(),
  message: z.object({
    id: z.string().min(1).max(200),
    direction: z.string(),
    platform: z.string(),
    space: z.object({ id: z.string().min(1).max(300), type: z.string().optional(), phone: z.string().optional() }),
    sender: z.object({ id: z.string(), address: z.string().optional() }).optional(),
    content: z.object({ type: z.string(), text: z.string().max(8000).optional() }),
  }),
});

function parseReply(body) {
  const match = /^(APPROVE|DECLINE|ANSWER|ACCEPT|REPORT)\s+(REQ|WO)-([a-f\d-]+)(?:\s+([\s\S]+))?$/i.exec(body.trim());
  if (!match) return null;
  const [, verb, type, reference, input] = match;
  const action = verb.toLowerCase();
  const request = type.toUpperCase() === 'REQ';
  if (!(request ? ['approve', 'decline', 'answer'] : ['accept', 'decline', 'report']).includes(action) ||
      !id.safeParse(reference).success || (['answer', 'report'].includes(action) !== Boolean(input?.trim())) ||
      (input?.length ?? 0) > 1000) return null;
  return { request, action, reference, input: input?.trim() };
}

export async function receivePhoton(db, config, raw, headers) {
  requireCondition(Buffer.isBuffer(raw), 400, 'Missing Spectrum request body');
  const signature = await verifySpectrumSignature({
    headers, rawBody: raw, secret: config.photon.webhookSecret,
  });
  requireCondition(signature.ok, 401, 'Invalid Spectrum signature');
  let json;
  try { json = JSON.parse(raw.toString('utf8')); } catch { requireCondition(false, 400, 'Invalid Spectrum JSON'); }
  const parsed = envelope.safeParse(json);
  if (!parsed.success) return;
  const { id: messageId, direction, platform, space, sender, content } = parsed.data.message;
  const address = sender?.address ?? sender?.id;
  if (direction !== 'inbound' || platform !== 'imessage' || content.type !== 'text' || !content.text ||
      !address || space.type !== 'dm' || (config.photon.line && space.phone !== config.photon.line)) return;
  // Shared DMs are created with an any;-; GUID. A webhook can use the iMessage service prefix.
  const threadId = !config.photon.line && space.id === `iMessage;-;${address}` ? `any;-;${address}` : space.id;
  await db.transaction(async (tx) => {
    const { rows } = await tx.query(`select t.building_id,t.role from bc.photon_threads t
      where t.address=$1 and t.space_id=$2`, [address, threadId]);
    const threads = rows.filter(({ building_id, role }) => config.contacts[building_id]?.[role + 'Phone'] === address);
    if (!threads.length) return;
    const event = await one(tx, `insert into bc.photon_events (message_id,space_id,sender,body)
      values ($1,$2,$3,$4) on conflict do nothing returning message_id`, [messageId, space.id, address, content.text]);
    if (!event) return;

    const reply = parseReply(content.text);
    const target = !reply ? null : reply.request
      ? await one(tx, `select r.id,r.version,r.incident_id,i.building_id from bc.service_requests r
          join bc.incidents i on i.id=r.incident_id where r.id=$1 and i.source='hardware'`, [reply.reference])
      : await one(tx, `select w.id,w.status,r.incident_id,i.building_id from bc.work_orders w
          join bc.service_requests r on r.id=w.request_id join bc.incidents i on i.id=r.incident_id
          where w.id=$1 and i.source='hardware'`, [reply.reference]);
    const role = reply?.request ? 'owner' : 'technician';
    const thread = threads.find((item) => item.building_id === target?.building_id && item.role === role);
    let outcome = 'ignored';
    if (thread) {
      const owner = config.contacts[target.building_id].ownerUserId;
      // Share the event transaction with the dashboard's transition functions.
      const transactionalDb = { transaction: (run) => run(tx) };
      try {
        if (reply.action === 'answer') {
          await answerInvestigation(tx, owner, target.id, reply.input);
        } else if (reply.request) {
          await recordDecision(transactionalDb, owner, target.id, {
            version: target.version, decision: reply.action === 'approve' ? 'approved' : 'declined',
          }, config);
        } else {
          if (['accept', 'decline'].includes(reply.action) && target.status === 'queued') {
            const delivery = await one(tx, `select id from bc.integration_jobs
              where job_key=$1 and recipient=$2 and delivery_started_at is not null`,
            [`technician:${target.id}`, address]);
            if (delivery) await advanceWork(transactionalDb, owner, target.id, 'contact');
          }
          await advanceWork(transactionalDb, owner, target.id, reply.action, { notes: reply.input }, false, config);
        }
        outcome = 'applied';
      } catch (error) {
        if (![404, 409].includes(error.status)) throw error;
        outcome = 'inactive';
      }
    }
    if (outcome !== 'applied') {
      const known = thread ?? threads[0];
      const incident = target?.building_id === known.building_id ? target : await one(tx, `
        select i.id as incident_id from bc.incidents i join bc.memberships m on m.building_id=i.building_id
        where i.building_id=$1 and i.source='hardware' and m.user_id=$2 order by i.opened_at desc limit 1`,
      [known.building_id, config.contacts[known.building_id].ownerUserId]);
      if (incident) await enqueue(tx, incident.incident_id, 'reply_help', `reply:${messageId}`, {
        role: known.role, address, spaceId: threadId,
      });
    }
    await tx.query('update bc.photon_events set outcome=$2 where message_id=$1', [messageId, outcome]);
  });
}
