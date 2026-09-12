# =============================================================================
# Amazon Cognito — identidade e autorização
#
# Por que Cognito e não autenticação própria: senha, hash, reset, MFA, bloqueio
# por tentativa e rotação de chave de assinatura são problemas resolvidos, e
# resolvê-los de novo só acrescenta superfície de ataque. O Cognito também
# entrega o authorizer nativo do API Gateway — o token é validado ANTES de
# qualquer Lambda ser invocada.
# =============================================================================

resource "aws_cognito_user_pool" "main" {
  name = "${local.prefix}-users"

  # O login é por e-mail; `username` separado só acrescentaria um identificador
  # a memorizar e outro a vazar.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
    # 7 dias para a senha temporária do primeiro acesso.
    temporary_password_validity_days = 7
  }

  # MFA opcional para compradores, obrigatório para a equipe da revenda — a
  # obrigatoriedade do grupo `admin` é imposta pelo gatilho de pré-autenticação.
  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Proteção contra credential stuffing e uso de senha vazada, oferecida pelo
  # próprio Cognito.
  user_pool_add_ons {
    advanced_security_mode = "ENFORCED"
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  # Guarda o identificador do cadastro no customer-service. Nenhum dado pessoal
  # além do e-mail fica no Cognito: o CPF e o endereço vivem cifrados no
  # customer-service, e duplicá-los aqui criaria uma segunda cópia a proteger.
  schema {
    name                     = "customer_id"
    attribute_data_type      = "String"
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 36
      max_length = 36
    }
  }

  tags = { Name = "${local.prefix}-users" }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${local.prefix}-auth"
  user_pool_id = aws_cognito_user_pool.main.id
}

# -----------------------------------------------------------------------------
# Grupos — os papéis do negócio
# -----------------------------------------------------------------------------

resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Equipe da revenda: gere estoque, ativa cadastros e registra retiradas"
  precedence   = 1
}

resource "aws_cognito_user_group" "support" {
  name         = "support"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Atendimento: consulta cadastros mascarados, nunca dado pessoal em claro"
  precedence   = 2
}

resource "aws_cognito_user_group" "customer" {
  name         = "customer"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Comprador: compra veiculos e gere o proprio cadastro"
  precedence   = 3
}

# -----------------------------------------------------------------------------
# Resource server — escopos máquina-a-máquina
#
# Um escopo por operação, e não um escopo genérico "interno". É o que permite ao
# sales-service consultar elegibilidade sem poder puxar o perfil de cobrança, e
# ao vehicle-service reservar sem poder dar baixa. Escopo grosso transformaria
# qualquer comprometimento de serviço em acesso total à plataforma.
# -----------------------------------------------------------------------------

resource "aws_cognito_resource_server" "api" {
  identifier   = "revenda"
  name         = "API da revenda de veiculos"
  user_pool_id = aws_cognito_user_pool.main.id

  scope {
    scope_name        = "vehicles.reserve"
    scope_description = "Reservar e liberar reserva de veiculo"
  }

  scope {
    scope_name        = "vehicles.sell"
    scope_description = "Dar baixa no estoque apos a confirmacao do pagamento"
  }

  scope {
    scope_name        = "customers.eligibility"
    scope_description = "Verificar se um comprador pode adquirir um veiculo (sem dado pessoal)"
  }

  scope {
    scope_name        = "customers.billing"
    scope_description = "Obter dados do pagador para emitir o codigo de pagamento"
  }

  scope {
    scope_name        = "customers.documentation"
    scope_description = "Obter dados para emitir a documentacao do veiculo na retirada"
  }
}

# -----------------------------------------------------------------------------
# Clientes
# -----------------------------------------------------------------------------

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.prefix}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  # Sem segredo: é uma aplicação de página única, e qualquer segredo embarcado
  # nela é público por definição.
  generate_secret = false

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  supported_identity_providers = ["COGNITO"]
  callback_urls                = [for origin in var.frontend_origins : "${origin}/auth/callback"]
  logout_urls                  = var.frontend_origins

  # Authorization Code + PKCE, nunca implicit: o fluxo implícito devolve o token
  # na URL, onde ele fica no histórico do navegador e nos logs de proxy.
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]

  access_token_validity  = 1  # hora
  id_token_validity      = 1  # hora
  refresh_token_validity = 30 # dias

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  # Impede que a resposta de login revele se um e-mail existe na base.
  prevent_user_existence_errors = "ENABLED"

  enable_token_revocation = true
}

# Cliente máquina-a-máquina do sales-service: é o orquestrador, e o único que
# precisa falar com os outros dois serviços.
resource "aws_cognito_user_pool_client" "sales_service_m2m" {
  name         = "${local.prefix}-sales-service-m2m"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret                      = true
  allowed_oauth_flows                  = ["client_credentials"]
  allowed_oauth_flows_user_pool_client = true

  allowed_oauth_scopes = [
    "revenda/vehicles.reserve",
    "revenda/vehicles.sell",
    "revenda/customers.eligibility",
    "revenda/customers.billing",
    "revenda/customers.documentation",
  ]

  # Curto de propósito: o serviço renova sozinho, e um token vazado expira
  # rápido.
  access_token_validity = 15

  token_validity_units {
    access_token = "minutes"
  }

  depends_on = [aws_cognito_resource_server.api]
}

# O segredo do cliente M2M é gravado no Secrets Manager em vez de exposto como
# output do Terraform: outputs ficam em texto claro no arquivo de estado.
resource "aws_secretsmanager_secret" "sales_m2m_credentials" {
  name                    = "${local.prefix}/sales-service/m2m-credentials"
  description             = "Credenciais client_credentials do sales-service"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "sales_m2m_credentials" {
  secret_id = aws_secretsmanager_secret.sales_m2m_credentials.id

  secret_string = jsonencode({
    client_id     = aws_cognito_user_pool_client.sales_service_m2m.id
    client_secret = aws_cognito_user_pool_client.sales_service_m2m.client_secret
    token_url     = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com/oauth2/token"
  })
}
