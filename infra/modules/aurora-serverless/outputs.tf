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

output "database_name" {
  value = var.database_name
}

output "security_group_id" {
  value = aws_security_group.cluster.id
}
