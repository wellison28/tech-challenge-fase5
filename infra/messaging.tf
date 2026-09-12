# =============================================================================
# Amazon EventBridge — barramento de eventos de domínio
#
# Por que EventBridge e não SNS/SQS direto: o roteamento fica declarado em
# regras na infraestrutura, não no código do produtor. Adicionar um consumidor
# de `vehicle.sold` — um serviço de notificação, um data lake — é criar uma
# regra, sem tocar no vehicle-service. É o que mantém baixo o acoplamento entre
# os três microsserviços.
#
# Todo consumidor tem DLQ. Sem ela, um evento que falha repetidamente é
# descartado em silêncio, e a inconsistência só aparece semanas depois num
# relatório que não fecha.
# =============================================================================

resource "aws_cloudwatch_event_bus" "main" {
  name = "${local.prefix}-bus"
  tags = local.common_tags
}

# Arquivo de eventos: permite reprocessar o passado (replay) quando um
# consumidor novo precisa reconstruir o próprio estado, ou quando um bug
# derrubou o processamento de um dia.
resource "aws_cloudwatch_event_archive" "main" {
  name             = "${local.prefix}-archive"
  event_source_arn = aws_cloudwatch_event_bus.main.arn
  retention_days   = 90
  description      = "Arquivo para replay de eventos de dominio"
}

resource "aws_sqs_queue" "event_dlq" {
  name                      = "${local.prefix}-event-dlq"
  message_retention_seconds = 1209600 # 14 dias — tempo de investigar e reprocessar
  kms_master_key_id         = aws_kms_key.logs.id
  sqs_managed_sse_enabled   = false

  tags = merge(local.common_tags, { Name = "${local.prefix}-event-dlq" })
}

resource "aws_sqs_queue" "lambda_async_dlq" {
  name                      = "${local.prefix}-lambda-async-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.logs.id

  tags = merge(local.common_tags, { Name = "${local.prefix}-lambda-async-dlq" })
}

# -----------------------------------------------------------------------------
# Log de todos os eventos
#
# Grupo de log que recebe cada evento publicado. É barato e resolve a pergunta
# mais frequente em incidente de sistema distribuído: "este evento chegou a ser
# publicado?".
#
# Os eventos não carregam dado pessoal (regra verificada por teste nos três
# serviços), então registrá-los integralmente não cria exposição.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "events" {
  name              = "/aws/events/${local.prefix}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn

  tags = local.common_tags
}

resource "aws_cloudwatch_event_rule" "audit_all" {
  name           = "${local.prefix}-audit-all"
  description    = "Registra todos os eventos de dominio para diagnostico"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source = [{ prefix = "revenda." }]
  })

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "audit_all" {
  rule           = aws_cloudwatch_event_rule.audit_all.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  target_id      = "cloudwatch-logs"
  arn            = aws_cloudwatch_log_group.events.arn
}

resource "aws_cloudwatch_log_resource_policy" "events" {
  policy_name = "${local.prefix}-events-to-logs"

  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = ["events.amazonaws.com", "delivery.logs.amazonaws.com"]
      }
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.events.arn}:*"
    }]
  })
}

# -----------------------------------------------------------------------------
# Regra: anonimização de cliente propaga para os demais serviços
#
# Quando um titular exerce o direito de eliminação, os outros serviços precisam
# saber para descartar qualquer dado derivado que ainda tenham em cache ou em
# projeção. Sem essa propagação, a eliminação seria parcial — e portanto não
# seria eliminação.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "customer_anonymized" {
  name           = "${local.prefix}-customer-anonymized"
  description    = "Propaga a anonimizacao do titular (LGPD art. 18, VI)"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source        = ["revenda.customer-service"]
    "detail-type" = ["customer.anonymized"]
  })

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# EventBridge Scheduler — processos periódicos
#
# Scheduler, e não regra `rate()`: ele tem janela de tolerância, fuso horário e
# limite de repetição por invocação, e não fica preso ao barramento de eventos.
# -----------------------------------------------------------------------------

resource "aws_iam_role" "scheduler" {
  name = "${local.prefix}-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id
        }
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["lambda:InvokeFunction"]
      Resource = [
        module.lambda_expire_reservations.function_arn,
        module.lambda_expire_orders.function_arn,
        module.lambda_publish_outbox_vehicle.function_arn,
        module.lambda_publish_outbox_customer.function_arn,
        module.lambda_publish_outbox_sales.function_arn,
      ]
    }]
  })
}

# Expiração de reservas: rede de segurança do estoque. A SAGA já libera a
# reserva quando o pagamento falha, mas nenhum orquestrador é infalível — e uma
# unidade presa fora do estoque é receita perdida todo dia.
resource "aws_scheduler_schedule" "expire_reservations" {
  name                = "${local.prefix}-expire-reservations"
  description         = "Devolve ao estoque reservas vencidas"
  schedule_expression = "rate(1 minute)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.lambda_expire_reservations.function_arn
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}

# Varredura de pedidos vencidos: confere no provedor antes de compensar, para
# não custar a venda a um cliente que pagou e teve o webhook perdido.
resource "aws_scheduler_schedule" "expire_orders" {
  name                = "${local.prefix}-expire-orders"
  description         = "Reconcilia e compensa pedidos com janela de pagamento vencida"
  schedule_expression = "rate(1 minute)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.lambda_expire_orders.function_arn
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}

# Despacho do outbox: entrega ao EventBridge os eventos gravados na mesma
# transação da mudança de estado.
locals {
  outbox_functions = {
    vehicle  = module.lambda_publish_outbox_vehicle.function_arn
    customer = module.lambda_publish_outbox_customer.function_arn
    sales    = module.lambda_publish_outbox_sales.function_arn
  }
}

resource "aws_scheduler_schedule" "publish_outbox" {
  for_each = local.outbox_functions

  name                = "${local.prefix}-publish-outbox-${each.key}"
  description         = "Despacha o outbox transacional do ${each.key}-service"
  schedule_expression = "rate(1 minute)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = each.value
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      maximum_retry_attempts = 3
    }

    dead_letter_config {
      arn = aws_sqs_queue.event_dlq.arn
    }
  }
}
