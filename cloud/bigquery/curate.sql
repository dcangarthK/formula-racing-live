-- Flattens the raw Pub/Sub landing tables into the curated tables, keyed on
-- record_id. Pub/Sub is at-least-once, so every statement is a MERGE on that
-- key and the whole file is safe to re-run. Schedule it every 5 minutes.
-- Substitute ${dataset} before running.

-- Sessions come from the events tier: session_started carries the envelope
-- metadata and session_ended carries how the session actually finished.
MERGE `${dataset}.sessions` AS target
USING (
  WITH events AS (
    SELECT
      JSON_VALUE(data, '$.sessionId') AS session_id,
      JSON_VALUE(data, '$.userId') AS user_id,
      JSON_VALUE(data, '$.event') AS event,
      JSON_VALUE(data, '$.sessionType') AS session_type,
      data,
      publish_time
    FROM `${dataset}.raw_events`
    WHERE publish_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY)
  )
  SELECT
    session_id,
    ANY_VALUE(user_id) AS user_id,
    ANY_VALUE(session_type) AS session_type,
    MIN(publish_time) AS created_at,
    MAX(IF(event = 'session_ended', publish_time, NULL)) AS ended_at,
    MAX(IF(event = 'session_ended', JSON_VALUE(data, '$.reason'), NULL)) AS end_reason,
    MAX(IF(event = 'session_ended', CAST(JSON_VALUE(data, '$.completedLaps') AS INT64), NULL)) AS completed_laps,
    MAX(IF(event = 'session_ended', CAST(JSON_VALUE(data, '$.classified') AS BOOL), NULL)) AS classified
  FROM events
  GROUP BY session_id
) AS source
ON target.session_id = source.session_id
WHEN MATCHED THEN UPDATE SET
  ended_at = COALESCE(source.ended_at, target.ended_at),
  end_reason = COALESCE(source.end_reason, target.end_reason),
  completed_laps = COALESCE(source.completed_laps, target.completed_laps),
  classified = COALESCE(source.classified, target.classified),
  session_type = COALESCE(source.session_type, target.session_type)
WHEN NOT MATCHED THEN INSERT (
  session_id, user_id, session_type, created_at, ended_at, end_reason, completed_laps, classified
) VALUES (
  source.session_id, source.user_id, source.session_type, source.created_at,
  source.ended_at, source.end_reason, source.completed_laps, source.classified
);

