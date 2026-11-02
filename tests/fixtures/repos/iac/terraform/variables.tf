variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "environment" {
  type    = string
  default = "staging-marker"
}

variable "db_password" {
  type      = string
  sensitive = true
  default   = "placeholder-not-a-secret"
}
