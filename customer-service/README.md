# customer-service

Microsserviço de **cadastro de compradores**. É o único componente da
plataforma que armazena dado pessoal — e, por isso, o que concentra os
controles de proteção de dados.

Os outros dois serviços conhecem apenas o `customerId`, um UUID opaco. Um
comprometimento do catálogo de veículos ou do serviço de vendas não expõe
nenhum titular.

## Responsabilidades

| Capacidade | Quem consome |
|---|---|
| Autocadastro de comprador | Frontend (público, com limite de 5 req/min) |
| Consulta e atualização cadastral (mascarada) | Titular, `support`, `admin` |
| Ativação e bloqueio de cadastro | `admin` |
| Consentimento: conceder e revogar | Titular, `admin` |
| Portabilidade e eliminação (art. 18, V e VI) | Titular, `admin` |
| Elegibilidade de compra | `sales-service` (SAGA) — sem dado pessoal |
| Perfil de cobrança / dossiê de documentação | `sales-service` (SAGA) — auditado |

## Dados armazenados e classificação

| Dado | Classificação | Por que é coletado | Em repouso |
|---|---|---|---|
| `id` (UUID) | Pseudônimo | Referência entre serviços | Claro |
| Nome completo | Pessoal | Contrato e documentação do veículo | **Cifrado** |
| CPF | Pessoal, identificador fiscal | Código de pagamento e ATPV-e | **Cifrado** + índice cego |
| Data de nascimento | Pessoal | Capacidade civil (≥ 18 anos) | **Cifrado** |
| E-mail | Pessoal | Notificações do processo de compra | **Cifrado** + índice cego |
| Telefone | Pessoal | Contato sobre a compra | **Cifrado** |
| Endereço completo | Pessoal | Emissão do ATPV-e e cadastro do pagador | **Cifrado** |
| RG / CNH | Pessoal | Emissão do ATPV-e | **Cifrado** |
| Consentimentos | Operacional | Demonstrar base legal (art. 8º, §2º) | Claro |
| Trilha de auditoria | Operacional | Prestação de contas (art. 6º, X) | Claro, *append-only* |

Nenhum dado sensível do art. 5º, II da LGPD (saúde, biometria, origem racial,
convicção religiosa, opinião política) é coletado — não há finalidade de
negócio que o justifique, e não coletar é o controle mais forte que existe.

## Controles de segurança implementados

### 1. Criptografia em nível de campo com envelope encryption (AWS KMS)

```
GenerateDataKey ─▶ chave AES-256 em claro + chave cifrada
                     │                        │
                     ▼                        ▼
        AES-256-GCM sobre o PII        gravada na linha
                     │
                     ▼
         a chave em claro é zerada da memória
```

- **AES-256-GCM** (AEAD): confidencialidade e integridade na mesma operação.
  Adulterar um byte do texto cifrado faz a decifragem falhar.
- **AAD** = `customerId:campo`. Mover o CPF cifrado de um titular para a linha
  de outro quebra a verificação — um atacante com escrita no banco não consegue
  recombinar registros.
- **IV aleatório por operação**: o mesmo CPF gera textos cifrados diferentes.
- A chave mestra vive no KMS, fora do banco. Um dump do PostgreSQL, isolado,
  não é decifrável.

### 2. Índice cego (blind index) para busca e unicidade

Cifra autenticada é não determinística, então `WHERE cpf = ?` é impossível.
A solução é guardar `HMAC-SHA256(pepper, cpf_normalizado)`:

- permite `UNIQUE` sobre CPF e busca exata, sem armazenar o valor;
- o *pepper* fica no **Secrets Manager**, nunca no banco nem em variável de
  ambiente da Lambda em produção. Sem ele, os hashes não são atacáveis por
  dicionário — e o espaço de CPFs válidos (< 10¹¹) cairia em minutos contra um
  SHA-256 puro;
