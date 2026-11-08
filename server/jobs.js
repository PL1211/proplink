export async function enqueue(tx, incident, kind, key, payload) {
  await tx.query(`
    insert into bc.integration_jobs (incident_id, kind, job_key, payload)
    values ($1,$2,$3,$4) on conflict (job_key) do nothing`, [incident, kind, key, payload]);
}

export async function claimJob(db, kinds) {
  const { rows } = await db.query(`
    update bc.integration_jobs
    set status='running', attempts=attempts+1, lease_id=gen_random_uuid(),
      lease_until=now()+interval '3 minutes', updated_at=now()
    where id = (
      select id from bc.integration_jobs where kind=any($1::text[])
      and ((status='pending' and available_at<=now()) or (status='running' and lease_until<=now()))
      order by available_at, created_at limit 1 for update skip locked
    ) returning *`, [kinds]);
  return rows[0];
}

export async function finishJob(tx, job, { status = 'done', providerId, error, delay = 0 } = {}) {
  const result = await tx.query(`
    update bc.integration_jobs
    set status=$3, provider_id=coalesce($4,provider_id), last_error=$5,
      lease_id=null, lease_until=null, available_at=now()+$6::int*interval '1 second', updated_at=now()
    where id=$1 and lease_id=$2 and status='running' returning id`,
  [job.id, job.lease_id, status, providerId ?? null, error ?? null, delay]);
  return result.rows.length > 0;
}

export async function saveRecipient(tx, job, recipient) {
  const { rows } = await tx.query(`
    update bc.integration_jobs set recipient=$3, updated_at=now()
    where id=$1 and lease_id=$2 and (recipient is null or recipient=$3) returning id`,
  [job.id, job.lease_id, recipient]);
  if (!rows.length) throw new Error('Job lease or configured recipient changed');
}

export async function beginDelivery(tx, job) {
  const { rows } = await tx.query(`
    update bc.integration_jobs set delivery_started_at=now()
    where id=$1 and lease_id=$2 and delivery_started_at is null returning id`, [job.id, job.lease_id]);
  return rows.length > 0;
}
