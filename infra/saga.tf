# =============================================================================
# AWS Step Functions — orquestrador da SAGA de compra
#
# A justificativa completa da escolha (orquestração × coreografia) está em
# docs/relatorio-saga.md. Em resumo: o processo tem compensação explícita,
# timeout de negócio e espera por evento externo — três coisas que a coreografia
# resolve mal, porque nela ninguém detém a visão do todo.
#
# Tipo STANDARD e não EXPRESS: a execução dura até 25 minutos (a janela de
# pagamento), muito além do limite de 5 minutos do Express. O Standard também
# guarda o histórico completo de cada execução, que é o que permite responder
# "por que esta compra falhou" abrindo uma tela, sem correlacionar logs.
# =============================================================================

resource "aws_cloudwatch_log_group" "saga" {
  name              = "/aws/vendedlogs/states/${local.prefix}-purchase-saga"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn

  tags = local.common_tags
}

resource "aws_iam_role" "saga" {
  name = "${local.prefix}-purchase-saga"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
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

resource "aws_iam_role_policy" "saga" {
  name = "execucao-da-saga"
  role = aws_iam_role.saga.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "InvocaApenasAsTasksDaSaga"
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        # Lista explícita: a máquina de estados não pode invocar qualquer
        # Lambda da conta, apenas os passos que lhe pertencem.
        Resource = [for task in module.lambda_saga_task : task.function_arn]
      },
      {
        Sid    = "RegistroDeExecucao"
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups",
        ]
        Resource = "*"
      },
      {
        Sid      = "Rastreamento"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_sfn_state_machine" "purchase_saga" {
  name     = "${local.prefix}-purchase-saga"
  role_arn = aws_iam_role.saga.arn
  type     = "STANDARD"

  definition = templatefile("${path.module}/../sales-service/infra/statemachine/purchase-saga.asl.json", {
    reserve_vehicle_function_arn         = module.lambda_saga_task["reserve-vehicle"].function_arn
    validate_customer_function_arn       = module.lambda_saga_task["validate-customer"].function_arn
    create_payment_function_arn          = module.lambda_saga_task["create-payment"].function_arn
    register_payment_waiter_function_arn = module.lambda_saga_task["register-payment-waiter"].function_arn
    confirm_sale_function_arn            = module.lambda_saga_task["confirm-sale"].function_arn
    compensate_function_arn              = module.lambda_saga_task["compensate"].function_arn
    payment_window_seconds               = local.payment_window_seconds
  })

  logging_configuration {
    log_destination = "${aws_cloudwatch_log_group.saga.arn}:*"
    # ALL e não ERROR: o histórico completo de cada execução é o instrumento de
    # diagnóstico da SAGA. Sem ele, uma execução que compensou vira mistério.
    level                  = "ALL"
    include_execution_data = true
  }

  tracing_configuration {
    enabled = true
  }

  tags = merge(local.common_tags, { Name = "${local.prefix}-purchase-saga" })
}
