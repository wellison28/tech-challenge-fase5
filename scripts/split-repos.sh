#!/usr/bin/env bash
#
# Publica cada microsserviço como um repositório Git independente.
#
# Os três serviços já são autossuficientes — cada um tem package.json,
# tsconfig, Dockerfile, migrações, workflow de CI e README próprios. Este
# script apenas materializa essa independência: copia cada pasta para um
# diretório de destino, inicializa o Git e faz o primeiro commit.
#
# Uso:
#   ./scripts/split-repos.sh ~/repos-revenda
#
set -euo pipefail

DESTINO="${1:-}"
if [ -z "$DESTINO" ]; then
  echo "Uso: $0 <diretório-de-destino>" >&2
  exit 1
fi

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICOS=(vehicle-service customer-service sales-service)

mkdir -p "$DESTINO"

for servico in "${SERVICOS[@]}"; do
  alvo="$DESTINO/$servico"
  echo "==> $servico -> $alvo"

  rm -rf "$alvo"
  mkdir -p "$alvo"
  # Exclui artefatos de build: eles são regerados e não pertencem ao repositório.
  rsync -a --exclude node_modules --exclude dist --exclude coverage \
        --exclude '.env' "$RAIZ/$servico/" "$alvo/"

  # O workflow do serviço vive na raiz do monorepo (o GitHub Actions só lê
  # .github/workflows/ da raiz). Ao extrair, ele volta para dentro do repo do
  # serviço, que passa a ter o próprio pipeline.
  mkdir -p "$alvo/.github/workflows"
  cp "$RAIZ/.github/workflows/$servico.yml" "$alvo/.github/workflows/ci.yml"
  # No repo isolado o serviço é a raiz: o working-directory e os prefixos de
  # caminho deixam de fazer sentido.
  sed -i -e "/^defaults:$/,/^$/d" \
         -e "s|^\( *\)cache-dependency-path: $servico/|\1cache-dependency-path: |" \
         -e "s|path: $servico/coverage/|path: coverage/|" \
         -e "s|context: ./$servico|context: .|" \
         -e "/^ *paths:$/,/^ *pull_request:$/{/paths:/d; /- '/d}" \
         "$alvo/.github/workflows/ci.yml"

  git -C "$alvo" init -q
  git -C "$alvo" symbolic-ref HEAD refs/heads/main
  git -C "$alvo" add -A
  git -C "$alvo" commit -q -m "feat: $servico — Tech Challenge Fase 5

Microsserviço autossuficiente: código, testes, migrações, Dockerfile e CI."
  echo "    commit criado ($(git -C "$alvo" rev-list --count HEAD) commit)"
done

# A infraestrutura e os relatórios formam um quarto repositório: são
# transversais aos três serviços e versionados no ritmo da plataforma, não no
# de cada serviço.
alvo="$DESTINO/platform-infra"
echo "==> infraestrutura e documentação -> $alvo"
rm -rf "$alvo"
mkdir -p "$alvo"
rsync -a --exclude '.terraform' --exclude '*.tfstate*' "$RAIZ/infra/" "$alvo/infra/"
rsync -a "$RAIZ/docs/" "$alvo/docs/"
cp "$RAIZ/docker-compose.yml" "$alvo/"
rsync -a "$RAIZ/scripts/" "$alvo/scripts/"
[ -f "$RAIZ/README.md" ] && cp "$RAIZ/README.md" "$alvo/"

cp -r "$RAIZ/.github" "$alvo/.github"

git -C "$alvo" init -q
git -C "$alvo" symbolic-ref HEAD refs/heads/main
git -C "$alvo" add -A
git -C "$alvo" commit -q -m "feat: infraestrutura e documentação da plataforma"

echo
echo "Pronto. Para publicar cada um:"
for servico in "${SERVICOS[@]}" platform-infra; do
  echo "  cd $DESTINO/$servico && gh repo create <org>/$servico --private --source=. --push"
done
