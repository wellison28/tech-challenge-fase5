#!/usr/bin/env bash
# Provisiona no LocalStack os recursos que os serviços esperam encontrar.
# Executado automaticamente quando o container fica pronto.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
awslocal() { aws --endpoint-url=http://localhost:4566 --region "$REGION" "$@"; }

echo "[init] criando o barramento de eventos"
awslocal events create-event-bus --name revenda-bus >/dev/null 2>&1 || true

echo "[init] criando a chave KMS de dados pessoais"
KEY_ID=$(awslocal kms create-key --description "revenda customer PII" \
  --query 'KeyMetadata.KeyId' --output text 2>/dev/null || echo "")
if [ -n "$KEY_ID" ]; then
  awslocal kms create-alias --alias-name alias/revenda-customer-pii \
    --target-key-id "$KEY_ID" >/dev/null 2>&1 || true
fi

echo "[init] criando o segredo do índice cego de CPF"
awslocal secretsmanager create-secret \
  --name revenda/customer-service/cpf-pepper \
  --secret-string "pepper-local-do-localstack-nao-use-em-producao" >/dev/null 2>&1 || true

echo "[init] recursos prontos"
