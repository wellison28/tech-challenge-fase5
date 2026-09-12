# =============================================================================
# Bancos de dados — um cluster por serviço (database-per-service)
#
# Cada microsserviço é dono exclusivo do seu banco. Nenhum serviço tem
# credencial para o banco de outro, e não há JOIN entre contextos. É o que
# sustenta a autonomia: o customer-service pode mudar o esquema dos dados
# pessoais sem coordenar com o catálogo, e um comprometimento do catálogo não
# alcança nenhum dado pessoal.
#
# O custo dessa escolha é real — três clusters em vez de um — e é pago
# conscientemente: com Serverless v2 no piso de 0,5 ACU, o gasto em repouso é
# baixo, e o isolamento de falha e de dados compensa.
# =============================================================================

module "database" {
  source   = "./modules/aurora-serverless"
  for_each = local.services

  name          = "${local.prefix}-${each.key}"
  database_name = each.value.database_name
  environment   = var.environment

  vpc_id     = aws_vpc.main.id
  subnet_ids = [for subnet in aws_subnet.data : subnet.id]

  # Apenas as Lambdas do serviço dono alcançam este banco.
  allowed_security_group_ids = [aws_security_group.lambda[each.key].id]

  kms_key_arn  = aws_kms_key.database.arn
  min_capacity = each.value.min_capacity
  max_capacity = each.value.max_capacity

  # O banco de dados pessoais tem retenção de backup maior: é o que permite
  # restaurar a base após um incidente sem perder a trilha de auditoria.
  backup_retention_days = each.value.handles_pii ? 30 : 14

  tags = merge(local.common_tags, {
    Service   = each.value.name
    DataClass = each.value.handles_pii ? "personal" : "internal"
  })
}

# -----------------------------------------------------------------------------
# Security groups das Lambdas
#
# Um por serviço. É a granularidade que permite dizer "o banco de clientes só
# aceita conexão das Lambdas do customer-service" — com um security group
# compartilhado, qualquer Lambda alcançaria qualquer banco.
# -----------------------------------------------------------------------------

resource "aws_security_group" "lambda" {
  for_each = local.services

  name        = "${local.prefix}-lambda-${each.key}"
  description = "Lambdas do ${each.value.name}"
  vpc_id      = aws_vpc.main.id

  tags = merge(local.common_tags, { Name = "${local.prefix}-lambda-${each.key}" })
}

# Saída HTTPS: alcança os VPC endpoints (KMS, Secrets Manager, EventBridge) e,
# via NAT, o provedor de pagamento. Sem regra de saída, nada funcionaria.
resource "aws_vpc_security_group_egress_rule" "lambda_https" {
  for_each = local.services

  security_group_id = aws_security_group.lambda[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS para VPC endpoints e servicos externos"
}

# Saída PostgreSQL restrita ao RDS Proxy do próprio serviço.
resource "aws_vpc_security_group_egress_rule" "lambda_postgres" {
  for_each = local.services

  security_group_id            = aws_security_group.lambda[each.key].id
  referenced_security_group_id = module.database[each.key].security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL apenas para o proprio banco"
}
