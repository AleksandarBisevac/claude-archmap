variable "vpc_id" {
  type = string
}

variable "upstream" {
  type = string
}

output "endpoint" {
  value = "cache.fleet.internal.example.invalid"
}
