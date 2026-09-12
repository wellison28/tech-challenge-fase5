# vehicle-service

Microsserviço de **catálogo e estoque de veículos** da plataforma de revenda.
É o dono (*single writer*) do estado de cada unidade em estoque: ninguém mais
escreve na tabela `vehicles`.

## Responsabilidades

| Capacidade | Quem consome |
|---|---|
| Cadastrar e editar veículo | Equipe da revenda (grupo `admin` no Cognito) |
| Vitrine pública: veículos à venda e vendidos, ordenados por preço crescente | Frontend, sem autenticação |
| Reservar / liberar reserva / dar baixa na venda | `sales-service`, via Step Functions (token máquina-a-máquina) |
| Expirar reservas vencidas | EventBridge Scheduler (Lambda agendada) |

**Não** é responsabilidade deste serviço: dados do comprador, pagamento ou
orquestração do processo de compra.

## Arquitetura interna

Hexagonal (ports & adapters), com dependências apontando sempre para dentro:

```
src/
├── domain/              # Regra de negócio pura. Zero import de framework.
│   ├── entities/        #   Vehicle: agregado e máquina de estados
│   ├── value-objects/   #   Money (centavos), Vin, LicensePlate
│   ├── events/          #   Contrato dos eventos de domínio
│   ├── errors/          #   Erros de negócio (traduzidos para HTTP na borda)
│   └── repositories/    #   Portas de persistência (interfaces)
├── application/         # Casos de uso — orquestram o domínio
│   ├── usecases/
│   ├── ports/           #   Clock, IdGenerator, UnitOfWork, EventPublisher
│   └── dto/
└── infrastructure/      # Adaptadores concretos
    ├── http/            #   Fastify: rotas, validação Zod, auth, erros
    ├── persistence/     #   Prisma + PostgreSQL, Transactional Outbox
    ├── messaging/       #   Amazon EventBridge
    ├── observability/   #   pino com redação de campos sensíveis
    └── container.ts     #   Composition root (único ponto de wiring)
```

O `domain` não conhece Prisma, Fastify nem AWS. É por isso que os 61 testes de
unidade rodam em menos de um segundo, sem banco e sem nuvem.

## Máquina de estados do veículo

```
AVAILABLE ──reserve()──▶ RESERVED ──confirmSale()──▶ SOLD (terminal)
    ▲                        │
    └──releaseReservation()──┘
```

`RESERVED` existe porque o processo de compra não é atômico. Ele é o estado que
permite compensar a SAGA quando o pagamento falha, expira ou o cliente desiste.

## Concorrência: dois clientes, um carro

O cenário do enunciado — "outro cliente reserva o veículo antes" — é tratado em
duas camadas:

1. **Invariante do agregado** (`Vehicle.reserve`): recusa reserva sobre reserva
   ativa de outro pedido.
2. **Trava otimista no banco**: o `UPDATE` carrega a versão lida
   (`WHERE id = ? AND version = ?`). Se duas transações leram o veículo como
   disponível ao mesmo tempo, a segunda afeta 0 linhas e recebe `409 CONFLICT`.

Optou-se por trava otimista em vez de `SELECT ... FOR UPDATE` porque, em
ambiente serverless, lock pessimista mantém transação aberta enquanto a Lambda
espera — o que consome conexão do pool e amplia o efeito de qualquer lentidão.

Complementando, `RESERVATION_TTL_MINUTES` garante *liveness*: mesmo que a SAGA
morra no meio, a Lambda de expiração devolve o veículo à vitrine.

## Confiabilidade dos eventos: Transactional Outbox

Mudança de estado e publicação de evento são escritas em sistemas diferentes.
Gravar o evento na tabela `outbox_events` **dentro da mesma transação** elimina
a janela em que o estoque muda sem ninguém ser avisado. Uma Lambda separada
(`publishOutboxHandler`) entrega ao EventBridge.

Entrega é **at-least-once** → todo consumidor deduplica por `eventId`.

### Eventos publicados

