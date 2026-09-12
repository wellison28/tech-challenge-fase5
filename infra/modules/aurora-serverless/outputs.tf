output "cluster_arn" {
  value = aws_rds_cluster.this.arn
}

output "cluster_identifier" {
  value = aws_rds_cluster.this.cluster_identifier
}

output "proxy_endpoint" {
  description = "Endpoint que as Lambdas usam na DATABASE_URL."
  value       = aws_db_proxy.this.endpoint
}

output "proxy_arn" {
  value = aws_db_proxy.this.arn
}

output "credentials_secret_arn" {
  value = aws_secretsmanager_secret.credentials.arn
}

output "app_credentials_secret_arn" {
  description = "Segredo do usuário de aplicação: lido pelo Proxy e pelo job de migração, nunca pelas Lambdas."
  value       = aws_secretsmanager_secret.app_credentials.arn
}

output "database_name" {
  value = var.database_name
}

output "security_group_id" {
  value = aws_security_group.cluster.id
}
