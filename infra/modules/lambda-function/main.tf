# =============================================================================
# Função Lambda padronizada da plataforma.
#
# Centraliza as decisões que devem valer para todas as funções: log cifrado com
# retenção definida, tracing ativo, runtime atual e configuração de VPC. Criar
# funções fora deste módulo abriria espaço para uma delas nascer sem log
# cifrado ou sem rastreamento.
# =============================================================================

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn

  tags = var.tags
}

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  description   = var.description
  role          = var.role_arn
  handler       = var.handler
  runtime       = "nodejs20.x"
  architectures = ["arm64"] # Graviton: ~20% mais barato, mesmo desempenho aqui

  s3_bucket = var.artifacts_bucket
  s3_key    = var.artifact_key

  memory_size = var.memory_size
  timeout     = var.timeout

  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = var.environment_variables
  }

  dynamic "vpc_config" {
    for_each = length(var.subnet_ids) > 0 ? [1] : []

    content {
      subnet_ids         = var.subnet_ids
      security_group_ids = var.security_group_ids
    }
  }

  dynamic "dead_letter_config" {
    for_each = var.dead_letter_target_arn != null ? [1] : []

    content {
      target_arn = var.dead_letter_target_arn
    }
  }

  # Rastreamento distribuído: sem ele, uma compra lenta é um mistério
  # atravessando três serviços e um Step Functions.
  tracing_config {
    mode = "Active"
  }

  # Garante que o grupo de log exista antes da função; caso contrário a Lambda
  # cria um grupo sem retenção nem criptografia na primeira invocação.
  depends_on = [aws_cloudwatch_log_group.this]

  tags = var.tags
}