MERGE `${dataset}.car_samples` AS target
USING (
  SELECT
    CONCAT(JSON_VALUE(data, '$.recordId'), ':', car_index) AS record_id,
    JSON_VALUE(data, '$.sessionId') AS session_id,
    CAST(JSON_VALUE(data, '$.sequence') AS INT64) AS sequence,
    CAST(JSON_VALUE(data, '$.simulationTimeSeconds') AS FLOAT64) AS sim_time_s,
    CAST(JSON_VALUE(data, '$.raceTimeSeconds') AS FLOAT64) AS race_time_s,
    DATE(publish_time) AS session_date,
    JSON_VALUE(data, '$.phase') AS phase,
    JSON_VALUE(data, '$.raceControl.state') AS race_control_state,
    CAST(JSON_VALUE(data, '$.conditions.wetness') AS FLOAT64) AS wetness,
    CAST(JSON_VALUE(data, '$.conditions.trackGrip') AS FLOAT64) AS track_grip,
    JSON_VALUE(car, '$.driverId') AS driver_id,
    JSON_VALUE(car, '$.teamId') AS team_id,
    CAST(JSON_VALUE(car, '$.isPlayer') AS BOOL) AS is_player,
    CAST(JSON_VALUE(car, '$.position') AS INT64) AS position,
    CAST(JSON_VALUE(car, '$.lap') AS INT64) AS lap,
    CAST(JSON_VALUE(car, '$.trackSampleIndex') AS INT64) AS track_sample_index,
    CAST(JSON_VALUE(car, '$.positionXM') AS FLOAT64) AS pos_x_m,
    CAST(JSON_VALUE(car, '$.positionZM') AS FLOAT64) AS pos_z_m,
    CAST(JSON_VALUE(car, '$.speedKph') AS FLOAT64) AS speed_kph,
    CAST(JSON_VALUE(car, '$.gapToLeaderSeconds') AS FLOAT64) AS gap_to_leader_s,
    CAST(JSON_VALUE(car, '$.lapsDown') AS INT64) AS laps_down,
    CAST(JSON_VALUE(car, '$.intervalSeconds') AS FLOAT64) AS interval_s,
    CAST(JSON_VALUE(car, '$.lastLapSeconds') AS FLOAT64) AS last_lap_s,
    CAST(JSON_VALUE(car, '$.bestLapSeconds') AS FLOAT64) AS best_lap_s,
    JSON_VALUE(car, '$.tyreCompound') AS tyre_compound,
    CAST(JSON_VALUE(car, '$.tyreWearFraction') AS FLOAT64) AS tyre_wear_fraction,
    JSON_VALUE(car, '$.pitState') AS pit_state,
    CAST(JSON_VALUE(car, '$.pitStops') AS INT64) AS pit_stops,
    CAST(JSON_VALUE(car, '$.penaltySeconds') AS FLOAT64) AS penalty_s,
    CAST(JSON_VALUE(car, '$.finished') AS BOOL) AS finished,
    CAST(JSON_VALUE(car, '$.dnf') AS BOOL) AS dnf
  FROM `${dataset}.raw_live`,
    UNNEST(JSON_QUERY_ARRAY(data, '$.cars')) AS car WITH OFFSET AS car_index
  WHERE publish_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY)
) AS source
ON target.record_id = source.record_id
WHEN NOT MATCHED THEN INSERT ROW;

