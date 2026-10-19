output "service_uri" {
  value = google_cloud_run_v2_service.ingest.uri
}
output "pubsub_topic" {
  value = google_pubsub_topic.telemetry.id
}
output "token_secret_id" {
  value = google_secret_manager_secret.token_secret.id
}
