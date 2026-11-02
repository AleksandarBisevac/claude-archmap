variable "subnet_id" {
  type = string
}

variable "password" {
  type      = string
  sensitive = true
}

output "endpoint" {
  value = "db.fleet.internal.example.invalid"
}
