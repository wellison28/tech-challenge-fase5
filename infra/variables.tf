variable "aws_region" {
  description = "Região da AWS. us-east-1 pelo menor custo e maior disponibilidade de serviços."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Ambiente (dev, staging, prod). Compõe o nome de todos os recursos."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment deve ser dev, staging ou prod."
  }
}

variable "project_name" {
  description = "Prefixo dos nomes dos recursos."
  type        = string
  default     = "revenda"
}

variable "vpc_cidr" {
  description = "Bloco CIDR da VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_zones_count" {
  description = <<-EOT
    Número de zonas de disponibilidade.

    Duas é o mínimo do Aurora e já garante que a perda de uma AZ não derrube a
    plataforma. Três aumentaria a resiliência e o custo de NAT/tráfego entre
    zonas sem ganho perceptível para o volume desta revenda.
  EOT
  type        = number
  default     = 2

  validation {
    condition     = var.availability_zones_count >= 2
    error_message = "O Aurora exige subnets em pelo menos 2 zonas de disponibilidade."
  }
}

variable "lambda_artifacts_bucket" {
  description = "Bucket S3 com os pacotes .zip das funções Lambda, publicados pelo CI."
  type        = string
}

variable "lambda_artifact_version" {
  description = "Versão dos artefatos a implantar (normalmente o SHA do commit)."
  type        = string
}

variable "frontend_origins" {
  description = "Origens autorizadas no CORS da API."
  type        = list(string)
  default     = ["https://revenda.exemplo.com.br"]
}

variable "alarm_email" {
  description = "E-mail que recebe os alarmes operacionais."
  type        = string
}

variable "reservation_ttl_minutes" {
  description = "Prazo de validade da reserva de um veículo."
  type        = number
  default     = 30
}

variable "payment_window_minutes" {
  description = <<-EOT
    Prazo para o cliente pagar.

    Precisa ser MENOR que reservation_ttl_minutes: se fosse maior, o veículo
    voltaria à vitrine enquanto o pedido ainda aceitasse pagamento, e dois
    compradores poderiam pagar pelo mesmo carro.
  EOT
  type        = number
  default     = 25
}

variable "log_retention_days" {
  description = <<-EOT
    Retenção dos logs de aplicação.

    90 dias equilibra investigação de incidente com a minimização exigida pela
    LGPD: log retido indefinidamente é dado pessoal guardado sem finalidade.
    A trilha de auditoria de acesso a dado pessoal tem retenção própria e maior.
  EOT
  type        = number
  default     = 90
}
