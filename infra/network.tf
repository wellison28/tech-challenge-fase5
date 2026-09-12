# =============================================================================
# Rede
#
# Topologia de três camadas:
#   - subnets públicas: apenas NAT Gateway. Nenhuma carga de trabalho.
#   - subnets privadas de aplicação: Lambdas. Saída para a internet só via NAT.
#   - subnets isoladas de dados: Aurora e RDS Proxy. SEM rota para a internet —
#     nem de saída. Um banco que não consegue iniciar conexão para fora é um
#     banco de onde não se exfiltra dado por conexão reversa.
# =============================================================================

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.availability_zones_count)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.prefix}-vpc" }
}

resource "aws_subnet" "public" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, each.value)

  tags = { Name = "${local.prefix}-public-${each.key}", Tier = "public" }
}

resource "aws_subnet" "application" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, each.value + 10)

  tags = { Name = "${local.prefix}-app-${each.key}", Tier = "application" }
}

resource "aws_subnet" "data" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, each.value + 20)

  tags = { Name = "${local.prefix}-data-${each.key}", Tier = "data" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.prefix}-igw" }
}

# Um NAT por zona: um NAT único economizaria custo, mas a perda da zona dele
# derrubaria a saída de internet de todas as Lambdas.
resource "aws_eip" "nat" {
  for_each = aws_subnet.public

  domain = "vpc"
  tags   = { Name = "${local.prefix}-nat-${each.key}" }
}

resource "aws_nat_gateway" "main" {
  for_each = aws_subnet.public

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = each.value.id

  tags       = { Name = "${local.prefix}-nat-${each.key}" }
  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.prefix}-rt-public" }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "application" {
  for_each = aws_subnet.application

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[each.key].id
  }

  tags = { Name = "${local.prefix}-rt-app-${each.key}" }
}

resource "aws_route_table_association" "application" {
  for_each = aws_subnet.application

  subnet_id      = each.value.id
  route_table_id = aws_route_table.application[each.key].id
}

# Tabela sem rota default: as subnets de dados não alcançam a internet.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.prefix}-rt-data" }
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}

# -----------------------------------------------------------------------------
# VPC Endpoints
#
# As Lambdas precisam falar com KMS, Secrets Manager, EventBridge e Step
# Functions. Sem endpoints, esse tráfego sairia pelo NAT e atravessaria a
# internet pública — pagando transferência de dados e, mais importante, expondo
# à rede aberta as chamadas que decifram dado pessoal.
#
# Com endpoints de interface, o tráfego nunca deixa a rede da AWS e as políticas
# do endpoint permitem restringir quem o usa.
# -----------------------------------------------------------------------------

resource "aws_security_group" "vpc_endpoints" {
  name        = "${local.prefix}-vpce"
  description = "Permite HTTPS das subnets de aplicacao para os VPC endpoints"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS das subnets de aplicacao"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [for subnet in aws_subnet.application : subnet.cidr_block]
  }

  tags = { Name = "${local.prefix}-vpce" }
}

locals {
  interface_endpoints = [
    "kms",
    "secretsmanager",
    "events",
    "states",
    "logs",
    "xray",
    "sqs",
  ]
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(local.interface_endpoints)

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for subnet in aws_subnet.application : subnet.id]
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = { Name = "${local.prefix}-vpce-${each.key}" }
}

# Gateway endpoint para S3: não custa por hora e evita que o download de
# artefatos e o upload de logs passem pelo NAT.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids = concat(
    [for rt in aws_route_table.application : rt.id],
    [aws_route_table.data.id],
  )

  tags = { Name = "${local.prefix}-vpce-s3" }
}

# -----------------------------------------------------------------------------
# VPC Flow Logs
#
# Sem eles, uma investigação de incidente não consegue responder "que tráfego
# saiu desta Lambda". É o registro de rede que sustenta a análise forense.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/aws/vpc/${local.prefix}/flow-logs"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_iam_role" "flow_logs" {
  name = "${local.prefix}-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  role = aws_iam_role.flow_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ]
      Resource = "${aws_cloudwatch_log_group.flow_logs.arn}:*"
    }]
  })
}

resource "aws_flow_log" "main" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn         = aws_iam_role.flow_logs.arn

  tags = { Name = "${local.prefix}-flow-logs" }
}
