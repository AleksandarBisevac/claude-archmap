output "web_address" {
  value = aws_instance.web.public_ip
}

output "database_endpoint" {
  description = "Where the web tier reaches the database"
  value       = module.database.endpoint
}
