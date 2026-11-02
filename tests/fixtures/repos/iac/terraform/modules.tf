module "database" {
  source    = "./modules/database"
  subnet_id = aws_subnet.app.id
  password  = var.db_password
}

module "cache" {
  source   = "./modules/cache"
  vpc_id   = aws_vpc.main.id
  upstream = module.database.endpoint
}
