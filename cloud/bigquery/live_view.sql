-- Near-live timing tower. Reads the raw live tier directly, where rows appear
-- within seconds of publication, so a dashboard needs no streaming job.
-- Substitute ${dataset} before running.

CREATE OR REPLACE VIEW `${dataset}.v_live_timing` AS
WITH latest AS (
  SELECT
    JSON_VALUE(data, '$.sessionId') AS session_id,
    CAST(JSON_VALUE(data, '$.sequence') AS INT64) AS sequence,
    CAST(JSON_VALUE(data, '$.simulationTimeSeconds') AS FLOAT64) AS sim_time_s,
    JSON_VALUE(data, '$.phase') AS phase,
    JSON_VALUE(data, '$.raceControl.state') AS race_control_state,
    data,
    publish_time,
    ROW_NUMBER() OVER (
      PARTITION BY JSON_VALUE(data, '$.sessionId')
      ORDER BY CAST(JSON_VALUE(data, '$.sequence') AS INT64) DESC
    ) AS recency
  FROM `${dataset}.raw_live`
  WHERE publish_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE)
)
SELECT
  session_id, sequence, sim_time_s, phase, race_control_state, publish_time,
  CAST(JSON_VALUE(car, '$.position') AS INT64) AS position,
  JSON_VALUE(car, '$.driverId') AS driver_id,
  JSON_VALUE(car, '$.teamId') AS team_id,
  CAST(JSON_VALUE(car, '$.isPlayer') AS BOOL) AS is_player,
  CAST(JSON_VALUE(car, '$.lap') AS INT64) AS lap,
  CAST(JSON_VALUE(car, '$.gapToLeaderSeconds') AS FLOAT64) AS gap_to_leader_s,
  CAST(JSON_VALUE(car, '$.intervalSeconds') AS FLOAT64) AS interval_s,
  CAST(JSON_VALUE(car, '$.lastLapSeconds') AS FLOAT64) AS last_lap_s,
  CAST(JSON_VALUE(car, '$.bestLapSeconds') AS FLOAT64) AS best_lap_s,
  CAST(JSON_VALUE(car, '$.speedKph') AS FLOAT64) AS speed_kph,
  JSON_VALUE(car, '$.tyreCompound') AS tyre_compound,
  CAST(JSON_VALUE(car, '$.tyreWearFraction') AS FLOAT64) AS tyre_wear_fraction,
  JSON_VALUE(car, '$.pitState') AS pit_state,
  CAST(JSON_VALUE(car, '$.penaltySeconds') AS FLOAT64) AS penalty_s,
  CAST(JSON_VALUE(car, '$.dnf') AS BOOL) AS dnf
FROM latest, UNNEST(JSON_QUERY_ARRAY(data, '$.cars')) AS car
WHERE recency = 1
ORDER BY session_id, position;
