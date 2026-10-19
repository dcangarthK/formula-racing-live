-- Curated telemetry tables for Formula Racing Live.
-- Raw landing tables (raw_live, raw_engineering, raw_events) are created by
-- Terraform and written directly by Pub/Sub BigQuery subscriptions. These
-- tables are the deduplicated, typed form that dashboards and analysis read.
-- Design: ../../docs/specs/telemetry-tiers.md
--
-- Substitute ${dataset} before running, e.g.
--   bq query --use_legacy_sql=false < schema.sql

CREATE TABLE IF NOT EXISTS `${dataset}.sessions` (
  session_id STRING NOT NULL,
  user_id STRING NOT NULL,
  display_name STRING,
  game_version STRING,
  session_type STRING,        -- race | qualifying | time_trial
  track_id STRING,
  circuit_name STRING,
  seed INT64,
  configured_laps INT64,      -- NULL for a time trial: it has no planned distance
  created_at TIMESTAMP,
  ended_at TIMESTAMP,
  end_reason STRING,          -- classified | abandoned
  completed_laps INT64,
  classified BOOL
)
PARTITION BY DATE(created_at)
CLUSTER BY session_id;

CREATE TABLE IF NOT EXISTS `${dataset}.car_samples` (
  record_id STRING NOT NULL,
  session_id STRING NOT NULL,
  sequence INT64,
  sim_time_s FLOAT64,
  race_time_s FLOAT64,
  session_date DATE,
  phase STRING,
  race_control_state STRING,
  wetness FLOAT64,
  track_grip FLOAT64,
  driver_id STRING,
  team_id STRING,
  is_player BOOL,
  position INT64,
  lap INT64,
  track_sample_index INT64,
  pos_x_m FLOAT64,
  pos_z_m FLOAT64,
  speed_kph FLOAT64,
  gap_to_leader_s FLOAT64,
  laps_down INT64,
  interval_s FLOAT64,
  last_lap_s FLOAT64,
  best_lap_s FLOAT64,
  tyre_compound STRING,
  tyre_wear_fraction FLOAT64,
  pit_state STRING,
  pit_stops INT64,
  penalty_s FLOAT64,
  finished BOOL,
  dnf BOOL
)
PARTITION BY session_date
CLUSTER BY session_id, driver_id;

CREATE TABLE IF NOT EXISTS `${dataset}.player_engineering` (
  record_id STRING NOT NULL,
  session_id STRING NOT NULL,
  sequence INT64,
  sim_time_s FLOAT64,
  race_time_s FLOAT64,
  session_date DATE,
  driver_id STRING,
  team_id STRING,
  lap INT64,
  speed_kph FLOAT64,
  gear INT64,
  rpm_fraction FLOAT64,
  throttle FLOAT64,
  brake FLOAT64,
  steering FLOAT64,
  longitudinal_acceleration_mps2 FLOAT64,
  lateral_acceleration_mps2 FLOAT64,
  yaw_rate_rad_s FLOAT64,
  slip_angle_rad FLOAT64,
  downforce_n FLOAT64,
  aero_balance FLOAT64,
  brake_bias FLOAT64,
  brake_temperature_c FLOAT64,
  battery_fraction FLOAT64,
  ers_mode INT64,
  ers_deploy_w FLOAT64,
  fuel_fraction FLOAT64,
  tyre_compound STRING,
  tyre_wear_fraction FLOAT64,
  tyre_grip FLOAT64,
  tyre_temperature_c FLOAT64,
  track_wetness FLOAT64,
  off_track BOOL,
  wheels ARRAY<STRUCT<
    wheel STRING,
    slip_ratio FLOAT64,
    slip_angle_rad FLOAT64,
    normal_load_n FLOAT64,
    surface_temperature_c FLOAT64,
    carcass_temperature_c FLOAT64,
    pressure_kpa FLOAT64,
    suspension_deflection_m FLOAT64,
    contact BOOL
  >>
)
PARTITION BY session_date
CLUSTER BY session_id;

CREATE TABLE IF NOT EXISTS `${dataset}.race_events` (
  record_id STRING NOT NULL,
  session_id STRING NOT NULL,
  sequence INT64,
  sim_time_s FLOAT64,
  race_time_s FLOAT64,
  session_date DATE,
  event STRING,
  driver_id STRING,
  lap INT64,
  payload JSON
)
PARTITION BY session_date
CLUSTER BY session_id, event;

-- Timing tables are derived from race_events, so the event stream stays the
-- single source of truth for lap, sector and classification data.
CREATE TABLE IF NOT EXISTS `${dataset}.laps` (
  session_id STRING NOT NULL,
  driver_id STRING NOT NULL,
  lap_number INT64 NOT NULL,
  session_date DATE,
  lap_time_s FLOAT64,
  sector1_s FLOAT64,
  sector2_s FLOAT64,
  sector3_s FLOAT64,
  best_lap_s FLOAT64
)
PARTITION BY session_date
CLUSTER BY session_id, driver_id;

CREATE TABLE IF NOT EXISTS `${dataset}.results` (
  session_id STRING NOT NULL,
  position INT64,
  driver_id STRING,
  team_id STRING,
  status STRING,
  laps INT64,
  best_lap_s FLOAT64,
  penalty_s FLOAT64,
  points INT64,
  failure_cause STRING,
  session_date DATE
)
PARTITION BY session_date
CLUSTER BY session_id;
