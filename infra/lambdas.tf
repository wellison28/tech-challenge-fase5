# =============================================================================
# Funções Lambda
#
# Três APIs (uma por serviço) e cinco funções de segundo plano. Todas usam o
# módulo `lambda-function`, que padroniza log cifrado, retenção, rastreamento e
# runtime.
#
# Por que Lambda e não contêineres em ECS/Fargate: o tráfego de uma revenda é
# irregular e concentrado em horário comercial. Com Fargate, paga-se a tarefa
# rodando 24 horas por dia para atender um pico de poucas horas. A Lambda cobra
# por invocação e escala do zero — e o código, escrito em hexagonal, roda nos
# dois modelos sem alteração (há Dockerfile em cada serviço justamente para
# preservar essa saída).
# =============================================================================

locals {
  # Variáveis comuns a todas as funções.
  common_env = {
    NODE_ENV             = "production"
    LOG_LEVEL            = var.environment == "prod" ? "info" : "debug"
    AWS_REGION_APP       = var.aws_region
    EVENT_BUS_NAME       = aws_cloudwatch_event_bus.main.name
    AUTH_MODE            = "cognito"
    DB_AUTH_MODE         = "iam"
    COGNITO_ISSUER       = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
    COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id
    COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.web.id
  }

  # A senha real não aparece aqui: a aplicação monta a connection string a
  # partir do token IAM, e a URL traz apenas host, porta e banco.
  database_urls = {
    for key, service in local.services :
    key => "postgresql://${key}_service_app@${module.database[key].proxy_endpoint}:5432/${service.database_name}?schema=public&sslmode=require"
  }

  artifact_keys = {
    vehicle  = "vehicle-service/${var.lambda_artifact_version}.zip"
    customer = "customer-service/${var.lambda_artifact_version}.zip"
    sales    = "sales-service/${var.lambda_artifact_version}.zip"
  }
}

# -----------------------------------------------------------------------------
# APIs
# -----------------------------------------------------------------------------

module "lambda_vehicle_api" {
  source = "./modules/lambda-function"

  function_name = "${local.prefix}-vehicle-api"
  description   = "API do catalogo e estoque de veiculos"
  handler       = "dist/lambda-api.handler"

  artifacts_bucket = var.lambda_artifacts_bucket
  artifact_key     = local.artifact_keys.vehicle
  role_arn         = aws_iam_role.lambda_execution["vehicle"].arn

  memory_size = 1024
  # Menor que os 29s do API Gateway: a função precisa falhar antes do gateway
  # desistir, ou o cliente recebe 504 sem nenhum log correspondente.
  timeout = 25
  # Teto de concorrência: protege o pool do RDS Proxy de um pico de tráfego.
  reserved_concurrency = 50

  subnet_ids         = [for subnet in aws_subnet.application : subnet.id]
  security_group_ids = [aws_security_group.lambda["vehicle"].id]

  environment_variables = merge(local.common_env, {
    SERVICE_NAME            = "vehicle-service"
    DATABASE_URL            = local.database_urls.vehicle
    RESERVATION_TTL_MINUTES = tostring(var.reservation_ttl_minutes)
    CORS_ALLOWED_ORIGINS    = join(",", var.frontend_origins)
  })

  log_retention_days = var.log_retention_days
  log_kms_key_arn    = aws_kms_key.logs.arn

  tags = merge(local.common_tags, { Service = "vehicle-service" })
}

module "lambda_customer_api" {
  source = "./modules/lambda-function"

  function_name = "${local.prefix}-customer-api"
  description   = "API de cadastro de compradores e dados pessoais"
  handler       = "dist/lambda-api.handler"

  artifacts_bucket = var.lambda_artifacts_bucket
  artifact_key     = local.artifact_keys.customer
  role_arn         = aws_iam_role.lambda_execution["customer"].arn

  # Mais memória: cada requisição pode envolver uma chamada ao KMS e a
  # decifragem do envelope. Mais CPU encurta o tempo total e reduz o custo.
  memory_size          = 1536
  timeout              = 25
  reserved_concurrency = 30

