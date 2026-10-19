# One topic per telemetry tier, each with its own BigQuery landing table.
# A slow analytical consumer on the engineering feed can then never delay the
# live feed, and each tier carries its own retention. See
# ../../docs/specs/telemetry-tiers.md.

locals {
  tiers = {
    live         = "All cars, slim, 5 Hz — spectator dashboard and timing tower"
    engineering  = "Player car, full detail, 20 Hz — driver and tyre analysis"
    events       = "Laps, sectors, pits, penalties, classification, session end"
  }
}

resource "google_pubsub_topic" "tier" {
  for_each                   = local.tiers
  name                       = "${var.topic_name}-${each.key}"
  depends_on                 = [google_project_service.services]
  message_retention_duration = "604800s"
  labels                     = { tier = each.key }
}

resource "google_pubsub_topic_iam_member" "tier_publisher" {
  for_each = google_pubsub_topic.tier
  topic    = each.value.name
  role     = "roles/pubsub.publisher"
  member   = "serviceAccount:${google_service_account.ingest.email}"
}

resource "google_project_service" "analytics" {
  for_each           = toset(["bigquery.googleapis.com"])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_bigquery_dataset" "telemetry" {
  dataset_id    = var.dataset_id
  location      = var.dataset_location
  description   = "Formula Racing Live telemetry landing and curated tables"
  depends_on    = [google_project_service.analytics]
}

# Raw landing tables. The Pub/Sub BigQuery subscription writes its own standard
# columns, so no consumer service sits in the ingest path.
resource "google_bigquery_table" "raw" {
  for_each            = local.tiers
  dataset_id          = google_bigquery_dataset.telemetry.dataset_id
  table_id            = "raw_${each.key}"
  description         = each.value
  deletion_protection = false

  time_partitioning {
    type          = "DAY"
    field         = "publish_time"
    expiration_ms = 2592000000 # 30 days; curated tables hold anything older.
  }
  clustering = ["session_id"]

  schema = jsonencode([
    { name = "subscription_name", type = "STRING", mode = "NULLABLE" },
    { name = "message_id", type = "STRING", mode = "NULLABLE" },
    { name = "publish_time", type = "TIMESTAMP", mode = "NULLABLE" },
    { name = "data", type = "JSON", mode = "NULLABLE" },
    { name = "attributes", type = "JSON", mode = "NULLABLE" },
    # Promoted from the message attributes by the subscription's table schema
    # so partition pruning and clustering work without parsing JSON.
    { name = "session_id", type = "STRING", mode = "NULLABLE" },
    { name = "record_id", type = "STRING", mode = "NULLABLE" },
  ])
}

resource "google_project_iam_member" "pubsub_bigquery_writer" {
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

data "google_project" "current" {
  project_id = var.project_id
}

resource "google_pubsub_subscription" "to_bigquery" {
  for_each = google_pubsub_topic.tier
  name     = "${each.value.name}-to-bigquery"
  topic    = each.value.name

  # Ordering is per topic, which is what each tier's consumer needs.
  enable_message_ordering    = true
  message_retention_duration = "604800s"

  bigquery_config {
    table            = "${var.project_id}.${google_bigquery_dataset.telemetry.dataset_id}.${google_bigquery_table.raw[each.key].table_id}"
    write_metadata   = true
    use_topic_schema = false
  }

  depends_on = [google_project_iam_member.pubsub_bigquery_writer]
}