- `blindIndexVersion` viabiliza rotação do pepper sem indisponibilidade.

### 3. Mascaramento por padrão

Toda rota de leitura comum devolve `***.***.247-25`, `ma*****@exemplo.com`,
`(11) *****-4321` e apenas cidade/UF. Expor dado em claro exige uma decisão
explícita no código, em um dos três caminhos auditados.

### 4. Finalidade declarada (`X-Data-Purpose`)

Requisito de protocolo: sem o cabeçalho, a requisição é recusada com 403. O
princípio da finalidade (art. 6º, I) não é verificável depois do fato — ou a
finalidade é declarada e registrada no momento do acesso, ou não há auditoria
possível.

### 5. Trilha de auditoria *append-only*

Cada acesso grava quem, quando, qual finalidade, quais campos e qual desfecho
(`ALLOWED`/`DENIED`) — **na mesma transação** da operação auditada. Sem isso,
uma falha entre ler o dado e gravar o log produziria acesso sem rastro.

A imutabilidade é imposta em duas camadas (ver
`prisma/migrations/20260101000100_audit_append_only`):

- o papel `customer_service_app` só tem `SELECT` e `INSERT` na tabela;
- gatilhos `BEFORE UPDATE`/`BEFORE DELETE` recusam a operação no próprio banco.

Uma credencial de aplicação comprometida não apaga o próprio rastro.

### 6. Autorização em camadas

| Controle | O que impede |
|---|---|
| `authorizeSelfOrRoles` | Um comprador autenticado trocar o `:id` da URL pelo de outra pessoa |
| Escopos M2M distintos (`eligibility` / `billing` / `documentation`) | O serviço de vendas ler mais do que o passo em execução precisa |
| `requirePurpose` com lista fechada por rota | Reuso de um token válido para uma finalidade diferente |
| Limite de 5 req/min no autocadastro | Enumerar CPFs cadastrados pela resposta 409 |

### 7. Redação no log

Log é o vazamento mais silencioso: vai ao CloudWatch, é copiado para
ferramentas de observabilidade e lido por muito mais gente que o banco. Aqui a
redação cobre `req.body` inteiro, a query string é removida da URL e os campos
pessoais são redigidos por padrão — um campo novo no cadastro já nasce protegido.

### 8. Anonimização irreversível (art. 18, VI)

`DELETE /customers/:id` sobrescreve todos os campos pessoais, descarta o texto
cifrado, a chave de dados e os índices cegos, e mantém a linha com o `id`.

A linha é mantida porque as vendas concluídas estão sob guarda fiscal
obrigatória: apagá-la quebraria a integridade do histórico e descumpriria outra
obrigação legal. O resultado atende à lei — o registro remanescente não
identifica ninguém. Manter o HMAC do CPF permitiria confirmar "esta pessoa
esteve aqui", então ele também é apagado.

## Endpoints

| Método | Rota | Autorização | Finalidade exigida |
|---|---|---|---|
| `POST` | `/customers` | pública (5/min) | `SELF_REGISTRATION`, `IN_STORE_REGISTRATION` |
| `GET` | `/customers/:id` | titular, `support`, `admin` | qualquer (registrada) |
| `PUT` | `/customers/:id` | titular, `admin` | qualquer |
| `POST` | `/customers/:id/activation` | `admin` | qualquer |
| `POST` | `/customers/:id/block` | `admin` | qualquer |
| `POST` | `/customers/:id/consents` | titular, `admin` | qualquer |
| `DELETE` | `/customers/:id/consents/:purpose` | titular, `admin` | qualquer |
| `GET` | `/customers/:id/personal-data-export` | titular, `admin` | `DATA_SUBJECT_REQUEST` |
| `DELETE` | `/customers/:id` | titular, `admin` | `DATA_SUBJECT_REQUEST` |
| `GET` | `/internal/customers/:id/eligibility` | escopo `customers.eligibility` | `PURCHASE_SAGA` |
| `GET` | `/internal/customers/:id/billing-profile` | escopo `customers.billing` | `PAYMENT_CODE_ISSUANCE` |
| `GET` | `/internal/customers/:id/documentation-dossier` | escopo `customers.documentation` | `VEHICLE_DOCUMENT_ISSUANCE` |

