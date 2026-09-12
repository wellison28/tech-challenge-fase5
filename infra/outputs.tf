output "api_endpoint" {
  description = "URL base da API."
  value       = aws_apigatewayv2_stage.main.invoke_url
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_web_client_id" {
  description = "Client id da aplicação web (público por natureza)."
  value       = aws_cognito_user_pool_client.web.id
}

output "cognito_domain" {
  value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "purchase_saga_arn" {
  value = aws_sfn_state_machine.purchase_saga.arn
}

output "event_bus_name" {
  value = aws_cloudwatch_event_bus.main.name
}

output "database_proxy_endpoints" {
  description = "Endpoints dos RDS Proxy, por serviço."
  value       = { for key, db in module.database : key => db.proxy_endpoint }
}

output "customer_pii_kms_key_arn" {
  description = "Chave que protege os dados pessoais. Apagá-la torna a base ilegível."
  value       = aws_kms_key.customer_pii.arn
}

output "alarms_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

# O segredo do cliente M2M NÃO é exposto como output: outputs ficam em texto
# claro no arquivo de estado. Ele é gravado no Secrets Manager (ver cognito.tf).
output "sales_m2m_credentials_secret" {
  description = "Nome do segredo com as credenciais M2M do sales-service."
  value       = aws_secretsmanager_secret.sales_m2m_credentials.name
}

output "dashboard_url" {
  value = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}
