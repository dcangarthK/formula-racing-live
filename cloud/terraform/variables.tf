variable "project_id" {
  type = string
}
variable "region" {
  type    = string
  default = "europe-west1"
}
variable "image" {
  type = string
}
variable "allowed_origins" {
  type = string
}
variable "service_name" {
  type    = string
  default = "formula-racing-live-ingest"
}
variable "topic_name" {
  type    = string
  default = "formula-racing-live-telemetry"
}
variable "token_ttl_seconds" {
  type    = number
  default = 900
}
variable "allow_public_invocation" {
  type        = bool
  default     = true
  description = "Session-token issuance is browser-facing; keep false when an API gateway handles public access."
}
variable "dataset_id" {
  type    = string
  default = "formula_racing_live"
}
variable "dataset_location" {
  type        = string
  default     = "EU"
  description = "BigQuery dataset location; must match the data residency the project requires."
}
