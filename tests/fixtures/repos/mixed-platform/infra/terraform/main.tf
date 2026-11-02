# Fictional parcel platform: one network, one database instance and the api host.
terraform {
  required_version = ">= 1.5"
}

provider "aws" {
  region = var.region
}

resource "aws_vpc" "main" {
  cidr_block = "10.1.0.0/16"
}

resource "aws_db_instance" "parcels" {
  identifier     = "parcels-${var.environment}"
  engine         = "postgres"
  instance_class = "db.t3.small"
  db_name        = "parcels"
}

resource "aws_instance" "api" {
  ami           = "ami-00000000"
  instance_type = "t3.small"
  subnet_id     = aws_vpc.main.id
  user_data     = "export DB=${aws_db_instance.parcels.endpoint}"
}
