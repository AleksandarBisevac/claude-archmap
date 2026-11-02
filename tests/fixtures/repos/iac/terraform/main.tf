# Fictional fleet platform: network, one web instance, and two local modules (see modules.tf).
terraform {
  required_version = ">= 1.5"
}

provider "aws" {
  region = var.region
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = {
    Name = "fleet-${var.environment}"
  }
}

resource "aws_subnet" "app" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_security_group" "app" {
  name   = "fleet-app" # not aws_subnet.app.id: a comment names no reference
  vpc_id = aws_vpc.main.id
  description = "see aws_vpc.main.arn in the docs"
}

resource "aws_instance" "web" {
  ami                    = "ami-00000000"
  instance_type          = "t3.small"
  subnet_id              = aws_subnet.app.id
  vpc_security_group_ids = [aws_security_group.app.id]
  user_data              = "export DB=${module.database.endpoint}"

  depends_on = [
    module.database,
  ]
}
