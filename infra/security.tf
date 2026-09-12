# =============================================================================
# Serviços de segurança
#
# Cada recurso aqui responde a uma ameaça concreta. A justificativa de cada
# escolha está no comentário e, em forma narrativa, em
# docs/relatorio-seguranca.md.
# =============================================================================

data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# AWS KMS — chaves gerenciadas pelo cliente (CMK), uma por finalidade
#
# Chaves separadas em vez de uma única: a política de cada chave define quem
# pode usá-la. Com uma chave só, quem pudesse decifrar log poderia decifrar CPF.
# A separação é o que torna o menor privilégio exequível na criptografia.
#
# Rotação automática anual: reduz a janela de exposição de uma chave
# eventualmente comprometida, sem exigir reescrita dos dados (o KMS mantém o
# material antigo para decifrar o que já foi cifrado).
# -----------------------------------------------------------------------------

resource "aws_kms_key" "customer_pii" {
  description             = "Dados pessoais dos compradores (envelope encryption em nivel de campo)"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  # 30 dias para desfazer uma exclusão acidental. Apagar esta chave torna todo
  # dado pessoal da plataforma permanentemente ilegível.
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PermiteAdministracaoPelaConta"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        # Somente o customer-service decifra dado pessoal, e somente
        # apresentando o mesmo contexto de criptografia usado na cifragem
        # (customerId + campo). Sem o contexto correto, a chave não abre — o que
        # impede mover o CPF cifrado de um titular para a linha de outro.
        Sid    = "PermiteApenasCustomerServiceComContexto"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.lambda_execution["customer"].arn
        }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:service" = "customer-service"
          }
        }
      },
    ]
  })

  tags = { Name = "${local.prefix}-kms-customer-pii", DataClass = "personal" }
}

resource "aws_kms_alias" "customer_pii" {
  name          = "alias/${local.prefix}-customer-pii"
  target_key_id = aws_kms_key.customer_pii.key_id
}

resource "aws_kms_key" "database" {
  description             = "Criptografia em repouso dos clusters Aurora"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30

  tags = { Name = "${local.prefix}-kms-database" }
}

resource "aws_kms_alias" "database" {
  name          = "alias/${local.prefix}-database"
  target_key_id = aws_kms_key.database.key_id
}

resource "aws_kms_key" "logs" {
  description             = "Criptografia dos grupos de log do CloudWatch"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 7

  # O CloudWatch Logs precisa de permissão explícita para usar a chave.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Effect    = "Allow"
        Principal = { Service = "logs.${var.aws_region}.amazonaws.com" }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:*"
          }
        }
      },
    ]
  })

  tags = { Name = "${local.prefix}-kms-logs" }
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${local.prefix}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

# -----------------------------------------------------------------------------
# AWS Secrets Manager
#
# Segredos não vão para variável de ambiente da Lambda: elas aparecem no
# console, em `GetFunctionConfiguration` — uma permissão de leitura comum — e em
# qualquer despejo de diagnóstico. O Secrets Manager mantém o valor cifrado com
# KMS, registra cada leitura no CloudTrail e permite rotação.
# -----------------------------------------------------------------------------

resource "random_password" "cpf_pepper" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "cpf_pepper" {
  name        = "${local.prefix}/customer-service/cpf-pepper"
  description = "Pepper do indice cego de CPF. Sem ele, os hashes viram alvo de ataque de dicionario."
  kms_key_id  = aws_kms_key.customer_pii.arn
  # 30 dias: tempo suficiente para recuperar uma exclusão acidental. Perder este
  # segredo inutiliza a busca por CPF em toda a base.
  recovery_window_in_days = 30

  tags = { Name = "${local.prefix}-cpf-pepper", DataClass = "secret" }
}

resource "aws_secretsmanager_secret_version" "cpf_pepper" {
  secret_id     = aws_secretsmanager_secret.cpf_pepper.id
  secret_string = random_password.cpf_pepper.result

  lifecycle {
    # A rotação é feita fora do Terraform; sem isto, cada `apply` geraria um
    # pepper novo e invalidaria todos os índices cegos existentes.
    ignore_changes = [secret_string]
  }
}

resource "random_password" "payment_webhook_secret" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "payment_webhook" {
  name                    = "${local.prefix}/sales-service/payment-webhook-secret"
  description             = "Segredo HMAC do webhook de pagamento. Sem ele, qualquer um declara um pedido como pago."
  recovery_window_in_days = 7

  tags = { Name = "${local.prefix}-payment-webhook" }
}

