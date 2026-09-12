locals {
  prefix = "${var.project_name}-${var.environment}"

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    # Marca os recursos que tocam dado pessoal: permite localizar o escopo de
    # um incidente de privacidade por tag, em vez de por memória.
    DataClass = "internal"
  }

  # Os três serviços da plataforma. Um por banco, um por conjunto de Lambdas.
  services = {
    vehicle = {
      name          = "vehicle-service"
      database_name = "vehicles"
      port          = 3001
      # O catálogo tem o maior volume de leitura e nenhum dado pessoal.
      min_capacity = 0.5
      max_capacity = 4
      handles_pii  = false
    }
    customer = {
      name          = "customer-service"
      database_name = "customers"
      port          = 3002
      # Cada leitura pode envolver decifragem; capacidade menor e previsível.
      min_capacity = 0.5
      max_capacity = 2
      handles_pii  = true
    }
    sales = {
      name          = "sales-service"
      database_name = "sales"
      port          = 3003
      min_capacity  = 0.5
      max_capacity  = 4
      handles_pii   = false
    }
  }

  payment_window_seconds = var.payment_window_minutes * 60

  # O ARN da maquina de estados e montado, e nao lido do recurso.
  #
  # As Lambdas dos passos da SAGA precisam do ARN na configuracao, e a maquina
  # de estados precisa do ARN das Lambdas na definicao: referenciar o recurso
  # nos dois sentidos cria um ciclo no grafo do Terraform. Como o ARN e
  # deterministico a partir do nome, monta-lo quebra o ciclo sem enfraquecer
  # nada — o `name` do recurso usa exatamente este mesmo valor.
  purchase_saga_arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.prefix}-purchase-saga"
}
