# =============================================================================
# Observabilidade e alarmes
#
# Os alarmes aqui não cobrem "CPU alta": cobrem os estados de negócio que
# significam dinheiro parado ou dado exposto. É a diferença entre um painel que
# alguém olha e um painel que acorda alguém.
# =============================================================================

resource "aws_sns_topic" "alarms" {
  name              = "${local.prefix}-alarms"
  kms_master_key_id = aws_kms_key.logs.id

  tags = local.common_tags
}

resource "aws_sns_topic_subscription" "alarms_email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# -----------------------------------------------------------------------------
# Alarme mais crítico: compensação que não concluiu
#
# Significa que um veículo pode estar preso fora do estoque, ou uma cobrança
# ativa sem pedido correspondente. É o único alarme que justifica acordar alguém
# de madrugada.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "saga_compensation_failed" {
  alarm_name          = "${local.prefix}-compensacao-da-saga-falhou"
  alarm_description   = "A SAGA nao conseguiu desfazer os efeitos de uma compra. Veiculo possivelmente preso fora do estoque."
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    StateMachineArn = aws_sfn_state_machine.purchase_saga.arn
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "saga_execution_time" {
  alarm_name         = "${local.prefix}-saga-demorando-demais"
  alarm_description  = "Execucoes da SAGA passando do tempo esperado: indica parceiro lento ou travado."
  namespace          = "AWS/States"
  metric_name        = "ExecutionTime"
  extended_statistic = "p95"
  period             = 300
  evaluation_periods = 2
  # Janela de pagamento + folga: acima disso, algo prendeu a execução.
  threshold           = (var.payment_window_minutes + 5) * 60 * 1000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    StateMachineArn = aws_sfn_state_machine.purchase_saga.arn
  }

  alarm_actions = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Eventos não entregues
#
# Mensagem parada na DLQ é inconsistência silenciosa entre serviços: o estoque
# mudou e alguém não soube.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  for_each = {
    eventos = aws_sqs_queue.event_dlq.name
    lambdas = aws_sqs_queue.lambda_async_dlq.name
  }

  alarm_name          = "${local.prefix}-dlq-${each.key}-com-mensagens"
  alarm_description   = "Ha mensagens na fila de mensagens mortas (${each.key}): inconsistencia entre servicos."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = each.value
  }

  alarm_actions = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Erros nas APIs
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = {
    vehicle  = module.lambda_vehicle_api.function_name
    customer = module.lambda_customer_api.function_name
    sales    = module.lambda_sales_api.function_name
  }

  alarm_name          = "${local.prefix}-erros-na-api-${each.key}"
  alarm_description   = "Taxa de erro elevada na API do ${each.key}-service."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  alarm_actions = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# Throttling significa que o teto de concorrência foi atingido: requisições
# legítimas estão sendo recusadas e o limite precisa ser revisto.
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each = {
    vehicle  = module.lambda_vehicle_api.function_name
    customer = module.lambda_customer_api.function_name
    sales    = module.lambda_sales_api.function_name
  }

  alarm_name          = "${local.prefix}-throttling-na-api-${each.key}"
  alarm_description   = "Limite de concorrencia atingido no ${each.key}-service."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  alarm_actions = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Alarme de privacidade: acesso negado a dado pessoal
#
# Um pico de negativas no customer-service significa uma credencial tentando ler
# o que não lhe pertence — varredura da base, token reutilizado para outra
# finalidade, ou serviço mal configurado. É o sinal mais precoce de
# comprometimento que a plataforma produz.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "pii_access_denied" {
  name           = "${local.prefix}-acesso-negado-a-dado-pessoal"
  log_group_name = module.lambda_customer_api.log_group_name
  pattern        = "{ $.level = \"warn\" && $.action = \"access_other_customer\" }"

  metric_transformation {
    name      = "AcessoNegadoADadoPessoal"
    namespace = "Revenda/Privacidade"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "pii_access_denied" {
  alarm_name          = "${local.prefix}-tentativas-de-acesso-indevido-a-dado-pessoal"
  alarm_description   = "Varias tentativas de acessar o cadastro de outro titular: possivel conta comprometida."
  namespace           = "Revenda/Privacidade"
  metric_name         = "AcessoNegadoADadoPessoal"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Achados críticos do GuardDuty
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "guardduty_high_severity" {
  name        = "${local.prefix}-guardduty-alta-severidade"
  description = "Encaminha achados do GuardDuty com severidade alta ou critica"

  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
    detail = {
      # 7.0+ é a faixa de severidade alta e crítica do GuardDuty.
      severity = [{ numeric = [">=", 7] }]
    }
  })

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "guardduty_to_sns" {
  rule      = aws_cloudwatch_event_rule.guardduty_high_severity.name
  target_id = "sns"
  arn       = aws_sns_topic.alarms.arn
}

resource "aws_sns_topic_policy" "alarms" {
  arn = aws_sns_topic.alarms.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = ["cloudwatch.amazonaws.com", "events.amazonaws.com"] }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.alarms.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# Painel operacional
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.prefix}-plataforma"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "SAGA de compra — execuções"
          region = var.aws_region
          metrics = [
            ["AWS/States", "ExecutionsStarted", "StateMachineArn", aws_sfn_state_machine.purchase_saga.arn, { label = "Iniciadas" }],
            [".", "ExecutionsSucceeded", ".", ".", { label = "Concluídas" }],
            [".", "ExecutionsFailed", ".", ".", { label = "Falhas (compensação incompleta)" }],
            [".", "ExecutionsTimedOut", ".", ".", { label = "Expiradas" }],
          ]
          stat   = "Sum"
          period = 300
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "APIs — invocações e erros"
          region = var.aws_region
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", module.lambda_vehicle_api.function_name, { label = "Veículos" }],
            [".", "Invocations", ".", module.lambda_customer_api.function_name, { label = "Clientes" }],
            [".", "Invocations", ".", module.lambda_sales_api.function_name, { label = "Vendas" }],
            [".", "Errors", ".", module.lambda_sales_api.function_name, { label = "Erros em vendas", color = "#d62728" }],
          ]
          stat   = "Sum"
          period = 300
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Bancos — capacidade em uso (ACU)"
          region = var.aws_region
          metrics = [
            for key, service in local.services :
            ["AWS/RDS", "ServerlessDatabaseCapacity", "DBClusterIdentifier", module.database[key].cluster_identifier, { label = service.name }]
          ]
          stat   = "Average"
          period = 300
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Privacidade — acessos negados a dado pessoal"
          region = var.aws_region
          metrics = [
            ["Revenda/Privacidade", "AcessoNegadoADadoPessoal", { label = "Tentativas recusadas" }],
          ]
          stat   = "Sum"
          period = 300
        }
      },
    ]
  })
}
