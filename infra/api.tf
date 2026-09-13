# =============================================================================
# Amazon API Gateway (REST API)
#
# REST API e não HTTP API: o AWS WAF só se associa a stage de REST API — o HTTP
# API não aceita web ACL. Sem WAF, o limite de taxa por IP, o limite apertado no
# cadastro e as regras gerenciadas (OWASP, entradas maliciosas, reputação de IP)
# ficariam sem lugar na borda.
#
# O REST API também traz o authorizer nativo do Cognito, que valida o token
# **antes** de qualquer Lambda ser invocada: uma requisição sem token válido não
# gera invocação, não toca no banco e não é faturada como execução. O custo por
# milhão de requisições é maior que o do HTTP API — diferença irrelevante no
# volume de uma revenda.
#
# A API é declarada em OpenAPI (`body`), montado abaixo a partir das listas de
# rotas. A validação de payload continua no serviço, por schema Zod.
# =============================================================================

locals {
  api_stage_name = "v1"

  # Nome das Lambdas de API. É a fonte única: `lambdas.tf` usa estes nomes, e a
  # URI de integração é montada a partir deles — referenciar o módulo aqui criaria
  # dependência circular (a API apontaria para a Lambda do sales-service, que
  # recebe a URL da API como variável de ambiente).
  api_functions = {
    vehicle  = "${local.prefix}-vehicle-api"
    customer = "${local.prefix}-customer-api"
    sales    = "${local.prefix}-sales-api"
  }

  # URL base usada pelo sales-service para chamar os outros dois serviços.
  api_base_url = "https://${aws_api_gateway_rest_api.main.id}.execute-api.${var.aws_region}.amazonaws.com/${local.api_stage_name}"

  api_integration = {
    for service, function_name in local.api_functions : service => {
      type                = "aws_proxy"
      httpMethod          = "POST"
      uri                 = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${function_name}/invocations"
      passthroughBehavior = "when_no_match"
      # Maior que o timeout da Lambda (25s), para que o gateway não desista antes
      # de a função conseguir responder ou registrar o erro.
      timeoutInMillis = 29000
    }
  }
}

# -----------------------------------------------------------------------------
# Rotas
#
# A autorização é declarada rota a rota. As rotas públicas (vitrine, webhook)
# ficam sem authorizer de propósito — e é uma lista curta e explícita, e não um
# padrão genérico, justamente para que adicionar uma rota pública exija uma
# decisão consciente.
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
    # Webhook: quem chama é o provedor de pagamento, que não tem credencial no
    # Cognito. A autenticidade vem da assinatura HMAC do corpo.
    "POST /webhooks/payments" = "sales"
  }

  # Todo o restante exige token válido — inclusive o cadastro de compradores,
  # que é feito com a conta do Cognito já criada.
  authenticated_routes = {
    "POST /vehicles"                                     = "vehicle"
    "PUT /vehicles/{id}"                                 = "vehicle"
    "POST /vehicles/{id}/reservations"                   = "vehicle"
    "POST /vehicles/{id}/reservations/release"           = "vehicle"
    "POST /vehicles/{id}/sale"                           = "vehicle"
    "POST /customers"                                    = "customer"
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

  api_routes = merge(local.public_routes, local.authenticated_routes)

  # O authorizer do Cognito no REST API só aceita *access token* quando o método
  # declara escopos, e o token precisa trazer ao menos um deles. A lista reúne os
  # escopos dos dois clientes (usuário e máquina); a checagem fina — qual grupo
  # ou escopo alcança qual operação — continua no serviço.
  api_authorizer_scopes = distinct(concat(
    tolist(aws_cognito_user_pool_client.web.allowed_oauth_scopes),
    tolist(aws_cognito_user_pool_client.sales_service_m2m.allowed_oauth_scopes),
  ))

  api_operations = merge(
    {
      for route, service in local.public_routes : route => {
        "x-amazon-apigateway-integration" = local.api_integration[service]
      }
    },
    {
      for route, service in local.authenticated_routes : route => {
        "x-amazon-apigateway-integration" = local.api_integration[service]
        security                          = [{ cognito = local.api_authorizer_scopes }]
      }
    },
  )

  api_paths = distinct([for route in keys(local.api_routes) : split(" ", route)[1]])

  api_openapi = {
    openapi = "3.0.1"
    info = {
      title   = "${local.prefix}-api"
      version = "1.0"
    }

    components = {
      securitySchemes = {
        cognito = {
          type                           = "apiKey"
          name                           = "Authorization"
          in                             = "header"
          "x-amazon-apigateway-authtype" = "cognito_user_pools"
          "x-amazon-apigateway-authorizer" = {
            type         = "cognito_user_pools"
            providerARNs = [aws_cognito_user_pool.main.arn]
          }
        }
      }
    }

    paths = {
      for path in local.api_paths : path => merge(
        {
          for route, operation in local.api_operations :
          lower(split(" ", route)[0]) => operation if split(" ", route)[1] == path
        },
        {
          # Pré-voo de CORS: vai ao próprio serviço, onde a política de origens já
          # está configurada — uma só fonte da verdade para CORS.
          options = {
            "x-amazon-apigateway-integration" = local.api_integration[one(distinct([
              for route, service in local.api_routes : service if split(" ", route)[1] == path
            ]))]
          }
          parameters = [
            for name in flatten(regexall("\\{([^}]+)\\}", path)) :
            { name = name, in = "path", required = true, schema = { type = "string" } }
          ]
        },
      )
    }

    # Respostas geradas pelo próprio gateway (401 do authorizer, 429 do
    # throttling) não passam pelo serviço e sairiam sem cabeçalho de CORS: o
    # frontend veria só "erro de rede" e não saberia que precisa renovar o login.
    "x-amazon-apigateway-gateway-responses" = {
      for type in ["DEFAULT_4XX", "DEFAULT_5XX"] : type => {
        responseParameters = {
          "gatewayresponse.header.Access-Control-Allow-Origin" = "'${var.frontend_origins[0]}'"
        }
      }
    }
  }
}