OpenAPI em `/docs` (desabilitado em produção).

## Consentimento e base legal

| Finalidade | Base legal | Revogável isoladamente |
|---|---|---|
| `PURCHASE_PROCESSING` | Execução de contrato (art. 7º, V) | Não — exige excluir o cadastro |
| `DOCUMENT_ISSUANCE` | Cumprimento de obrigação legal (art. 7º, II) | Não |
| `MARKETING` | Consentimento (art. 7º, I) | Sim |
| `CREDIT_ANALYSIS` | Consentimento (art. 7º, I) | Sim |

Cada registro guarda quando, por qual canal e sob qual versão da política de
privacidade o titular consentiu — um booleano não demonstra consentimento
(art. 8º, §2º).

## Executando localmente

```bash
cp .env.example .env
npm ci
npm run prisma:generate
docker compose up -d postgres-customers   # da raiz do monorepo
npm run prisma:deploy
npm run seed
npm run dev                               # http://localhost:3002/docs
```

`CRYPTO_MODE=local` usa uma chave simétrica local em vez do KMS, com **a mesma
forma de dado e o mesmo AAD** — o código de aplicação não percebe diferença.
`loadEnv` recusa `CRYPTO_MODE=local` e `AUTH_MODE=dev` quando
`NODE_ENV=production`.

## Testes

```bash
npm test          # 91 testes: domínio, casos de uso, criptografia e HTTP
npm run typecheck
npm run lint
```

Os testes de criptografia rodam contra a implementação real e verificam
propriedades, não apenas o caminho feliz: IV distinto por operação, detecção de
adulteração da tag GCM, recusa de decifragem com o contexto de outro titular e
irreversibilidade do índice cego.

## Riscos conhecidos e mitigação

| Risco | Mitigação |
|---|---|
| Vazamento do dump do banco | Dado pessoal cifrado com chave que vive no KMS; índice cego com pepper no Secrets Manager |
| Credencial da aplicação comprometida | Papel sem `UPDATE`/`DELETE` na auditoria; gatilhos no banco; CloudTrail registra cada `kms:Decrypt` |
| Funcionário curioso | Mascaramento por padrão; `support` nunca alcança dado em claro; toda leitura auditada com finalidade |
| Enumeração de CPF pelo cadastro | 5 req/min por IP no autocadastro; WAF com regra de taxa; mensagem de erro mascarada |
| PII em log ou em evento | Redação agressiva no pino; nenhum evento de domínio carrega dado pessoal (verificado por teste) |
| Reuso de token para outra finalidade | `X-Data-Purpose` com lista fechada por rota, registrado na auditoria |

## Decisões de projeto

| Decisão | Por quê |
|---|---|
| Um envelope por registro, não por campo | Uma chamada ao KMS por escrita/leitura em vez de sete. Todos os campos têm a mesma classificação e o mesmo público autorizado, então a granularidade extra não acrescentaria controle |
| Criptografia no adaptador de persistência | O domínio raciocina sobre CPF, não sobre AES-GCM. Trocar o provedor de chaves não altera nenhum caso de uso |
| CPF não editável | É a chave natural do titular e a base do índice cego. Corrigir um CPF errado é, de fato, cadastrar outra pessoa |
| Anonimizar em vez de apagar a linha | Guarda fiscal obrigatória das vendas concluídas; a integridade referencial do histórico é preservada sem manter dado pessoal |
| Dado pessoal sai por API, nunca por evento | Eventos ficam retidos em filas, DLQs e logs de entrega — é onde um CPF é esquecido em claro |