resource "aws_secretsmanager_secret_version" "payment_webhook" {
  secret_id     = aws_secretsmanager_secret.payment_webhook.id
  secret_string = random_password.payment_webhook_secret.result

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# -----------------------------------------------------------------------------
# AWS WAF — proteção de borda da API
#
# Fica no API Gateway, antes de qualquer Lambda: uma requisição bloqueada aqui
# não é faturada como invocação nem consome conexão do banco. É defesa e
# controle de custo ao mesmo tempo.
# -----------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "api" {
  name        = "${local.prefix}-api-waf"
  description = "Protecao de borda da API da revenda"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # Regra 1 — limite de taxa por IP.
  # Barra varredura do catálogo e, principalmente, enumeração de CPF no
  # endpoint de cadastro.
  rule {
    name     = "limite-de-taxa-por-ip"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000 # requisições por IP em 5 minutos
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "limite-de-taxa-por-ip"
      sampled_requests_enabled   = true
    }
  }

  # Regra 2 — limite muito mais apertado no cadastro de clientes.
  # É o endpoint público que revela, pelo erro de duplicidade, se um CPF já está
  # cadastrado. Sem este limite, a base de titulares seria enumerável.
  rule {
    name     = "limite-de-taxa-no-cadastro"
    priority = 2

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 100
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/customers"
            positional_constraint = "STARTS_WITH"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "limite-de-taxa-no-cadastro"
      sampled_requests_enabled   = true
    }
  }

  # Regra 3 — conjunto básico gerenciado pela AWS (OWASP Top 10).
  # Mantido em `count` para SQLi e XSS? Não: aqui bloqueia. A API é JSON com
  # validação de schema, e um falso positivo é preferível a uma injeção.
  rule {
    name     = "aws-regras-comuns"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        # O corpo do cadastro tem endereço e nome completo; a regra de tamanho
        # de corpo geraria falso positivo em payloads legítimos.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-regras-comuns"
      sampled_requests_enabled   = true
    }
  }

  # Regra 4 — entradas maliciosas conhecidas (SQLi, path traversal).
  rule {
    name     = "aws-entradas-maliciosas"
    priority = 4

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-entradas-maliciosas"
      sampled_requests_enabled   = true
    }
  }

  # Regra 5 — reputação de IP: origens associadas a botnet e varredura.
  rule {
    name     = "aws-reputacao-de-ip"
    priority = 5

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-reputacao-de-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.prefix}-api-waf"
    sampled_requests_enabled   = true
  }

  tags = { Name = "${local.prefix}-api-waf" }
}

# -----------------------------------------------------------------------------
# Detecção: GuardDuty, Security Hub, CloudTrail
# -----------------------------------------------------------------------------

# GuardDuty analisa CloudTrail, VPC Flow Logs e DNS em busca de comportamento
# anômalo — credencial usada de geografia incomum, chamada de API típica de
# exfiltração, comunicação com IP de mineração. É detecção que nenhuma regra
# escrita à mão cobriria.
resource "aws_guardduty_detector" "main" {
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"

  datasources {
    s3_logs {
      enable = true
    }
  }

  tags = { Name = "${local.prefix}-guardduty" }
}

# Security Hub consolida os achados de GuardDuty, Config e Inspector e mede a
# conformidade contra o CIS Benchmark. É o painel único de postura.
resource "aws_securityhub_account" "main" {}

resource "aws_securityhub_standards_subscription" "cis" {
  standards_arn = "arn:aws:securityhub:${var.aws_region}::standards/cis-aws-foundations-benchmark/v/1.4.0"
  depends_on    = [aws_securityhub_account.main]
}

resource "aws_securityhub_standards_subscription" "best_practices" {
  standards_arn = "arn:aws:securityhub:${var.aws_region}::standards/aws-foundational-security-best-practices/v/1.0.0"
  depends_on    = [aws_securityhub_account.main]
}

# -----------------------------------------------------------------------------
# CloudTrail — trilha de auditoria da própria nuvem
#
# Registra cada chamada de API na conta, inclusive cada `kms:Decrypt`. É o que
# permite responder, depois do fato, "quem decifrou dado pessoal e quando" —
# mesmo que o atacante tenha comprometido a aplicação.
#
# A trilha é multi-região e validada: `enable_log_file_validation` gera um
# resumo assinado que detecta remoção ou alteração de arquivos de log.
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "cloudtrail" {
  bucket        = "${local.prefix}-cloudtrail-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = { Name = "${local.prefix}-cloudtrail" }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  # Versionamento: um atacante que sobrescreva um objeto de log não apaga a
  # versão anterior.
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    id     = "arquivar-e-expirar"
    status = "Enabled"

    filter {}

    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }

    expiration {
      # 400 dias: cobre o prazo de investigação de incidente e a exigência de
      # retenção de trilha de auditoria, sem acumular custo indefinidamente.
      days = 400
    }
  }
}

data "aws_iam_policy_document" "cloudtrail_bucket" {
  statement {
    sid     = "PermiteVerificacaoDeAclPeloCloudTrail"
    effect  = "Allow"
    actions = ["s3:GetBucketAcl"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    resources = [aws_s3_bucket.cloudtrail.arn]
  }

  statement {
    sid     = "PermiteEscritaPeloCloudTrail"
    effect  = "Allow"
    actions = ["s3:PutObject"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }

  # Nega qualquer tentativa de apagar objeto do bucket, inclusive pela conta.
  # Apagar log exige antes remover esta política, o que por si já fica
  # registrado no CloudTrail.
  statement {
    sid     = "NegaExclusaoDeLogs"
    effect  = "Deny"
    actions = ["s3:DeleteObject", "s3:DeleteObjectVersion"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    resources = ["${aws_s3_bucket.cloudtrail.arn}/*"]
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = data.aws_iam_policy_document.cloudtrail_bucket.json
}

resource "aws_cloudtrail" "main" {
  name                          = "${local.prefix}-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true

  # Eventos de dados do KMS: registra individualmente cada operação de
  # decifragem de dado pessoal.
  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  depends_on = [aws_s3_bucket_policy.cloudtrail]

  tags = { Name = "${local.prefix}-trail" }
}
