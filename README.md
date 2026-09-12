# Plataforma de revenda de veículos

Tech Challenge — Fase 5 · Pós-graduação em Arquitetura de Software

API para uma revenda de veículos automotores: catálogo, cadastro de compradores
e processo de compra completo — da seleção do veículo à retirada — com
tratamento de dados pessoais sob a LGPD e SAGA orquestrada entre os serviços.

---

## Entregáveis

| Item | Onde |
|---|---|
| **Desenho da arquitetura** + justificativa dos serviços e dos serviços de segurança | [`docs/01-arquitetura.md`](docs/01-arquitetura.md) |
| **Relatório de segurança de dados** | [`docs/02-relatorio-seguranca.md`](docs/02-relatorio-seguranca.md) |
| **Relatório de orquestração SAGA** | [`docs/03-relatorio-saga.md`](docs/03-relatorio-saga.md) |
| Os três em um documento único, pronto para imprimir em PDF | [`docs/relatorios.html`](docs/relatorios.html) — gerado por [`scripts/build-docs/`](scripts/build-docs/) |
| Código dos três microsserviços | [`vehicle-service/`](vehicle-service/) · [`customer-service/`](customer-service/) · [`sales-service/`](sales-service/) |
| Infraestrutura como código (Terraform) | [`infra/`](infra/) |

---

## Os três serviços

| Serviço | Responsabilidade | Porta | Dado pessoal |
|---|---|---|---|
| [**vehicle-service**](vehicle-service/) | Catálogo e estoque: cadastro, edição, vitrine ordenada por preço, reserva, liberação e baixa | 3001 | Nenhum |
| [**customer-service**](customer-service/) | Cadastro de compradores, consentimento, direitos do titular. Fonte dos dados do código de pagamento e da documentação do veículo | 3002 | **Todo** |
| [**sales-service**](sales-service/) | Processo de compra ponta a ponta. Orquestra a SAGA e executa as compensações | 3003 | Nenhum armazenado |

Cada um é **autossuficiente**: `package.json`, `tsconfig`, migrações,
`Dockerfile`, workflow de CI e README próprios. Nenhum importa código de outro —
a comunicação é só por API e por eventos.

A entrega está em **um repositório**, mas os serviços permanecem
independentemente implantáveis: cada um tem seu próprio pipeline, com filtro de
caminho, e seu próprio artefato de deploy.

| Workflow | Roda quando | O que faz |
|---|---|---|
| `.github/workflows/vehicle-service.yml` | muda `vehicle-service/**` | lint, tipos, testes, `npm audit`, build da imagem |
| `.github/workflows/customer-service.yml` | muda `customer-service/**` | idem |
| `.github/workflows/sales-service.yml` | muda `sales-service/**` | idem |
| `.github/workflows/repositorio.yml` | qualquer push | varredura de segredos, Terraform `fmt`/`validate`, validação da definição da SAGA, e checagem de que `docs/relatorios.html` está em dia |

Caso seja preciso separar os serviços depois,
[`scripts/split-repos.sh`](scripts/split-repos.sh) extrai cada pasta como
repositório Git independente — mais um quarto, com infraestrutura e
documentação — já ajustando o workflow de cada um para a nova raiz:

```bash
./scripts/split-repos.sh ~/repos-revenda
```

---

## Requisitos do enunciado e onde cada um está

| Requisito | Implementação |
|---|---|
| Cadastrar veículo (marca, modelo, ano, cor, preço) | `POST /vehicles` — o modelo acrescenta chassi, placa, km, combustível e câmbio |
| Editar dados do veículo | `PUT /vehicles/:id` |
| Efetuar a venda **somente para compradores cadastrados** | Passo 2 da SAGA: `GET /internal/customers/:id/eligibility` verifica cadastro ativo, base legal vigente e capacidade civil |
| Listagem de veículos à venda, do mais barato para o mais caro | `GET /vehicles/available` — ordenação fixa, não negociável por query |
| Listagem de vendidos, do mais barato para o mais caro | `GET /vehicles/sold` |
| Cadastro de compradores | `POST /customers` |
| Processo de compra do começo ao fim | SAGA de 6 passos, orquestrada por Step Functions |
| Outro cliente reserva antes | Trava otimista + invariante do agregado → 409 → pedido cancelado sem emitir cobrança |
| Pagamento não efetuado | `TimeoutSeconds` do orquestrador → compensação |
| Cliente desiste em qualquer passo | `POST /orders/:id/cancellation` → compensação |
| Dados para emitir o código de pagamento | `GET /internal/customers/:id/billing-profile` — escopo próprio, finalidade declarada, auditado |
| Dados para emitir a documentação na retirada | `GET /internal/customers/:id/documentation-dossier` |
| Regras de segurança para dados sensíveis | Ver [`docs/02-relatorio-seguranca.md`](docs/02-relatorio-seguranca.md) |

