# =============================================================================
# Aurora PostgreSQL Serverless v2 + RDS Proxy
#
# Por que Aurora Serverless v2 e não RDS provisionado: o tráfego de uma revenda
# é irregular — concentra-se em horário comercial e some à noite. O Serverless
# v2 escala a capacidade em segundos, dentro de uma faixa declarada, e cobra
# pelo que foi usado. O piso de 0.5 ACU mantém a instância quente, sem o cold
# start de minutos que o Serverless v1 tinha ao retomar de pausa.
#
# Por que Aurora e não DynamoDB: o requisito central do catálogo é ordenar e
# filtrar por faixa de preço sobre todo o estoque. Em SQL isso é um índice
# composto; em DynamoDB exigiria partição sintética, GSI e paginação frágil. Os
# outros dois serviços também se beneficiam da transação ACID — a trilha de
# auditoria precisa ser gravada no mesmo commit da operação auditada.
# =============================================================================

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-subnets"
  subnet_ids = var.subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-subnets" })
}

resource "aws_security_group" "cluster" {
  name        = "${var.name}-db"
  description = "Acesso ao cluster ${var.name}"
  vpc_id      = var.vpc_id

  # Sem regra de egress: o banco não inicia conexão para lugar nenhum.
  # Um banco que não fala para fora é um banco de onde não se exfiltra por
  # conexão reversa.
  tags = merge(var.tags, { Name = "${var.name}-db" })
}

resource "aws_security_group" "proxy" {
  name        = "${var.name}-proxy"
  description = "RDS Proxy do cluster ${var.name}"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name}-proxy" })
}

# As Lambdas falam com o Proxy; só o Proxy fala com o cluster.
resource "aws_vpc_security_group_ingress_rule" "proxy_from_lambdas" {
  for_each = toset(var.allowed_security_group_ids)

  security_group_id            = aws_security_group.proxy.id
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL a partir das Lambdas do servico dono"
}

resource "aws_vpc_security_group_ingress_rule" "cluster_from_proxy" {
  security_group_id            = aws_security_group.cluster.id
  referenced_security_group_id = aws_security_group.proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL a partir do RDS Proxy"
}

resource "aws_vpc_security_group_egress_rule" "proxy_to_cluster" {
  security_group_id            = aws_security_group.proxy.id
  referenced_security_group_id = aws_security_group.cluster.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Saida do proxy para o cluster"
}

# -----------------------------------------------------------------------------
# Credenciais
# -----------------------------------------------------------------------------

resource "random_password" "master" {
  length  = 40
  special = false # evita problemas de escape em connection string
}

resource "aws_secretsmanager_secret" "credentials" {
  name                    = "${var.name}/database/master"
  description             = "Credenciais do cluster ${var.name}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 7

  tags = merge(var.tags, { Name = "${var.name}-db-credentials" })
}

resource "aws_secretsmanager_secret_version" "credentials" {
  secret_id = aws_secretsmanager_secret.credentials.id

  secret_string = jsonencode({
    username = "revenda_admin"
    password = random_password.master.result
    engine   = "postgres"
    host     = aws_rds_cluster.this.endpoint
    port     = 5432
    dbname   = var.database_name
  })
}

# -----------------------------------------------------------------------------
# Cluster
# -----------------------------------------------------------------------------

