output "api_address" {
  value = aws_instance.api.public_ip
}

output "database_endpoint" {
  value = aws_db_instance.parcels.endpoint
}
