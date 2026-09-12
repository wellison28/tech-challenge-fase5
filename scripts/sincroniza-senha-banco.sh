#!/usr/bin/env bash
# Grava no banco a senha do usuário de aplicação, a partir do Secrets Manager.
#
# As Lambdas se autenticam no RDS Proxy por token IAM; o Proxy abre a conexão
# real no Aurora com o segredo `<cluster>/database/app`. A migração cria o papel
# sem senha — nenhum segredo no repositório —, e esta etapa, executada no deploy
# logo depois de `prisma migrate deploy`, alinha o banco ao segredo.
#
# Roda com a credencial master, de dentro da VPC (job de migração).
#
# Uso:  scripts/sincroniza-senha-banco.sh <prefixo> <servico>
#       scripts/sincroniza-senha-banco.sh revenda-prod vehicle
# Requer: aws cli, python3 e psql 15+ (por causa do \getenv).
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "uso: $0 <prefixo> <vehicle|customer|sales>" >&2
  exit 64
fi

cluster="$1-$2"

segredo() {
  aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text
}

campo() {
  python3 -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

master=$(segredo "$cluster/database/master")
app=$(segredo "$cluster/database/app")

# Conexão direta ao cluster (não ao Proxy), como master.
PGHOST=$(campo host <<<"$master")
PGPORT=$(campo port <<<"$master")
PGDATABASE=$(campo dbname <<<"$master")
PGUSER=$(campo username <<<"$master")
PGPASSWORD=$(campo password <<<"$master")
PGSSLMODE=require
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE

# A senha vai por variável de ambiente e é lida pelo próprio psql: não aparece
# na linha de comando (visível em `ps`) nem no histórico do shell.
PAPEL_APP=$(campo username <<<"$app")
SENHA_APP=$(campo password <<<"$app")
export PAPEL_APP SENHA_APP

psql -v ON_ERROR_STOP=1 --quiet <<'SQL'
\getenv papel PAPEL_APP
\getenv senha SENHA_APP
ALTER ROLE :"papel" PASSWORD :'senha';
SQL

echo "senha de ${PAPEL_APP} sincronizada em ${cluster}"