| Evento | Quando |
|---|---|
| `vehicle.registered` / `vehicle.updated` | Cadastro / edição |
| `vehicle.reserved` | Passo 1 da SAGA concluído |
| `vehicle.reservation_released` | Compensação executada |
| `vehicle.reservation_expired` | TTL vencido sem pagamento |
| `vehicle.sold` | Baixa no estoque |

## Endpoints

| Método | Rota | Autorização |
|---|---|---|
| `GET` | `/vehicles` | pública |
| `GET` | `/vehicles/available` | pública — preço crescente |
| `GET` | `/vehicles/sold` | pública — preço crescente |
| `GET` | `/vehicles/:id` | pública |
| `POST` | `/vehicles` | grupo `admin` |
| `PUT` | `/vehicles/:id` | grupo `admin` |
| `POST` | `/vehicles/:id/reservations` | escopo `revenda/vehicles.reserve` |
| `POST` | `/vehicles/:id/reservations/release` | escopo `revenda/vehicles.reserve` |
| `POST` | `/vehicles/:id/sale` | escopo `revenda/vehicles.sell` |
| `GET` | `/health`, `/health/ready` | pública |

OpenAPI interativo em `/docs` (desabilitado quando `NODE_ENV=production`).

## Executando localmente

```bash
cp .env.example .env
npm ci
npm run prisma:generate
docker compose up -d postgres-vehicles   # da raiz do monorepo
npm run prisma:deploy
npm run seed
npm run dev                              # http://localhost:3001/docs
```

Gerar um token de desenvolvimento (`AUTH_MODE=dev`, HS256):

```bash
node -e "require('jose').SignJWT ? 0 : 0" # jose já instalado
npx tsx -e "
import { SignJWT } from 'jose';
const secret = new TextEncoder().encode(process.env.JWT_DEV_SECRET ?? 'dev-only-secret-change-me');
new SignJWT({ roles: ['admin'], scope: 'revenda/vehicles.reserve revenda/vehicles.sell' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject('dev-admin').setIssuedAt()
  .setExpirationTime('8h').sign(secret).then(console.log);
"
```

`AUTH_MODE=dev` é recusado quando `NODE_ENV=production` (validação em
`src/infrastructure/config/env.ts`).

## Testes

```bash
npm test              # unidade + HTTP, com cobertura
npm run typecheck
npm run lint
```

Cobertura mínima exigida no CI: 85% de linhas em `domain/` e `application/`.

## Decisões de projeto

| Decisão | Por quê |
|---|---|
| Preço em **centavos inteiros** | `double` não representa decimal de base 10 com exatidão; somas de preço acumulariam erro |
| **PostgreSQL** (Aurora Serverless v2), não DynamoDB | O requisito central é ordenação e filtro por faixa de preço sobre todo o estoque — `ORDER BY price` com índice composto. Em DynamoDB isso exigiria GSI com partição sintética e paginação frágil |
| **Prisma** + RDS Proxy | Migrações versionadas e tipagem do schema; o Proxy multiplexa as conexões efêmeras das Lambdas |
| **Trava otimista**, não pessimista | Transação curta, sem lock aberto esperando I/O — essencial em serverless |
| **EventBridge**, não SNS direto | O roteamento fica declarado em regras de infraestrutura; novo consumidor não exige alteração neste serviço |
| **Fastify** | ~2× o throughput do Express, validação/serialização por schema e cold start baixo em Lambda |
| VIN como **chave natural única** | Impede cadastrar o mesmo carro físico duas vezes; diferente da placa, não muda |

## Implantação

Dois artefatos a partir do mesmo código:

- `src/lambda-api.ts` — API atrás do API Gateway (HTTP API).
- `src/lambda-jobs.ts` — `expireReservationsHandler` e `publishOutboxHandler`,
  disparados por EventBridge Scheduler.

O `Dockerfile` existe para desenvolvimento local e como alternativa de deploy em
ECS Fargate, caso o perfil de tráfego deixe de favorecer Lambda.