MERGE `${dataset}.player_engineering` AS target
USING (
  SELECT
    JSON_VALUE(data, '$.recordId') AS record_id,
    JSON_VALUE(data, '$.sessionId') AS session_id,
    CAST(JSON_VALUE(data, '$.sequence') AS INT64) AS sequence,
    CAST(JSON_VALUE(data, '$.simulationTimeSeconds') AS FLOAT64) AS sim_time_s,
    CAST(JSON_VALUE(data, '$.raceTimeSeconds') AS FLOAT64) AS race_time_s,
    DATE(publish_time) AS session_date,
    JSON_VALUE(data, '$.driverId') AS driver_id,
    JSON_VALUE(data, '$.teamId') AS team_id,
    CAST(JSON_VALUE(data, '$.race.lap') AS INT64) AS lap,
    CAST(JSON_VALUE(data, '$.car.speedKph') AS FLOAT64) AS speed_kph,
    CAST(JSON_VALUE(data, '$.car.gear') AS INT64) AS gear,
    CAST(JSON_VALUE(data, '$.car.rpmFraction') AS FLOAT64) AS rpm_fraction,
    CAST(JSON_VALUE(data, '$.car.throttle') AS FLOAT64) AS throttle,
    CAST(JSON_VALUE(data, '$.car.brake') AS FLOAT64) AS brake,
    CAST(JSON_VALUE(data, '$.car.steering') AS FLOAT64) AS steering,
    CAST(JSON_VALUE(data, '$.car.longitudinalAccelerationMps2') AS FLOAT64) AS longitudinal_acceleration_mps2,
    CAST(JSON_VALUE(data, '$.car.lateralAccelerationMps2') AS FLOAT64) AS lateral_acceleration_mps2,
    CAST(JSON_VALUE(data, '$.car.yawRateRadPerSecond') AS FLOAT64) AS yaw_rate_rad_s,
    CAST(JSON_VALUE(data, '$.car.slipAngleRad') AS FLOAT64) AS slip_angle_rad,
    CAST(JSON_VALUE(data, '$.car.downforceN') AS FLOAT64) AS downforce_n,
    CAST(JSON_VALUE(data, '$.car.aeroBalance') AS FLOAT64) AS aero_balance,
    CAST(JSON_VALUE(data, '$.car.brakeBias') AS FLOAT64) AS brake_bias,
    CAST(JSON_VALUE(data, '$.car.brakeTemperatureC') AS FLOAT64) AS brake_temperature_c,
    CAST(JSON_VALUE(data, '$.car.batteryFraction') AS FLOAT64) AS battery_fraction,
    CAST(JSON_VALUE(data, '$.car.ersMode') AS INT64) AS ers_mode,
    CAST(JSON_VALUE(data, '$.car.ersDeployW') AS FLOAT64) AS ers_deploy_w,
    CAST(JSON_VALUE(data, '$.car.fuelFraction') AS FLOAT64) AS fuel_fraction,
    JSON_VALUE(data, '$.car.tyreCompound') AS tyre_compound,
    CAST(JSON_VALUE(data, '$.car.tyreWearFraction') AS FLOAT64) AS tyre_wear_fraction,
    CAST(JSON_VALUE(data, '$.car.tyreGrip') AS FLOAT64) AS tyre_grip,
    CAST(JSON_VALUE(data, '$.car.tyreTemperatureC') AS FLOAT64) AS tyre_temperature_c,
    CAST(JSON_VALUE(data, '$.car.trackWetness') AS FLOAT64) AS track_wetness,
    CAST(JSON_VALUE(data, '$.car.offTrack') AS BOOL) AS off_track,
    ARRAY(
      SELECT AS STRUCT
        JSON_VALUE(wheel, '$.key') AS wheel,
        CAST(JSON_VALUE(wheel, '$.slipRatio') AS FLOAT64) AS slip_ratio,
        CAST(JSON_VALUE(wheel, '$.slipAngle') AS FLOAT64) AS slip_angle_rad,
        CAST(JSON_VALUE(wheel, '$.normalLoadN') AS FLOAT64) AS normal_load_n,
        CAST(JSON_VALUE(wheel, '$.surfaceTemperatureC') AS FLOAT64) AS surface_temperature_c,
        CAST(JSON_VALUE(wheel, '$.carcassTemperatureC') AS FLOAT64) AS carcass_temperature_c,
        CAST(JSON_VALUE(wheel, '$.pressure') AS FLOAT64) AS pressure_kpa,
        CAST(JSON_VALUE(wheel, '$.suspensionDeflectionM') AS FLOAT64) AS suspension_deflection_m,
        CAST(JSON_VALUE(wheel, '$.contact') AS BOOL) AS contact
      FROM UNNEST(JSON_QUERY_ARRAY(data, '$.car.wheels')) AS wheel
    ) AS wheels
  FROM `${dataset}.raw_engineering`
  WHERE publish_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY)
) AS source
ON target.record_id = source.record_id
WHEN NOT MATCHED THEN INSERT ROW;

MERGE `${dataset}.race_events` AS target
USING (
  SELECT
    JSON_VALUE(data, '$.recordId') AS record_id,
    JSON_VALUE(data, '$.sessionId') AS session_id,
    CAST(JSON_VALUE(data, '$.sequence') AS INT64) AS sequence,
    CAST(JSON_VALUE(data, '$.simulationTimeSeconds') AS FLOAT64) AS sim_time_s,
    CAST(JSON_VALUE(data, '$.raceTimeSeconds') AS FLOAT64) AS race_time_s,
    DATE(publish_time) AS session_date,
    JSON_VALUE(data, '$.event') AS event,
    JSON_VALUE(data, '$.driverId') AS driver_id,
    CAST(JSON_VALUE(data, '$.lap') AS INT64) AS lap,
    data AS payload
  FROM `${dataset}.raw_events`
  WHERE publish_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY)
) AS source
ON target.record_id = source.record_id
WHEN NOT MATCHED THEN INSERT ROW;

