variable "function_name" { type = string }
variable "handler" { type = string }
variable "description" { type = string }

variable "artifacts_bucket" { type = string }
variable "artifact_key" { type = string }

variable "role_arn" { type = string }

variable "memory_size" {
  description = <<-EOT
    Memória em MB.

    Na Lambda a CPU é proporcional à memória: aumentar a memória de uma função
    que gasta CPU frequentemente REDUZ o custo, porque o tempo de execução cai
    mais do que o preço por ms sobe.
  EOT
  type        = number
  default     = 512
}

variable "timeout" {
  description = "Timeout em segundos. Deve ser menor que o do chamador."
  type        = number
  default     = 30
}

variable "reserved_concurrency" {
  description = <<-EOT
    Concorrência reservada. -1 desativa.

    Limitar a concorrência protege o banco: sem teto, um pico de tráfego abre
    execuções até esgotar o pool do RDS Proxy e derruba também o que estava
    funcionando.
  EOT
  type        = number
  default     = -1
}

variable "environment_variables" {
  type    = map(string)
  default = {}
}

variable "subnet_ids" {
  type    = list(string)
  default = []
}

variable "security_group_ids" {
  type    = list(string)
  default = []
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "log_kms_key_arn" {
  type    = string
  default = null
}

variable "dead_letter_target_arn" {
  description = "Fila de mensagens mortas para invocações assíncronas."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
