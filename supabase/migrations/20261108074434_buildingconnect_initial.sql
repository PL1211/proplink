create schema bc;
revoke all on schema bc from public;

create table bc.devices (
  id text primary key,
  latest jsonb,
  captured_at timestamptz,
  received_at timestamptz,
  dark_since timestamptz,
  light_recovered_since timestamptz
);

create table bc.buildings (
  id text primary key,
  name text not null,
  device_id text not null references bc.devices,
  light_min_ratio numeric check (light_min_ratio between 0 and 1),
  lights_expected_on boolean not null default true
);

create table bc.memberships (
  user_id uuid not null,
  building_id text not null references bc.buildings,
  primary key (user_id, building_id)
);

create table bc.telemetry (
  device_id text not null references bc.devices,
  boot_id text not null,
  sequence integer not null check (sequence >= 0),
  captured_at timestamptz not null,
  received_at timestamptz not null,
  payload jsonb not null,
  primary key (device_id, boot_id, sequence)
);
create index telemetry_recent on bc.telemetry (device_id, captured_at desc);

create table bc.incidents (
  id uuid primary key default gen_random_uuid(),
  building_id text not null references bc.buildings,
  kind text not null check (kind in ('low_light', 'ir_alert')),
  status text not null default 'open' check (status in ('open', 'awaiting_verification', 'resolved')),
  source text not null check (source in ('hardware', 'simulated')),
  evidence jsonb not null,
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index incident_active on bc.incidents (building_id, kind) where status <> 'resolved';

create table bc.service_requests (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references bc.incidents,
  version integer not null check (version > 0),
  recommendation text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  decided_at timestamptz,
  decided_by uuid,
  unique (incident_id, version)
);
create unique index request_pending on bc.service_requests (incident_id) where status = 'pending';

create table bc.work_orders (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references bc.service_requests,
  status text not null default 'queued' check (status in ('queued', 'contacted', 'accepted', 'repair_reported', 'verified')),
  findings text
);

create table bc.outbound_actions (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null unique references bc.work_orders,
  status text not null default 'queued' check (status in ('queued', 'simulated', 'recorded')),
  created_at timestamptz not null default now()
);

create table bc.repair_cases (
  incident_id uuid primary key references bc.incidents,
  work_order_id uuid not null unique references bc.work_orders,
  verification text not null check (verification in ('sensor', 'manual')),
  notes text not null,
  verified_by uuid not null,
  verified_at timestamptz not null default now()
);

create table bc.activity (
  id uuid primary key default gen_random_uuid(),
  building_id text not null references bc.buildings,
  incident_id uuid references bc.incidents,
  kind text not null,
  message text not null,
  created_at timestamptz not null default now()
);
create index activity_recent on bc.activity (building_id, created_at desc);

create table bc.commands (
  id uuid primary key default gen_random_uuid(),
  building_id text not null references bc.buildings,
  device_id text not null references bc.devices,
  output text not null check (output in ('led_1', 'led_2', 'led_3', 'fan')),
  enabled boolean not null,
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'superseded', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 seconds',
  acknowledged_at timestamptz,
  acknowledgment jsonb
);
create unique index command_pending on bc.commands (building_id, output) where status = 'pending';

alter table bc.devices enable row level security;
alter table bc.buildings enable row level security;
alter table bc.memberships enable row level security;
alter table bc.telemetry enable row level security;
alter table bc.incidents enable row level security;
alter table bc.service_requests enable row level security;
alter table bc.work_orders enable row level security;
alter table bc.outbound_actions enable row level security;
alter table bc.repair_cases enable row level security;
alter table bc.activity enable row level security;
alter table bc.commands enable row level security;

insert into bc.devices (id) values ('unoq-main');
insert into bc.buildings (id, name, device_id, light_min_ratio)
values ('office', 'Office', 'unoq-main', null), ('data_center', 'Data Center', 'unoq-main', null);