  subnet_ids         = [for subnet in aws_subnet.application : subnet.id]
  security_group_ids = [aws_security_group.lambda["customer"].id]

  environment_variables = merge(local.common_env, {
    SERVICE_NAME = "customer-service"
    DATABASE_URL = local.database_urls.customer
    CRYPTO_MODE  = "kms"
    KMS_KEY_ID   = aws_kms_key.customer_pii.arn
    # Apenas o identificador do segredo; o valor é buscado em tempo de execução.
    CPF_PEPPER_SECRET_ID   = aws_secretsmanager_secret.cpf_pepper.name
    BLIND_INDEX_VERSION    = "1"
    PRIVACY_POLICY_VERSION = "2026-01"
    FISCAL_RETENTION_YEARS = "5"
    CORS_ALLOWED_ORIGINS   = join(",", var.frontend_origins)
  })

  log_retention_days = var.log_retention_days
  log_kms_key_arn    = aws_kms_key.logs.arn

  tags = merge(local.common_tags, { Service = "customer-service", DataClass = "personal" })
}

module "lambda_sales_api" {
  source = "./modules/lambda-function"

  function_name = "${local.prefix}-sales-api"
  description   = "API do processo de compra e webhook de pagamento"
  handler       = "dist/lambda-api.handler"

  artifacts_bucket = var.lambda_artifacts_bucket
  artifact_key     = local.artifact_keys.sales
  role_arn         = aws_iam_role.lambda_execution["sales"].arn

  memory_size          = 1024
  timeout              = 25
  reserved_concurrency = 50

  subnet_ids         = [for subnet in aws_subnet.application : subnet.id]
  security_group_ids = [aws_security_group.lambda["sales"].id]

  environment_variables = merge(local.common_env, local.sales_env, {
    SERVICE_NAME         = "sales-service"
    DATABASE_URL         = local.database_urls.sales
    CORS_ALLOWED_ORIGINS = join(",", var.frontend_origins)
  })

  log_retention_days = var.log_retention_days
  log_kms_key_arn    = aws_kms_key.logs.arn

  tags = merge(local.common_tags, { Service = "sales-service" })
}

locals {
  sales_env = {
    SAGA_MODE                       = "stepfunctions"
    PURCHASE_SAGA_STATE_MACHINE_ARN = local.purchase_saga_arn
    VEHICLE_SERVICE_URL             = "https://${aws_apigatewayv2_api.main.id}.execute-api.${var.aws_region}.amazonaws.com"
    CUSTOMER_SERVICE_URL            = "https://${aws_apigatewayv2_api.main.id}.execute-api.${var.aws_region}.amazonaws.com"
    PAYMENT_PROVIDER                = "http"
    PAYMENT_WEBHOOK_SECRET_ID       = aws_secretsmanager_secret.payment_webhook.name
    M2M_CREDENTIALS_SECRET_ID       = aws_secretsmanager_secret.sales_m2m_credentials.name
    M2M_TOKEN_URL                   = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com/oauth2/token"
    PAYMENT_WINDOW_MINUTES          = tostring(var.payment_window_minutes)
    VEHICLE_RESERVATION_TTL_MINUTES = tostring(var.reservation_ttl_minutes)
  }
}

# -----------------------------------------------------------------------------
# Tasks da SAGA
#
# Uma função por passo. Separá-las permite dimensionar, limitar concorrência e
# alarmar cada passo de forma independente — e o histórico do Step Functions
# mostra exatamente qual passo falhou, sem precisar correlacionar logs.
# -----------------------------------------------------------------------------

