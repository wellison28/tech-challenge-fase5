variable "name" {
  description = "Nome do cluster."
  type        = string
}

variable "database_name" {
  description = "Banco de dados inicial."
  type        = string
}

variable "app_username" {
  description = "Usuário de banco da aplicação. As Lambdas se conectam com ele, por token IAM."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Subnets isoladas de dados."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups autorizados a abrir conexão (as Lambdas do serviço dono)."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "Chave KMS da criptografia em repouso."
  type        = string
}

variable "min_capacity" {
  description = "Capacidade mínima em ACUs. 0.5 é o piso do Serverless v2."
  type        = number
  default     = 0.5
}

variable "max_capacity" {
  description = "Capacidade máxima em ACUs — teto de custo e de escala."
  type        = number
  default     = 4
}

variable "backup_retention_days" {
  type    = number
  default = 14
}

variable "environment" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
