# =============================================================================
# Amazon API Gateway (HTTP API)
#
# HTTP API e não REST API: custa cerca de um terço, tem latência menor e traz o
# authorizer JWT nativo — que valida o token do Cognito **antes** de qualquer
# Lambda ser invocada. Uma requisição sem token válido não gera invocação, não
# toca no banco e não é faturada como execução.
#
# Os recursos do REST API que não temos aqui (modelos de requisição, planos de
# uso, chaves de API) não são necessários: a validação de payload é feita por
# schema Zod dentro do serviço, e o controle de taxa fica no WAF e no throttling
# do próprio stage.
# =============================================================================

resource "aws_apigatewayv2_api" "main" {
  name          = "${local.prefix}-api"
  description   = "API da plataforma de revenda de veiculos"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.frontend_origins
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = [
      "content-type",
      "authorization",
      "x-correlation-id",
      "x-data-purpose",
    ]
    expose_headers = ["x-correlation-id"]
    max_age        = 600
    # Sem credenciais: a API usa Bearer token no cabeçalho, não cookie. Isso
    # elimina CSRF por construção.
    allow_credentials = false
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Authorizer JWT do Cognito
# -----------------------------------------------------------------------------

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${local.prefix}-cognito"

  jwt_configuration {
    # Aceita tanto o token de usuário (audience = cliente web) quanto o de
    # máquina (audience = cliente M2M do sales-service).
    audience = [
      aws_cognito_user_pool_client.web.id,
      aws_cognito_user_pool_client.sales_service_m2m.id,
    ]
    issuer = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  }
}

# -----------------------------------------------------------------------------
# Integrações
# -----------------------------------------------------------------------------

locals {
  api_integrations = {
    vehicle  = module.lambda_vehicle_api.invoke_arn
    customer = module.lambda_customer_api.invoke_arn
    sales    = module.lambda_sales_api.invoke_arn
  }
}

resource "aws_apigatewayv2_integration" "service" {
  for_each = local.api_integrations

  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = each.value
  integration_method     = "POST"
  payload_format_version = "1.0"
  # Maior que o timeout da Lambda (25s), para que o gateway não desista antes
  # de a função conseguir responder ou registrar o erro.
  timeout_milliseconds = 29000
}

resource "aws_lambda_permission" "api_gateway" {
  for_each = {
    vehicle  = module.lambda_vehicle_api.function_name
    customer = module.lambda_customer_api.function_name
    sales    = module.lambda_sales_api.function_name
  }

  statement_id  = "PermiteInvocacaoPeloApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = each.value
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# -----------------------------------------------------------------------------
# Rotas
#
# A autorização é declarada rota a rota. As rotas públicas (vitrine,
# autocadastro, webhook, health) ficam sem authorizer de propósito — e é uma
# lista curta e explícita, e não um padrão genérico, justamente para que
# adicionar uma rota pública exija uma decisão consciente.
# -----------------------------------------------------------------------------

locals {
  # Rotas sem autenticação, com a razão de cada uma.
  public_routes = {
    # Vitrine: o catálogo é público; exigir login para ver preço afastaria o
    # comprador antes de ele se cadastrar.
    "GET /vehicles"           = "vehicle"
    "GET /vehicles/available" = "vehicle"
    "GET /vehicles/sold"      = "vehicle"
    "GET /vehicles/{id}"      = "vehicle"
    # Autocadastro: quem ainda não tem conta não pode ter token. Protegido por
    # limite de taxa apertado no WAF e na aplicação.
    "POST /customers" = "customer"
    # Webhook: quem chama é o provedor de pagamento, que não tem credencial no
    # Cognito. A autenticidade vem da assinatura HMAC do corpo.
    "POST /webhooks/payments" = "sales"
  }

  # Todo o restante exige token válido.
  authenticated_routes = {
    "POST /vehicles"                                     = "vehicle"
    "PUT /vehicles/{id}"                                 = "vehicle"
    "POST /vehicles/{id}/reservations"                   = "vehicle"
    "POST /vehicles/{id}/reservations/release"           = "vehicle"
    "POST /vehicles/{id}/sale"                           = "vehicle"
    "GET /customers/{id}"                                = "customer"
    "PUT /customers/{id}"                                = "customer"
    "DELETE /customers/{id}"                             = "customer"
    "POST /customers/{id}/activation"                    = "customer"
    "POST /customers/{id}/block"                         = "customer"
    "POST /customers/{id}/consents"                      = "customer"
    "DELETE /customers/{id}/consents/{purpose}"          = "customer"
    "GET /customers/{id}/personal-data-export"           = "customer"
    "GET /internal/customers/{id}/eligibility"           = "customer"
    "GET /internal/customers/{id}/billing-profile"       = "customer"
    "GET /internal/customers/{id}/documentation-dossier" = "customer"
    "POST /orders"                                       = "sales"
    "GET /orders"                                        = "sales"
    "GET /orders/{id}"                                   = "sales"
    "POST /orders/{id}/cancellation"                     = "sales"
    "POST /orders/{id}/pickup"                           = "sales"
  }
}

resource "aws_apigatewayv2_route" "public" {
  for_each = local.public_routes

  api_id             = aws_apigatewayv2_api.main.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.service[each.value].id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "authenticated" {
  for_each = local.authenticated_routes

  api_id             = aws_apigatewayv2_api.main.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.service[each.value].id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# -----------------------------------------------------------------------------
# Stage
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.prefix}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn

  tags = local.common_tags
}

resource "aws_apigatewayv2_stage" "main" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn

    # A query string NÃO é registrada: é comum um CPF acabar num parâmetro de
    # busca, e o log de acesso é copiado para muito mais lugares que o banco.
    format = jsonencode({
      requestId        = "$context.requestId"
      correlationId    = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
      authorizerError  = "$context.authorizer.error"
      userSub          = "$context.authorizer.claims.sub"
    })
  }

  default_route_settings {
    detailed_metrics_enabled = true
    # Teto de vazão do stage: segunda camada depois do WAF, e protege contra um
    # cliente autenticado que abuse da API.
    throttling_burst_limit = 500
    throttling_rate_limit  = 1000
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# WAF na frente do stage
# -----------------------------------------------------------------------------

resource "aws_wafv2_web_acl_association" "api" {
  resource_arn = aws_apigatewayv2_stage.main.arn
  web_acl_arn  = aws_wafv2_web_acl.api.arn
}
