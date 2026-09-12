# =============================================================================
# IAM — um papel de execução por serviço
#
# As permissões são escritas por serviço, e não por plataforma: o papel do
# vehicle-service não tem `kms:Decrypt` na chave de dados pessoais, e o do
# customer-service não tem permissão para iniciar execuções da SAGA. Um papel
# compartilhado transformaria qualquer comprometimento em acesso total.
# =============================================================================

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_execution" {
  for_each = local.services

  name               = "${local.prefix}-lambda-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(local.common_tags, { Service = each.value.name })
}

# Permissões comuns: rede na VPC, log e rastreamento.
# A política gerenciada `AWSLambdaVPCAccessExecutionRole` cobre as ENIs.
resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  for_each = local.services

  role       = aws_iam_role.lambda_execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_xray" {
  for_each = local.services

  role       = aws_iam_role.lambda_execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# -----------------------------------------------------------------------------
# Banco de dados: conexão por token IAM, não por senha embarcada
# -----------------------------------------------------------------------------

resource "aws_iam_role_policy" "lambda_database" {
  for_each = local.services

  name = "acesso-ao-banco"
  role = aws_iam_role.lambda_execution[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ConexaoPorTokenIam"
        Effect = "Allow"
        Action = ["rds-db:connect"]
        # Restrito ao proxy e ao usuário do próprio serviço.
        Resource = "arn:aws:rds-db:${var.aws_region}:${data.aws_caller_identity.current.account_id}:dbuser:${split(":", module.database[each.key].proxy_arn)[6]}/${each.key}_service_app"
      },
      # Sem GetSecretValue em segredo de banco: com o token IAM a Lambda não
      # precisa de senha nenhuma — nem a master, nem a do usuário de aplicação.
    ]
  })
}

# -----------------------------------------------------------------------------
# Mensageria: publicar eventos no barramento
# -----------------------------------------------------------------------------

resource "aws_iam_role_policy" "lambda_events" {
  for_each = local.services

  name = "publicacao-de-eventos"
  role = aws_iam_role.lambda_execution[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = aws_cloudwatch_event_bus.main.arn
      Condition = {
        # Só permite publicar eventos cuja origem é o próprio serviço: impede
        # que um serviço comprometido forje eventos em nome de outro.
        StringEquals = {
          "events:source" = "revenda.${each.value.name}"
        }
      }
    }]
  })
}

# -----------------------------------------------------------------------------
# Criptografia de dados pessoais — EXCLUSIVO do customer-service
# -----------------------------------------------------------------------------

resource "aws_iam_role_policy" "customer_service_crypto" {
  name = "criptografia-de-dados-pessoais"
  role = aws_iam_role.lambda_execution["customer"].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnvelopeEncryptionComContextoObrigatorio"
        Effect = "Allow"
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.customer_pii.arn
        Condition = {
          # O contexto de criptografia é obrigatório dos dois lados: aqui e na
          # política da chave. Uma decifragem sem contexto é recusada.
          StringEquals = {
            "kms:EncryptionContext:service" = "customer-service"
          }
        }
      },
      {
        Sid      = "PepperDoIndiceCego"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.cpf_pepper.arn
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# Orquestração — EXCLUSIVO do sales-service
# -----------------------------------------------------------------------------

resource "aws_iam_role_policy" "sales_service_saga" {
  name = "orquestracao-da-saga"
  role = aws_iam_role.lambda_execution["sales"].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "IniciarExecucaoDaSaga"
        Effect   = "Allow"
        Action   = ["states:StartExecution"]
        Resource = aws_sfn_state_machine.purchase_saga.arn
      },
      {
        Sid    = "RetomarExecucaoSuspensa"
        Effect = "Allow"
        Action = [
          "states:SendTaskSuccess",
          "states:SendTaskFailure",
          "states:SendTaskHeartbeat",
        ]
        # As APIs de callback não aceitam restrição por recurso: o token em si
        # é a autorização, e ele é opaco, de uso único e guardado cifrado.
        Resource = "*"
      },
      {
        Sid    = "SegredosDeIntegracao"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.payment_webhook.arn,
          aws_secretsmanager_secret.sales_m2m_credentials.arn,
        ]
      },
    ]
  })
}
