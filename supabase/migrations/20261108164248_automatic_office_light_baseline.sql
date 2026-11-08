alter table bc.buildings
  add column light_baseline_ratio numeric check (light_baseline_ratio between 0 and 1),
  add column light_calibration_after timestamptz;