resource "aws_api_gateway_rest_api" "main" {
  name        = "${local.prefix}-api"
  description = "API da plataforma de revenda de veiculos"
  body        = jsonencode(local.api_openapi)

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = local.common_tags
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
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# -----------------------------------------------------------------------------
# Deployment e stage
# -----------------------------------------------------------------------------

resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id

  # Toda mudança na definição gera um deployment novo; sem o gatilho, o stage
  # continuaria servindo a versão anterior da API.
  triggers = {
    definicao = sha1(aws_api_gateway_rest_api.main.body)
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    module.lambda_vehicle_api,
    module.lambda_customer_api,
    module.lambda_sales_api,
  ]
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.prefix}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn

  tags = local.common_tags
}

# O REST API grava log no CloudWatch por um papel configurado na conta (um por
# região), e não por permissão do stage.
resource "aws_iam_role" "api_gateway_cloudwatch" {
  name = "${local.prefix}-apigateway-cloudwatch"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "apigateway.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "api_gateway_cloudwatch" {
  role       = aws_iam_role.api_gateway_cloudwatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "main" {
  cloudwatch_role_arn = aws_iam_role.api_gateway_cloudwatch.arn

  depends_on = [aws_iam_role_policy_attachment.api_gateway_cloudwatch]
}

resource "aws_api_gateway_stage" "main" {
  rest_api_id          = aws_api_gateway_rest_api.main.id
  deployment_id        = aws_api_gateway_deployment.main.id
  stage_name           = local.api_stage_name
  xray_tracing_enabled = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn

    # A query string NÃO é registrada: é comum um CPF acabar num parâmetro de
    # busca, e o log de acesso é copiado para muito mais lugares que o banco.
    # `resourcePath` é o molde da rota (`/customers/{id}`), sem valores.
    format = jsonencode({
      requestId        = "$context.requestId"
      correlationId    = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      resourcePath     = "$context.resourcePath"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
      authorizerError  = "$context.authorize.error"
      wafResponse      = "$context.wafResponseCode"
      userSub          = "$context.authorizer.claims.sub"
    })
  }

  depends_on = [aws_api_gateway_account.main]

  tags = local.common_tags
}

resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  stage_name  = aws_api_gateway_stage.main.stage_name
  method_path = "*/*"

  settings {
    metrics_enabled = true
    # Log de execução desligado: ele registra corpo de requisição e de resposta,
    # onde há dado pessoal. O log de acesso do stage basta.
    logging_level      = "OFF"
    data_trace_enabled = false
    # Teto de vazão do stage: segunda camada depois do WAF, e protege contra um
    # cliente autenticado que abuse da API.
    throttling_burst_limit = 500
    throttling_rate_limit  = 1000
  }
}

# -----------------------------------------------------------------------------
# WAF na frente do stage
# -----------------------------------------------------------------------------

resource "aws_wafv2_web_acl_association" "api" {
  resource_arn = aws_api_gateway_stage.main.arn
  web_acl_arn  = aws_wafv2_web_acl.api.arn
}
