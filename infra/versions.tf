terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Estado remoto com bloqueio.
  #
  # Estado local em projeto de equipe produz `terraform apply` concorrentes e
  # destruição acidental de recursos. O S3 guarda o estado cifrado com KMS
  # (contém identificadores e, em alguns recursos, valores sensíveis) e o
  # DynamoDB dá o lock distribuído.
  backend "s3" {
    bucket         = "revenda-veiculos-tfstate"
    key            = "plataforma/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "revenda-veiculos-tfstate-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}
