provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "services" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
  ])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_pubsub_topic" "telemetry" {
  name                       = var.topic_name
  depends_on                 = [google_project_service.services]
  message_retention_duration = "604800s"
}

resource "google_service_account" "ingest" {
  account_id   = "formula-racing-ingest"
  display_name = "Formula Racing Live telemetry ingest"
}

resource "google_pubsub_topic_iam_member" "publisher" {
  topic  = google_pubsub_topic.telemetry.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.ingest.email}"
}

resource "google_secret_manager_secret" "token_secret" {
  secret_id = "formula-racing-live-token-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_iam_member" "ingest" {
  secret_id = google_secret_manager_secret.token_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ingest.email}"
}

resource "google_cloud_run_v2_service" "ingest" {
  name                = var.service_name
  location            = var.region
  deletion_protection = true
  depends_on = [
    google_project_service.services,
    google_pubsub_topic_iam_member.publisher,
    google_secret_manager_secret_iam_member.ingest,
  ]

  template {
    service_account = google_service_account.ingest.email
    scaling {
      min_instance_count = 0
      max_instance_count = 20
    }
    containers {
      image = var.image
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "PUBSUB_TOPIC"
        value = google_pubsub_topic.telemetry.name
      }
      env {
        name  = "PUBSUB_TOPIC_LIVE"
        value = google_pubsub_topic.tier["live"].name
      }
      env {
        name  = "PUBSUB_TOPIC_ENGINEERING"
        value = google_pubsub_topic.tier["engineering"].name
      }
      env {
        name  = "PUBSUB_TOPIC_EVENTS"
        value = google_pubsub_topic.tier["events"].name
      }
      env {
        name  = "TELEMETRY_ALLOWED_ORIGINS"
        value = var.allowed_origins
      }
      env {
        name  = "TELEMETRY_TOKEN_TTL_SECONDS"
        value = tostring(var.token_ttl_seconds)
      }
      env {
        name = "TELEMETRY_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.token_secret.secret_id
            version = "latest"
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
      liveness_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.allow_public_invocation ? 1 : 0
  name     = google_cloud_run_v2_service.ingest.name
  location = google_cloud_run_v2_service.ingest.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
