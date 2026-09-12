# sales-service

Microsserviço de **vendas** e **orquestrador da SAGA de compra**. É ele que
conduz o processo de ponta a ponta — da seleção do veículo até a retirada — e
que desfaz o que já foi feito quando algo dá errado no caminho.

## O processo de compra

```
   cliente seleciona o veículo
              │
              ▼
    ┌──────────────────┐  falha ─────────────────────────┐
    │ 1 Reservar       │                                 │
    │   veículo        │                                 │
    └────────┬─────────┘                                 │
             ▼                                           │
    ┌──────────────────┐  não habilitado ────────────────┤
    │ 2 Validar        │                                 │
    │   comprador      │                                 │
    └────────┬─────────┘                                 ▼
             ▼                                   ┌───────────────┐
    ┌──────────────────┐  falha ────────────────▶│  COMPENSAR    │
    │ 3 Emitir código  │                         │  • cancelar   │
    │   de pagamento   │                         │    cobrança   │
    └────────┬─────────┘                         │  • liberar    │
             ▼                                   │    reserva    │
    ┌──────────────────┐  timeout / recusa /     └───────┬───────┘
    │ 4 Aguardar       │  desistência ──────────────────▶│
    │   pagamento      │                                 ▼
    └────────┬─────────┘                         CANCELLED / FAILED
             ▼
    ┌──────────────────┐  reserva expirou ───────────────┘
    │ 5 Baixa no       │  (estorna)
    │   estoque        │
    └────────┬─────────┘
             ▼
    ┌──────────────────┐
    │ 6 Retirada       │ ──▶ COMPLETED
    └──────────────────┘
```

**Por que a reserva é o passo 1**: o veículo é o recurso escasso e disputado.
Falhar ali custa barato, porque nada foi feito ainda e não há o que compensar.
Se a validação do comprador viesse antes, uma disputa perdida jogaria fora o
trabalho já realizado e ampliaria a janela em que outro cliente poderia levar o
carro.

## Orquestração: AWS Step Functions

A definição vive em
[`infra/statemachine/purchase-saga.asl.json`](infra/statemachine/purchase-saga.asl.json)
e a justificativa completa da escolha (orquestração × coreografia) está em
[`docs/relatorio-saga.md`](../docs/relatorio-saga.md).

Cada passo é uma Lambda deste serviço (`src/lambda-saga.ts`). A máquina de
estados detém **apenas a coordenação**: ordem dos passos, política de retry,
timeout e rota de compensação. Nenhuma regra de negócio vive no JSON.

### A espera pelo pagamento

O estado `AguardarPagamento` usa `waitForTaskToken`: a execução fica **suspensa
sem consumir computação** até que o webhook do provedor devolva o token. O
`TimeoutSeconds` do próprio estado implementa a janela de pagamento — é o
orquestrador que detecta a desistência por inação, sem processo de varredura no
caminho principal.

O token é gravado no pedido, não em memória: a Lambda que o recebeu morre em
seguida, e o webhook pode chegar em outra instância, horas depois. Ele é
consumido **uma única vez**, dentro de uma transação com trava otimista — dois
webhooks concorrentes não disparam dois callbacks para a mesma execução.

### Modo inline

`SAGA_MODE=inline` roda a mesma sequência dentro do processo
(`PurchaseSagaOrchestrator`), para desenvolvimento local e testes. Os dois modos
chamam exatamente os mesmos passos (`PurchaseSagaSteps`); o que muda é quem
decide a ordem. É essa simetria que impede a lógica de negócio de ficar presa
dentro de um JSON de máquina de estados — e é o que torna a orquestração
testável em milissegundos.

`loadEnv` recusa `SAGA_MODE=inline` quando `NODE_ENV=production`.

## Os problemas do enunciado, e onde cada um é tratado

| Cenário | Tratamento | Onde |
|---|---|---|
| Outro cliente reserva o veículo antes | O passo 1 recebe 409 (não-retentável); a SAGA encerra com `VEHICLE_UNAVAILABLE` sem emitir cobrança | `steps.reserveVehicle` |
| Pagamento não é efetuado | `TimeoutSeconds` do `AguardarPagamento` dispara a compensação | ASL + `ExpireOrdersUseCase` (rede de segurança) |
| Pagamento recusado | Webhook devolve `SendTaskFailure` com `PagamentoRecusado` | `ConfirmPaymentUseCase` |
| Cliente desiste em qualquer passo | `POST /orders/:id/cancellation` devolve o token com `ClienteDesistiu` | `CancelPurchaseUseCase` |
| Pagamento confirmado **depois** do prazo | Não conclui a venda: estorna. A reserva pode ter caído e o carro ter sido vendido a outro | `Order.markPaid` |
| Webhook perdido e cliente pagou | A varredura consulta o provedor antes de compensar e resgata a venda | `ExpireOrdersUseCase` |
| Compensação falha no meio | Pedido fica em `COMPENSATING` — estado observável e alarmado | `steps.compensate` |

## Idempotência

Todo passo pode ser reexecutado sem duplicar efeito, porque o Step Functions
reexecuta após timeout de rede e o provedor de pagamento entrega webhooks
ao-menos-uma-vez:

| Passo | Como é idempotente |
|---|---|
| Reservar veículo | O vehicle-service devolve a mesma reserva para o mesmo `orderId` |
| Emitir cobrança | `Idempotency-Key` = `orderId`; o provedor devolve a mesma cobrança |
| Confirmar pagamento | `Order.markPaid` retorna sem efeito se já pago |
| Baixa no estoque | O passo nem chama o parceiro se o pedido já está `SALE_CONFIRMED` |
| Compensar | Cancelar cobrança e liberar reserva são idempotentes nos parceiros |

## Invariante entre serviços

`PAYMENT_WINDOW_MINUTES` **deve** ser menor que `RESERVATION_TTL_MINUTES` do
vehicle-service. Se fosse maior, o veículo voltaria sozinho à vitrine enquanto o
pedido ainda aceitasse pagamento — e dois compradores poderiam pagar pelo mesmo
carro. A checagem é feita na inicialização (`loadEnv`) e o serviço se recusa a
subir se for violada.

## Resiliência das chamadas aos parceiros

`HttpClient` concentra as decisões que, espalhadas, ficariam inconsistentes:

- **timeout explícito** — sem ele, uma chamada pendurada consome a execução
  inteira da Lambda;
- **retry apenas do que é seguro** — 5xx, 429 e falha de rede. Um 409 é decisão
  definitiva do parceiro; insistir só queima a janela de pagamento;
- **backoff exponencial com jitter** — sem o componente aleatório, todas as
  execuções que falharam juntas voltariam juntas;
- **token M2M próprio** — o serviço usa identidade e escopos próprios, nunca o
  token do comprador. Repassar o token do usuário transformaria qualquer falha
  aqui em escalonamento de privilégio.

## Segurança do webhook

O endpoint `/webhooks/payments` não exige token — quem chama é o provedor, que
não tem credencial no Cognito. A autenticidade vem da **assinatura HMAC-SHA256**
do corpo, conferida em tempo constante. Sem ela, qualquer um declararia um
pedido como pago e retiraria um veículo sem pagar.

A verificação usa os **bytes originais** da requisição, preservados por um
content-type parser próprio (`app.ts`). Reserializar o objeto já parseado
produziria outra sequência de bytes e a assinatura nunca conferiria.

## Dados pessoais

O sales-service não armazena nenhum. O banco guarda apenas identificadores
opacos (`customerId`, `vehicleId`) e valores.

O perfil do pagador (nome, CPF, e-mail) é obtido do customer-service **uma única
vez**, no passo 3, repassado ao gateway e descartado: não é gravado, não entra
em evento e é redigido no log. Há teste verificando que nenhum evento publicado
contém dado pessoal.

## Endpoints

| Método | Rota | Autorização |
|---|---|---|
| `POST` | `/orders` | `customer` (para si) ou `admin` |
| `GET` | `/orders/:id` | titular do pedido ou `admin` |
| `GET` | `/orders` | titular (filtro forçado) ou `admin` |
| `POST` | `/orders/:id/cancellation` | titular do pedido ou `admin` |
| `POST` | `/orders/:id/pickup` | `admin` (balcão da loja) |
| `POST` | `/webhooks/payments` | assinatura HMAC |
| `GET` | `/health`, `/health/ready` | pública |

O **código de pagamento** só é devolvido ao próprio comprador: é um instrumento
de cobrança, e exibi-lo a um operador permitiria que alguém pagasse — ou
divulgasse — a cobrança de outra pessoa.

## Executando localmente

```bash
cp .env.example .env
npm ci
npm run prisma:generate
docker compose up -d postgres-sales    # da raiz do monorepo
npm run prisma:deploy
npm run dev                            # http://localhost:3003/docs
```

Com `SAGA_MODE=inline` e `PAYMENT_PROVIDER=fake` o fluxo inteiro roda sem nuvem
e sem provedor externo.

## Testes

```bash
npm test          # 75 testes: domínio, orquestração da SAGA e HTTP
npm run typecheck
npm run lint
```

Os testes de orquestração cobrem os cenários do enunciado um a um — disputa de
estoque, comprador inelegível, pagamento recusado, pagamento tardio, desistência
do cliente, webhook perdido e compensação que falha no meio.

## Decisões de projeto

| Decisão | Por quê |
|---|---|
| Orquestração (Step Functions), não coreografia | Compensação explícita, timeout de negócio e visibilidade da execução. Ver `docs/relatorio-saga.md` |
| Passos como Lambdas independentes | A coordenação fica declarada em um só lugar; a regra de negócio, testável fora dele |
| `waitForTaskToken` para a espera | A execução não consome computação enquanto o cliente decide; o timeout é do próprio orquestrador |
| Token de callback no banco | A espera sobrevive ao fim da Lambda e ao reinício do serviço |
| Linha do tempo persistida no pedido | Responder "por que este pedido falhou" meses depois; uma máquina de estados sem histórico é opaca em produção |
| Chamadas a parceiros fora da transação | Manter HTTP dentro de transação seguraria conexão do pool pelo tempo da rede |
| Varredura de reconciliação | Webhook é entrega não confiável; sem ela, um aviso perdido custaria a venda a um cliente que pagou |