-- Lap and sector times, assembled from the event stream.
MERGE `${dataset}.laps` AS target
USING (
  WITH completed AS (
    SELECT session_id, driver_id, session_date,
      CAST(JSON_VALUE(payload, '$.lapNumber') AS INT64) AS lap_number,
      CAST(JSON_VALUE(payload, '$.lapTimeSeconds') AS FLOAT64) AS lap_time_s,
      CAST(JSON_VALUE(payload, '$.bestLapSeconds') AS FLOAT64) AS best_lap_s
    FROM `${dataset}.race_events`
    WHERE event = 'lap_completed'
  ),
  sectors AS (
    SELECT session_id, driver_id,
      CAST(JSON_VALUE(payload, '$.lapNumber') AS INT64) AS lap_number,
      MAX(IF(JSON_VALUE(payload, '$.sector') = '1', CAST(JSON_VALUE(payload, '$.sectorTimeSeconds') AS FLOAT64), NULL)) AS sector1_s,
      MAX(IF(JSON_VALUE(payload, '$.sector') = '2', CAST(JSON_VALUE(payload, '$.sectorTimeSeconds') AS FLOAT64), NULL)) AS sector2_s,
      MAX(IF(JSON_VALUE(payload, '$.sector') = '3', CAST(JSON_VALUE(payload, '$.sectorTimeSeconds') AS FLOAT64), NULL)) AS sector3_s
    FROM `${dataset}.race_events`
    WHERE event = 'sector_completed'
    GROUP BY session_id, driver_id, lap_number
  )
  SELECT completed.session_id, completed.driver_id, completed.lap_number, completed.session_date,
    completed.lap_time_s, sectors.sector1_s, sectors.sector2_s, sectors.sector3_s, completed.best_lap_s
  FROM completed
  LEFT JOIN sectors USING (session_id, driver_id, lap_number)
) AS source
ON target.session_id = source.session_id
  AND target.driver_id = source.driver_id
  AND target.lap_number = source.lap_number
WHEN MATCHED THEN UPDATE SET
  lap_time_s = source.lap_time_s,
  sector1_s = source.sector1_s,
  sector2_s = source.sector2_s,
  sector3_s = source.sector3_s,
  best_lap_s = source.best_lap_s
WHEN NOT MATCHED THEN INSERT ROW;

-- Final classification, one row per car, from the race_finished event.
MERGE `${dataset}.results` AS target
USING (
  SELECT
    session_id,
    CAST(JSON_VALUE(entry, '$.position') AS INT64) AS position,
    JSON_VALUE(entry, '$.driverId') AS driver_id,
    JSON_VALUE(entry, '$.teamId') AS team_id,
    JSON_VALUE(entry, '$.status') AS status,
    CAST(JSON_VALUE(entry, '$.laps') AS INT64) AS laps,
    CAST(JSON_VALUE(entry, '$.bestLapSeconds') AS FLOAT64) AS best_lap_s,
    CAST(JSON_VALUE(entry, '$.penaltySeconds') AS FLOAT64) AS penalty_s,
    CAST(JSON_VALUE(entry, '$.points') AS INT64) AS points,
    JSON_VALUE(entry, '$.failureCause') AS failure_cause,
    session_date
  FROM `${dataset}.race_events`,
    UNNEST(JSON_QUERY_ARRAY(payload, '$.classification')) AS entry
  WHERE event = 'race_finished'
) AS source
ON target.session_id = source.session_id AND target.driver_id = source.driver_id
WHEN MATCHED THEN UPDATE SET
  position = source.position, status = source.status, laps = source.laps,
  best_lap_s = source.best_lap_s, penalty_s = source.penalty_s,
  points = source.points, failure_cause = source.failure_cause
WHEN NOT MATCHED THEN INSERT ROW;