---

## Rodando localmente

Sobe os três serviços, três bancos e o LocalStack (EventBridge, KMS, Secrets
Manager, Step Functions):

```bash
docker compose up -d
```

> O arquivo usa o **Compose Spec** (`docker compose`, v2). O `docker-compose`
> standalone v1 está fora de suporte desde 2023 e não aceita a chave `name:`
> nem `depends_on.condition`. Se o seu Docker ainda não traz o plugin:
> `sudo apt install docker-compose-plugin` (ou o pacote equivalente).

Depois, para cada serviço, aplique as migrações e a massa de dados:

```bash
cd vehicle-service  && npm ci && npm run prisma:deploy && npm run seed
cd ../customer-service && npm ci && npm run prisma:deploy && npm run seed
cd ../sales-service    && npm ci && npm run prisma:deploy
```

| Serviço | Documentação interativa |
|---|---|
| vehicle-service | http://localhost:3001/docs |
| customer-service | http://localhost:3002/docs |
| sales-service | http://localhost:3003/docs |

Em ambiente local, `AUTH_MODE=dev`, `CRYPTO_MODE=local`, `SAGA_MODE=inline` e
`PAYMENT_PROVIDER=fake` permitem exercitar o fluxo inteiro sem conta AWS. Os
quatro são **recusados na inicialização** quando `NODE_ENV=production`.

---

## Testes

```bash
# em cada serviço
npm test          # unidade + integração, com cobertura
npm run typecheck
npm run lint
```

| Serviço | Testes | Cobertura (domínio + aplicação) |
|---|---|---|
| vehicle-service | 78 | 92% |
| customer-service | 91 | 90% |
| sales-service | 75 | 86% |
| **Total** | **244** | — |

Os testes cobrem, entre outros: disputa de estoque entre dois compradores,
idempotência de cada passo da SAGA, compensação que falha no meio, pagamento
confirmado fora do prazo, webhook perdido e recuperado por reconciliação,
assinatura de webhook forjada, acesso de um titular ao cadastro de outro,
adulteração de texto cifrado e irreversibilidade do índice cego.

---

## Infraestrutura

```bash
cd infra
terraform fmt -recursive -check
terraform init -backend=false && terraform validate
```

Provisiona VPC de três camadas, três clusters Aurora Serverless v2 com RDS
Proxy, 14 funções Lambda, API Gateway com authorizer JWT, Cognito com escopos
granulares, Step Functions, EventBridge e os serviços de segurança (KMS, Secrets
Manager, WAF, GuardDuty, Security Hub, CloudTrail).

---

## Decisões de arquitetura, em uma linha cada

| Decisão | Por quê |
|---|---|
| Três microsserviços, um banco cada | Autonomia real; um comprometimento não alcança os dados dos outros |
| **Todo** dado pessoal em um único serviço | Reduz a superfície a proteger de três sistemas para um |
| Arquitetura hexagonal nos três | O domínio não conhece framework; a regra de negócio é testável em milissegundos |
| SAGA **orquestrada** (Step Functions) | Compensação explícita, timeout de negócio e espera por callback |
| Coreografia (EventBridge) para o resto | Onde o fato já é definitivo, não há o que desfazer |
| Transactional Outbox | Estado e evento no mesmo commit |
| Trava otimista, não pessimista | Em serverless, lock aberto esperando I/O consome conexão do pool |
| Envelope encryption + índice cego | Dump do banco ilegível; busca por CPF sem armazenar CPF |
| Mascaramento por padrão | Expor dado em claro exige decisão explícita no código |
| Finalidade obrigatória (`X-Data-Purpose`) | O princípio da finalidade não é verificável depois do fato |
| Auditoria append-only, na mesma transação | Acesso sem rastro deixa de ser possível, mesmo com a aplicação comprometida |
| Preço em centavos inteiros | Ponto flutuante acumula erro em soma de valores |
| Aurora, não DynamoDB | O requisito central é ordenar e filtrar por faixa de preço |
| Lambda, não Fargate | Tráfego irregular; o `Dockerfile` preserva a saída para ECS |