locals {
  saga_tasks = {
    reserve-vehicle = {
      handler     = "dist/lambda-saga.reserveVehicleTask"
      description = "Passo 1 da SAGA: reservar o veiculo"
    }
    validate-customer = {
      handler     = "dist/lambda-saga.validateCustomerTask"
      description = "Passo 2 da SAGA: validar o comprador"
    }
    create-payment = {
      handler     = "dist/lambda-saga.createPaymentTask"
      description = "Passo 3 da SAGA: emitir o codigo de pagamento"
    }
    register-payment-waiter = {
      handler     = "dist/lambda-saga.registerPaymentWaiterTask"
      description = "Passo 4 da SAGA: registrar o token de callback e suspender"
    }
    confirm-sale = {
      handler     = "dist/lambda-saga.confirmSaleTask"
      description = "Passo 5 da SAGA: dar baixa no estoque"
    }
    compensate = {
      handler     = "dist/lambda-saga.compensateTask"
      description = "Compensacao da SAGA: cancelar cobranca e liberar reserva"
    }
  }
}

module "lambda_saga_task" {
  source   = "./modules/lambda-function"
  for_each = local.saga_tasks

  function_name = "${local.prefix}-saga-${each.key}"
  description   = each.value.description
  handler       = each.value.handler

  artifacts_bucket = var.lambda_artifacts_bucket
  artifact_key     = local.artifact_keys.sales
  role_arn         = aws_iam_role.lambda_execution["sales"].arn

  memory_size = 512
  timeout     = 30

  subnet_ids         = [for subnet in aws_subnet.application : subnet.id]
  security_group_ids = [aws_security_group.lambda["sales"].id]

  environment_variables = merge(local.common_env, local.sales_env, {
    SERVICE_NAME = "sales-service"
    DATABASE_URL = local.database_urls.sales
  })

  log_retention_days     = var.log_retention_days
  log_kms_key_arn        = aws_kms_key.logs.arn
  dead_letter_target_arn = aws_sqs_queue.lambda_async_dlq.arn

  tags = merge(local.common_tags, { Service = "sales-service", SagaStep = each.key })
}

resource "aws_lambda_permission" "saga_task_from_states" {
  for_each = local.saga_tasks

  statement_id  = "PermiteInvocacaoPeloStepFunctions"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_saga_task[each.key].function_name
  principal     = "states.amazonaws.com"
  source_arn    = aws_sfn_state_machine.purchase_saga.arn
}

# -----------------------------------------------------------------------------
# Processos periódicos
# -----------------------------------------------------------------------------

module "lambda_expire_reservations" {
  source = "./modules/lambda-function"

  function_name = "${local.prefix}-expire-reservations"
  description   = "Devolve ao estoque reservas vencidas (rede de seguranca)"
  handler       = "dist/lambda-jobs.expireReservationsHandler"

  artifacts_bucket = var.lambda_artifacts_bucket
  artifact_key     = local.artifact_keys.vehicle
  role_arn         = aws_iam_role.lambda_execution["vehicle"].arn

  memory_size = 512
  timeout     = 60
  # Uma execução por vez: duas varreduras simultâneas disputariam as mesmas
  # linhas e uma delas perderia toda a trava otimista, sem ganho nenhum.
  reserved_concurrency = 1

  subnet_ids         = [for subnet in aws_subnet.application : subnet.id]
  security_group_ids = [aws_security_group.lambda["vehicle"].id]

  environment_variables = merge(local.common_env, {
    SERVICE_NAME            = "vehicle-service"
    DATABASE_URL            = local.database_urls.vehicle
    RESERVATION_TTL_MINUTES = tostring(var.reservation_ttl_minutes)
  })

  log_retention_days     = var.log_retention_days
  log_kms_key_arn        = aws_kms_key.logs.arn
  dead_letter_target_arn = aws_sqs_queue.lambda_async_dlq.arn

  tags = merge(local.common_tags, { Service = "vehicle-service" })
}

module "lambda_expire_orders" {
  source = "./modules/lambda-function"

  function_name = "${local.prefix}-expire-orders"
  description   = "Reconcilia com o provedor e compensa pedidos vencidos"
  handler       = "dist/lambda-saga.expireOrdersTask"

  artifacts_bucket = var.lambda_artifacts_bucket
  artifact_key     = local.artifact_keys.sales
  role_arn         = aws_iam_role.lambda_execution["sales"].arn

  memory_size          = 512
  timeout              = 120
  reserved_concurrency = 1

  subnet_ids         = [for subnet in aws_subnet.application : subnet.id]
  security_group_ids = [aws_security_group.lambda["sales"].id]