resource "aws_rds_cluster" "this" {
  cluster_identifier = var.name
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned" # exigido pelo Serverless v2
  engine_version     = "16.4"

  database_name   = var.database_name
  master_username = "revenda_admin"
  master_password = random_password.master.result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.cluster.id]

  # Criptografia em repouso com chave gerenciada pelo cliente: um snapshot
  # copiado para outra conta continua ilegível sem acesso à chave.
  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  backup_retention_period      = var.backup_retention_days
  preferred_backup_window      = "04:00-05:00"
  preferred_maintenance_window = "sun:05:30-sun:06:30"
  copy_tags_to_snapshot        = true

  # Autenticação por IAM: as Lambdas se conectam por token temporário, e não por
  # senha embarcada. A senha mestra fica para migração e emergência.
  iam_database_authentication_enabled = true

  # Exporta os logs do PostgreSQL para o CloudWatch — sem isso, uma consulta
  # lenta ou um erro de permissão só aparece no console do RDS, sem histórico.
  enabled_cloudwatch_logs_exports = ["postgresql"]

  deletion_protection       = var.environment == "prod"
  skip_final_snapshot       = var.environment != "prod"
  final_snapshot_identifier = var.environment == "prod" ? "${var.name}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}" : null

  serverlessv2_scaling_configuration {
    min_capacity = var.min_capacity
    max_capacity = var.max_capacity
  }

  lifecycle {
    ignore_changes = [final_snapshot_identifier, master_password]
  }

  tags = merge(var.tags, { Name = var.name })
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${var.name}-writer"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version

  # Performance Insights com 7 dias no nível gratuito: permite diagnosticar
  # consulta lenta depois do fato, sem custo adicional.
  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  performance_insights_kms_key_id       = var.kms_key_arn

  tags = merge(var.tags, { Name = "${var.name}-writer" })
}

# Réplica de leitura apenas em produção: em ambientes menores ela dobra o custo
# sem tráfego que a justifique. Em produção ela é também o alvo do failover
# automático.
resource "aws_rds_cluster_instance" "reader" {
  count = var.environment == "prod" ? 1 : 0

  identifier         = "${var.name}-reader"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version

  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  performance_insights_kms_key_id       = var.kms_key_arn

  tags = merge(var.tags, { Name = "${var.name}-reader" })
}

# -----------------------------------------------------------------------------
# RDS Proxy
#
# É o que torna Lambda + banco relacional viável. Cada execução concorrente de
# Lambda abriria a própria conexão; um pico de 500 execuções esgotaria o limite
# de conexões do Aurora e derrubaria o serviço. O Proxy multiplexa essas
# conexões efêmeras em poucas conexões reais e as mantém abertas entre
# invocações.
#
# Ganho adicional: durante um failover, o Proxy segura as conexões do cliente e
# reaponta para a nova instância — o que transforma minutos de erro em alguns
# segundos de latência.
# -----------------------------------------------------------------------------

resource "aws_iam_role" "proxy" {
  name = "${var.name}-proxy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "proxy_secrets" {
  role = aws_iam_role.proxy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.credentials.arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.kms_key_arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${data.aws_region.current.name}.amazonaws.com"
          }
        }
      },
    ]
  })
}

data "aws_region" "current" {}

resource "aws_db_proxy" "this" {
  name                   = "${var.name}-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = var.subnet_ids
  vpc_security_group_ids = [aws_security_group.proxy.id]

  # TLS obrigatório entre a Lambda e o Proxy: o tráfego é interno à VPC, mas
  # criptografia em trânsito não deve depender da confiança na rede.
  require_tls = true

  idle_client_timeout = 1800
  debug_logging       = false

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "REQUIRED"
    secret_arn  = aws_secretsmanager_secret.credentials.arn
    description = "Credenciais do cluster ${var.name}"
  }

  tags = merge(var.tags, { Name = "${var.name}-proxy" })
}

resource "aws_db_proxy_default_target_group" "this" {
  db_proxy_name = aws_db_proxy.this.name

  connection_pool_config {
    # 90% das conexões do cluster ficam disponíveis ao pool; a folga restante
    # permite conexão administrativa mesmo com o pool saturado.
    max_connections_percent      = 90
    max_idle_connections_percent = 50
    connection_borrow_timeout    = 120
  }
}

resource "aws_db_proxy_target" "this" {
  db_cluster_identifier = aws_rds_cluster.this.id
  db_proxy_name         = aws_db_proxy.this.name
  target_group_name     = aws_db_proxy_default_target_group.this.name
}
