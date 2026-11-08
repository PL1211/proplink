alter table bc.buildings
  add column light_drop_percent integer not null default 35 check (light_drop_percent between 1 and 99),
  add column light_rise_percent integer not null default 10 check (light_rise_percent between 1 and 100);
