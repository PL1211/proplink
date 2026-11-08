create table bc.integration_jobs (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references bc.incidents,
  kind text not null check (kind in ('investigate', 'owner_approval', 'owner_question',
    'technician_message', 'owner_update', 'reply_help')),
  job_key text not null unique,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'uncertain')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  provider_id text,
  recipient text,
  delivery_started_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index integration_jobs_ready on bc.integration_jobs (available_at) where status = 'pending';
create index integration_jobs_leased on bc.integration_jobs (lease_until) where status = 'running';

create table bc.investigations (
  request_id uuid primary key references bc.service_requests,
  status text not null default 'queued' check (status in ('queued', 'running', 'waiting', 'complete', 'failed')),
  model text,
  trace jsonb not null default '[]',
  assessment jsonb,
  owner_reply text,
  updated_at timestamptz not null default now()
);

create table bc.photon_threads (
  building_id text not null references bc.buildings,
  role text not null check (role in ('owner', 'technician')),
  address text not null,
  space_id text not null,
  primary key (building_id, role, address, space_id)
);

create table bc.photon_events (
  message_id text primary key,
  space_id text not null,
  sender text not null,
  body text not null,
  outcome text not null default 'ignored',
  received_at timestamptz not null default now()
);

alter table bc.work_orders drop constraint work_orders_status_check;
alter table bc.work_orders add constraint work_orders_status_check
  check (status in ('queued', 'contacted', 'accepted', 'declined', 'repair_reported', 'verified'));

alter table bc.integration_jobs enable row level security;
alter table bc.investigations enable row level security;
alter table bc.photon_threads enable row level security;
alter table bc.photon_events enable row level security;