  environment_variables = merge(local.common_env, local.sales_env, {
    SERVICE_NAME = "sales-service"
    DATABASE_URL = local.database_urls.sales
  })

  log_retention_days     = var.log_retention_days
  log_kms_key_arn        = aws_kms_key.logs.arn
  dead_letter_target_arn = aws_sqs_queue.lambda_async_dlq.arn

  tags = merge(local.common_tags, { Service = "sales-service" })
}

module "lambda_publish_outbox_vehicle" {
  source = "./modules/lambda-function"

  function_name    = "${local.prefix}-publish-outbox-vehicle"
  description      = "Despacha o outbox transacional do vehicle-service"
  handler          = "dist/lambda-jobs.publishOutboxHandler"
  artifacts_bucket = var.lambda_artifacts_bucket
  artifact_key     = local.artifact_keys.vehicle
  role_arn         = aws_iam_role.lambda_execution["vehicle"].arn

  memory_size          = 512
  timeout              = 60
  reserved_concurrency = 1

  subnet_ids         = [for subnet in aws_subnet.application : subnet.id]
  security_group_ids = [aws_security_group.lambda["vehicle"].id]

  environment_variables = merge(local.common_env, {
    SERVICE_NAME = "vehicle-service"
    DATABASE_URL = local.database_urls.vehicle
  })

  log_retention_days     = var.log_retention_days
  log_kms_key_arn        = aws_kms_key.logs.arn
  dead_letter_target_arn = aws_sqs_queue.lambda_async_dlq.arn

  tags = merge(local.common_tags, { Service = "vehicle-service" })
}

module "lambda_publish_outbox_customer" {
  source = "./modules/lambda-function"

  function_name    = "${local.prefix}-publish-outbox-customer"
  description      = "Despacha o outbox transacional do customer-service"
  handler          = "dist/lambda-jobs.publishOutboxHandler"
  artifacts_bucket = var.lambda_artifacts_bucket
  artifact_key     = local.artifact_keys.customer
  role_arn         = aws_iam_role.lambda_execution["customer"].arn

  memory_size          = 512
  timeout              = 60
  reserved_concurrency = 1

  subnet_ids         = [for subnet in aws_subnet.application : subnet.id]
  security_group_ids = [aws_security_group.lambda["customer"].id]

  environment_variables = merge(local.common_env, {
    SERVICE_NAME         = "customer-service"
    DATABASE_URL         = local.database_urls.customer
    CRYPTO_MODE          = "kms"
    KMS_KEY_ID           = aws_kms_key.customer_pii.arn
    CPF_PEPPER_SECRET_ID = aws_secretsmanager_secret.cpf_pepper.name
  })

  log_retention_days     = var.log_retention_days
  log_kms_key_arn        = aws_kms_key.logs.arn
  dead_letter_target_arn = aws_sqs_queue.lambda_async_dlq.arn

  tags = merge(local.common_tags, { Service = "customer-service" })
}

module "lambda_publish_outbox_sales" {
  source = "./modules/lambda-function"

  function_name    = "${local.prefix}-publish-outbox-sales"
  description      = "Despacha o outbox transacional do sales-service"
  handler          = "dist/lambda-saga.publishOutboxTask"
  artifacts_bucket = var.lambda_artifacts_bucket
  artifact_key     = local.artifact_keys.sales
  role_arn         = aws_iam_role.lambda_execution["sales"].arn

  memory_size          = 512
  timeout              = 60
  reserved_concurrency = 1

  subnet_ids         = [for subnet in aws_subnet.application : subnet.id]
  security_group_ids = [aws_security_group.lambda["sales"].id]

  environment_variables = merge(local.common_env, local.sales_env, {
    SERVICE_NAME = "sales-service"
    DATABASE_URL = local.database_urls.sales
  })

  log_retention_days     = var.log_retention_days
  log_kms_key_arn        = aws_kms_key.logs.arn
  dead_letter_target_arn = aws_sqs_queue.lambda_async_dlq.arn

  tags = merge(local.common_tags, { Service = "sales-service" })
}
