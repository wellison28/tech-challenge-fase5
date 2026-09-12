# Relatório de segurança de dados

Plataforma de revenda de veículos — Tech Challenge Fase 5

---

## 1. Quais dados a solução armazena

A plataforma tem três bancos. Apenas um contém dado pessoal.

### 1.1 vehicle-service — banco `vehicles`

Nenhum dado pessoal.

| Dado | Classificação | Observação |
|---|---|---|
| Identificador, chassi (VIN), placa | Público | Constam do anúncio |
| Marca, modelo, ano, cor, km, combustível, câmbio | Público | Vitrine |
| Preço (em centavos) | Público | Vitrine |
| Status (disponível/reservado/vendido) | Interno | |
| `reservation_customer_id`, `sale_customer_id` | **Pseudônimo** | UUID opaco. Não identifica ninguém sem acesso ao customer-service |
| Trilha de eventos (outbox) | Interno | Sem dado pessoal |

O chassi e a placa são dados do **veículo**, não da pessoa. Depois de vendido, a
placa passa a ser associável ao comprador por consulta externa — por isso a API
pública devolve a placa apenas de veículos à venda, e o vínculo
comprador↔veículo só existe como UUID.

### 1.2 customer-service — banco `customers`

**Concentra todo o dado pessoal da plataforma.**

| Dado | Classificação | Por que é coletado | Em repouso |
|---|---|---|---|
| `id` (UUID) | Pseudônimo | Referência entre serviços | Claro |
| Nome completo | **Pessoal** | Contrato de compra e venda; documentação do veículo | **Cifrado** |
| CPF | **Pessoal — identificador fiscal** | Obrigatório no código de pagamento (Pix/boleto exigem CPF do pagador) e no ATPV-e | **Cifrado** + índice cego |
| Data de nascimento | **Pessoal** | Verificação de capacidade civil (≥ 18 anos para adquirir veículo) | **Cifrado** |
| E-mail | **Pessoal** | Notificações do processo de compra; login | **Cifrado** + índice cego |
| Telefone | **Pessoal** | Contato sobre a compra | **Cifrado** |
| Endereço completo | **Pessoal** | Emissão do ATPV-e e cadastro do pagador | **Cifrado** |
| RG ou CNH (número e emissor) | **Pessoal** | Emissão do ATPV-e | **Cifrado** |
| Consentimentos (finalidade, versão da política, datas, canal) | Operacional | Demonstrar base legal — LGPD art. 8º, §2º | Claro |
| Trilha de acesso a dado pessoal | Operacional | Prestação de contas — LGPD art. 6º, X | Claro, *append-only* |

### 1.3 sales-service — banco `sales`

Nenhum dado pessoal armazenado.

| Dado | Classificação | Observação |
|---|---|---|
| Identificador do pedido, do cliente e do veículo | Pseudônimo | UUIDs opacos |
| Valor, status, linha do tempo da SAGA | Interno | |
| Identificador da cobrança no provedor | Interno | |
| **Código de pagamento** | **Sensível do ponto de vista financeiro** | Instrumento de cobrança. Devolvido apenas ao próprio comprador |
| Token de callback do Step Functions | **Segredo transitório** | Uso único; apagado ao ser consumido |

O perfil do pagador é obtido do customer-service **uma única vez**, no passo de
emissão da cobrança, repassado ao gateway e descartado. Não é gravado, não entra
em evento e é redigido no log.

---

## 2. Quais são os dados sensíveis

### 2.1 Dados pessoais sensíveis no sentido do art. 5º, II da LGPD

**Nenhum.** A plataforma não coleta origem racial ou étnica, convicção
religiosa, opinião política, filiação a sindicato, dado referente a saúde, vida
sexual, dado genético ou biométrico.

Isso é uma decisão de projeto, não uma constatação: **não existe finalidade de
negócio** na revenda de veículos que justifique coletar qualquer um desses
dados. Não coletar é o controle mais forte que existe — dado que não se tem não
vaza, não precisa ser cifrado e não gera obrigação de guarda.

### 2.2 Dados pessoais de maior criticidade (classificação interna)

Ainda que não sejam "sensíveis" no sentido legal estrito, os dados abaixo são
tratados no nível mais alto de proteção por causa do dano potencial ao titular:

| Dado | Dano potencial se vazar |
|---|---|
| **CPF** | Abertura de conta e contratação de crédito em nome do titular; base de fraude de identidade. É também chave de correlação com outras bases vazadas |
| **Nome + CPF + data de nascimento** | Conjunto suficiente para responder à maioria dos questionários de verificação de identidade |
| **Endereço residencial** | Risco físico: identifica onde a pessoa mora, associado a um veículo de valor conhecido |
| **RG / CNH** | Falsificação documental |
| **Endereço + veículo adquirido + preço pago** | Combinação que perfila poder aquisitivo e localização. É o vínculo mais perigoso da plataforma — e é justamente ele que a separação entre os serviços quebra |

O último item merece destaque: **a proteção mais importante desta arquitetura
não é criptográfica, é de modelagem**. O banco que sabe quem é a pessoa não sabe
que veículo ela comprou; o banco que sabe qual veículo foi vendido não sabe para
quem. Recompor a ligação exige comprometer dois serviços com credenciais
distintas, papéis IAM distintos e bancos distintos.

---

## 3. Políticas de acesso a dados implementadas

### 3.1 Autenticação

- **Amazon Cognito** com senha de no mínimo 12 caracteres (maiúscula, minúscula,
  número e símbolo), MFA por TOTP, e *advanced security* em modo `ENFORCED`, que
  detecta credencial vazada e *credential stuffing*.
- Token de acesso com validade de **1 hora**; token M2M, de **15 minutos**.
- `prevent_user_existence_errors = ENABLED`: a resposta de login não revela se um
  e-mail está cadastrado.
- Fluxo *Authorization Code + PKCE*, nunca *implicit* — o fluxo implícito devolve
  o token na URL, onde ele fica no histórico do navegador e nos logs de proxy.
- O token é validado pelo **authorizer JWT do API Gateway**, antes de qualquer
  Lambda ser invocada.

### 3.2 Autorização — perfis e o que cada um alcança

| Perfil | Vitrine | Cadastro próprio | Cadastro de terceiro | Dado pessoal em claro | Gestão de estoque |
|---|---|---|---|---|---|
| Anônimo | ✅ | autocadastro | ❌ | ❌ | ❌ |
| `customer` | ✅ | ✅ | ❌ | somente o próprio (portabilidade) | ❌ |
| `support` (atendimento) | ✅ | ✅ | **mascarado** | ❌ | ❌ |
| `admin` (equipe da revenda) | ✅ | ✅ | **mascarado** | ❌ | ✅ |
| `sales-service` (M2M) | — | — | — | apenas 2 endpoints, com escopo e finalidade próprios | reserva e baixa |

Dois pontos que valem explicitar:

**Nenhum ser humano lê dado pessoal em claro pela API.** Nem `admin`. O dado em
claro sai por exatamente três caminhos: dois endpoints máquina-a-máquina
(cobrança e documentação) e a portabilidade solicitada pelo próprio titular.
Se um atendente precisar conferir o CPF, ele confere pelos dígitos visíveis da
máscara (`***.***.247-25`), que bastam para identificação e não permitem
reconstrução.

**Um comprador autenticado não alcança o cadastro de outro.** O controle
`authorizeSelfOrRoles` compara o `:id` da URL com o `sub` do token. Sem ele,
qualquer conta válida leria a base inteira — é o vazamento mais banal e mais
comum de API.

### 3.3 Mascaramento por padrão

Toda rota de leitura comum devolve o dado reduzido:

| Campo | Como sai |
|---|---|
| Nome | `Maria A. d. S.` |
| CPF | `***.***.247-25` |
| E-mail | `ma*********@exemplo.com.br` |
| Telefone | `(11) *****-4321` |
| Endereço | apenas cidade e UF |
| RG/CNH | `******789` |

A inversão é deliberada: expor dado em claro passa a exigir uma **decisão
explícita no código**, e não o contrário.

### 3.4 Finalidade declarada e obrigatória

Toda requisição ao customer-service exige o cabeçalho **`X-Data-Purpose`**. Sem
ele, a resposta é `403`. As rotas de maior risco aceitam apenas uma lista
fechada de finalidades:

| Rota | Finalidades aceitas |
|---|---|
| `POST /customers` | `SELF_REGISTRATION`, `IN_STORE_REGISTRATION` |
| `GET /internal/.../eligibility` | `PURCHASE_SAGA` |
| `GET /internal/.../billing-profile` | `PAYMENT_CODE_ISSUANCE` |
| `GET /internal/.../documentation-dossier` | `VEHICLE_DOCUMENT_ISSUANCE` |
| `GET /customers/:id/personal-data-export` | `DATA_SUBJECT_REQUEST` |
| `DELETE /customers/:id` | `DATA_SUBJECT_REQUEST` |

O princípio da finalidade (art. 6º, I) **não é verificável depois do fato**: ou
a finalidade é declarada no momento do acesso e registrada, ou não há auditoria
possível. Por isso é requisito de protocolo, e não convenção de equipe.

Efeito prático: um token com escopo `customers.billing` não consegue ler o
perfil de cobrança declarando finalidade `PURCHASE_SAGA`. Há teste automatizado
verificando exatamente isso.

### 3.5 Escopos máquina-a-máquina granulares

Cinco escopos distintos no resource server do Cognito, um por operação:
`vehicles.reserve`, `vehicles.sell`, `customers.eligibility`,
`customers.billing`, `customers.documentation`.

Um escopo genérico "interno" transformaria qualquer comprometimento de serviço
em acesso total à plataforma.

### 3.6 Acesso no nível do banco

- **Um papel IAM por serviço.** O papel do vehicle-service não tem
  `kms:Decrypt` na chave de dados pessoais; o do customer-service não pode
  iniciar execuções da SAGA.
- **Autenticação IAM exigida no RDS Proxy** (`iam_auth = REQUIRED`), com
  `rds-db:connect` restrito ao usuário de banco do próprio serviço: nenhuma
  senha de banco em código ou em variável de ambiente. A geração do token de
  conexão na inicialização da Lambda (`@aws-sdk/rds-signer`) é o passo que
  ainda falta no código para o deploy em nuvem.
- **Papel de banco com privilégio mínimo** (`customer_service_app`):
  `SELECT/INSERT/UPDATE/DELETE` nas tabelas operacionais, mas **apenas
  `SELECT` e `INSERT`** na trilha de auditoria, sem nenhuma permissão de DDL.
- **Security groups em três camadas**: as subnets de dados não têm rota para a
  internet, nem de saída; o cluster só aceita conexão do RDS Proxy; o Proxy só
  aceita conexão das Lambdas do serviço dono.

### 3.7 Trilha de auditoria imutável

Cada acesso a dado pessoal grava: quem (`actorId`, `actorType`, papéis), quando,
qual finalidade, quais campos foram devolvidos em claro, o desfecho
(`ALLOWED`/`DENIED`), o `correlationId`, o IP e o *user agent*.

O registro acontece **na mesma transação** da operação auditada. Sem isso, uma
falha entre ler o dado e gravar o log produziria acesso sem rastro — exatamente
o cenário que a auditoria existe para impedir.

A imutabilidade é imposta em **duas camadas independentes**:

1. o papel da aplicação não tem `UPDATE` nem `DELETE` na tabela;
2. gatilhos `BEFORE UPDATE` e `BEFORE DELETE` recusam a operação no próprio
   PostgreSQL, mesmo que a permissão seja concedida por engano.

Uma credencial de aplicação comprometida — por SQL injection ou por vazamento do
segredo do banco — **não apaga o próprio rastro**.

As negativas também são registradas. Um pico de `DENIED` é o sinal mais precoce
de comprometimento que a plataforma produz, e está alarmado.

---

## 4. Políticas de segurança da operação

### 4.1 Criptografia

**Em trânsito**

- TLS 1.2+ em toda a borda (API Gateway).
- TLS obrigatório entre Lambda e RDS Proxy (`require_tls = true`), mesmo dentro
  da VPC — criptografia em trânsito não deve depender da confiança na rede.
- VPC endpoints para KMS, Secrets Manager, EventBridge, Step Functions, Logs,
  X-Ray e SQS: as chamadas que decifram dado pessoal nunca deixam a rede da AWS.

**Em repouso — três camadas**

1. **Volume do Aurora** cifrado com CMK. Um snapshot copiado para outra conta
   continua ilegível sem acesso à chave.
2. **Campo cifrado pela aplicação** (*envelope encryption* com AES-256-GCM). Nem
   um DBA com `SELECT` irrestrito lê CPF em claro.
3. **Logs e filas** cifrados com chave própria.

**Detalhes da criptografia de campo**

- **AES-256-GCM** (cifra autenticada): confidencialidade e integridade na mesma
  operação. Adulterar um byte do texto cifrado faz a decifragem falhar, em vez de
  produzir lixo silenciosamente.
- **IV aleatório por operação**: o mesmo CPF gera textos cifrados diferentes.
  Reutilizar IV em GCM quebra a cifra por completo.
- **AAD = `customerId:campo`**, espelhado no `EncryptionContext` do KMS. Um
  atacante com escrita no banco não consegue mover o CPF cifrado de um titular
  para a linha de outro: a verificação falha.
- **A chave de dados em claro é zerada da memória** (`key.fill(0)`) assim que
  deixa de ser necessária, encurtando a janela em que apareceria num core dump.
- **Envelope por registro, não por campo**: uma chamada ao KMS por escrita e uma
  por leitura, em vez de sete. Todos os campos têm a mesma classificação e o
  mesmo público autorizado, então a granularidade extra não acrescentaria
  controle — só custo e latência.

**Índice cego**

Cifra autenticada é não determinística, o que torna `WHERE cpf = ?` impossível.
A solução é guardar `HMAC-SHA256(pepper, cpf_normalizado)`:

- permite `UNIQUE` sobre CPF e busca exata, sem armazenar o valor;
- o *pepper* fica no **Secrets Manager**, nunca no banco. Sem ele, os hashes não
  são atacáveis por dicionário — o espaço de CPFs válidos tem menos de 10¹¹
  elementos e cairia em minutos contra um SHA-256 puro;
- `blindIndexVersion` viabiliza rotação do pepper sem indisponibilidade.

### 4.2 Gestão de segredos

Nenhum segredo em variável de ambiente da Lambda: elas aparecem no console, em
`GetFunctionConfiguration` — uma permissão de leitura comum — e em qualquer
despejo de diagnóstico. A Lambda recebe apenas o **identificador** do segredo e o
busca no Secrets Manager na inicialização, com cache no escopo do módulo.

Nenhum segredo em output do Terraform: outputs ficam em texto claro no arquivo
de estado.

O CI roda **gitleaks** em todo *push*, para impedir que uma chave entre no
histórico do repositório.

### 4.3 Redação em log

Log é o vazamento de dado pessoal mais comum e mais silencioso: vai para o
CloudWatch, é copiado para ferramentas de observabilidade, fica retido por meses
e é lido por muito mais gente do que o banco.

No customer-service a redação é agressiva de propósito:

- **`req.body` inteiro** é redigido — um campo novo no cadastro já nasce
  protegido;
- a **query string é removida da URL** antes de logar (é comum um CPF acabar num
  parâmetro de busca);
- campos pessoais são redigidos por padrão, com correspondência por curinga.

No log de acesso do API Gateway, o formato **não inclui** a query string.

### 4.4 Minimização nos eventos

**Nenhum evento de domínio carrega dado pessoal.** Eventos vão para um barramento
consumido por vários serviços e ficam retidos em filas, DLQs, arquivos de replay
e logs de entrega — é exatamente o tipo de lugar onde um CPF acaba esquecido em
texto claro.

O payload leva apenas o `customerId` opaco. Há **teste automatizado** no
customer-service e no sales-service — os dois que manipulam dado pessoal —
verificando que nenhum evento publicado contém CPF, e-mail ou nome. O
vehicle-service não recebe dado pessoal, apenas o UUID do comprador.

### 4.5 Retenção e descarte

| Dado | Retenção | Base |
|---|---|---|
| Cadastro do titular | Enquanto houver relação; depois, anonimização a pedido | LGPD art. 15 e 16 |
| Registro de venda | 5 anos após o exercício | Guarda fiscal obrigatória |
| Trilha de auditoria de dado pessoal | 5 anos | Prestação de contas (art. 6º, X) |
| Log de aplicação | 90 dias | Minimização — log retido indefinidamente é dado guardado sem finalidade |
| CloudTrail | 400 dias (Glacier IR após 90) | Investigação de incidente |
| Arquivo de eventos | 90 dias | Replay operacional |
| DLQ | 14 dias | Tempo de investigar e reprocessar |

### 4.6 Direitos do titular (LGPD art. 18)

| Direito | Como é atendido |
|---|---|
| Confirmação e acesso (I, II) | `GET /customers/:id` |
| Correção (III) | `PUT /customers/:id` |
| Portabilidade (V) | `GET /customers/:id/personal-data-export` — inclui a trilha de acessos ao próprio cadastro |
| **Eliminação (VI)** | `DELETE /customers/:id` |
| Informação sobre compartilhamento (VII) | A trilha registra cada exportação, com finalidade e campos |
| Revogação do consentimento (IX) | `DELETE /customers/:id/consents/:purpose` |

**Sobre a eliminação.** A operação sobrescreve todos os campos pessoais e
descarta o texto cifrado, a chave de dados cifrada e os índices cegos —
tornando-a **irreversível**. A linha é mantida com o `id`, porque as vendas
concluídas estão sob guarda fiscal obrigatória e continuam referenciando o
comprador; apagá-la quebraria a integridade do histórico e descumpriria outra
obrigação legal. O resultado atende à lei: o registro remanescente não
identifica ninguém.

O HMAC do CPF também é apagado — mantê-lo permitiria confirmar "esta pessoa
esteve aqui", o que é, por si só, um dado pessoal.

O evento `customer.anonymized` é publicado pelo outbox e já tem regra de
roteamento no EventBridge. Nesta entrega nenhum outro serviço guarda dado
derivado do titular — vehicle-service e sales-service conhecem apenas o UUID —,
então não há o que propagar. A regra existe para que qualquer consumidor futuro
que mantenha cache ou projeção (BI, notificação) seja obrigado a tratar a
eliminação; sem isso, ela passaria a ser parcial.

A **trilha de auditoria sobrevive** à anonimização: ela não guarda dado pessoal,
apenas o identificador opaco, e é a prova de que o pedido do titular foi
atendido.

### 4.7 Base legal por finalidade

| Finalidade | Base legal | Revogável isoladamente |
|---|---|---|
| `PURCHASE_PROCESSING` | Execução de contrato — art. 7º, V | Não. Exige excluir o cadastro |
| `DOCUMENT_ISSUANCE` | Obrigação legal — art. 7º, II | Não |
| `MARKETING` | Consentimento — art. 7º, I | **Sim** |
| `CREDIT_ANALYSIS` | Consentimento — art. 7º, I | **Sim** |

Cada registro de consentimento guarda **quando**, **por qual canal** e **sob qual
versão da política de privacidade** o titular consentiu. Um booleano não
demonstra consentimento (art. 8º, §2º).

A revogação é um endpoint no mesmo nível do cadastro, e não um pedido por
e-mail: a lei exige que revogar seja tão fácil quanto consentir (art. 8º, §5º).

### 4.8 Segurança do ciclo de desenvolvimento

| Controle | Onde |
|---|---|
| `npm audit --audit-level=high` | CI de cada serviço, falha o build |
| gitleaks | CI do repositório, em todo *push* |
| Lint, typecheck e testes obrigatórios | CI |
| Cobertura mínima de 85% em `domain/` e `application/` | CI |
| Validação da definição da SAGA | CI do sales-service |
| Imagem Docker multi-estágio, sem compilador nem dev dependencies | `Dockerfile` |
| Contêiner roda como usuário sem privilégio (`USER node`) | `Dockerfile` |
| Configuração validada na inicialização (*fail fast*) | `loadEnv` |
| Modos inseguros **proibidos** em produção | `loadEnv`: recusa `AUTH_MODE=dev`, `CRYPTO_MODE=local`, `SAGA_MODE=inline`, `PAYMENT_PROVIDER=fake` |

O último item é o que impede o erro operacional mais provável de todos: subir em
produção com uma variável de ambiente de desenvolvimento. O serviço **não sobe**.

---

## 5. Riscos e ações de mitigação

Riscos ordenados por impacto residual. "Residual" = o que sobra depois dos
controles já implementados.

### Risco 1 — Vazamento do banco de dados pessoais

| | |
|---|---|
| **Cenário** | Dump do Aurora obtido por snapshot copiado, backup mal configurado ou comprometimento do host |
| **Impacto** | Máximo: CPF, endereço e documento de todos os compradores |
| **Controles** | Volume cifrado com CMK; **cada campo pessoal cifrado pela aplicação** com chave que vive no KMS, fora do banco; índice cego com pepper no Secrets Manager; subnets de dados sem rota para a internet |
| **Impacto residual** | **Baixo.** O dump, isolado, é ilegível. Decifrar exige `kms:Decrypt` na CMK **com o contexto correto** — permissão concedida a um único papel e registrada no CloudTrail |
| **Ação adicional** | Alarme sobre volume anômalo de `kms:Decrypt`; revisão trimestral de quem tem a permissão |

### Risco 2 — Credencial da aplicação comprometida

| | |
|---|---|
| **Cenário** | SQL injection, RCE na Lambda, ou vazamento do segredo do banco |
| **Impacto** | Leitura de dado pessoal em claro pela via legítima da aplicação |
| **Controles** | Toda leitura auditada na mesma transação; papel de banco sem `UPDATE`/`DELETE` na auditoria; gatilhos que recusam mutação da trilha; GuardDuty detecta uso anômalo; Prisma parametriza toda consulta |
| **Impacto residual** | **Médio.** O atacante lê, mas **não apaga o rastro** — e o volume de leituras dispara o alarme de privacidade |
| **Ação adicional** | Alarme sobre volume anômalo de `EXPORT_FOR_BILLING`; rotação automática das credenciais; revisão periódica da trilha |

### Risco 3 — Funcionário curioso ou mal-intencionado

| | |
|---|---|
| **Cenário** | Atendente consulta o cadastro de uma celebridade, de um vizinho ou de um ex-cônjuge |
| **Impacto** | Exposição pontual, mas com dano concreto ao titular |
| **Controles** | Mascaramento por padrão — nenhum humano lê dado em claro pela API; `support` não alcança os endpoints de cobrança e documentação; toda leitura registra quem, quando e com que finalidade |
| **Impacto residual** | **Baixo.** O que se obtém é a máscara, e o acesso fica registrado com o nome de quem o fez |
| **Ação adicional** | Relatório mensal de acessos por operador; alerta sobre operador com volume muito acima da mediana |

### Risco 4 — Enumeração de CPF pelo cadastro público

| | |
|---|---|
| **Cenário** | Atacante envia CPFs sequenciais e usa a resposta `409` para descobrir quem já é cliente |
| **Impacto** | Vazamento de pertencimento à base — informação valiosa para engenharia social |
| **Controles** | WAF com limite de 100 req/5 min em `/customers`; limite de 5 req/min na aplicação; a mensagem de erro devolve o CPF **mascarado**; validação de dígitos verificadores reduz o espaço de busca útil |
| **Impacto residual** | **Baixo.** Nos limites atuais, varrer um espaço relevante levaria anos |
| **Ação adicional** | Considerar CAPTCHA no autocadastro; alarme sobre pico de `409` neste endpoint |

### Risco 5 — Webhook de pagamento forjado

| | |
|---|---|
| **Cenário** | Atacante chama `/webhooks/payments` declarando um pedido como pago |
| **Impacto** | **Prejuízo financeiro direto**: um veículo entregue sem pagamento |
| **Controles** | Assinatura HMAC-SHA256 do corpo, conferida em **tempo constante** sobre os **bytes originais** da requisição; o pedido só avança se a cobrança pertencer a ele; a retirada exige conferência presencial por `admin` |
| **Impacto residual** | **Baixo**, condicionado à proteção do segredo HMAC (Secrets Manager) |
| **Ação adicional** | Rotação periódica do segredo; conciliação diária entre pedidos concluídos e extrato do provedor |

### Risco 6 — Dado pessoal vazando para log ou evento

| | |
|---|---|
| **Cenário** | Um campo novo é adicionado ao cadastro e acaba logado por descuido |
| **Impacto** | Dado pessoal replicado para CloudWatch e ferramentas de observabilidade, com retenção e público muito maiores |
| **Controles** | `req.body` inteiro redigido; query string removida da URL; eventos sem dado pessoal por contrato, **verificado por teste automatizado**; logs cifrados com KMS e retenção de 90 dias |
| **Impacto residual** | **Baixo** |
| **Ação adicional** | Revisão de payload de log em *code review*; varredura periódica dos grupos de log em busca de padrão de CPF |

### Risco 7 — Compensação da SAGA falha e deixa estado inconsistente

| | |
|---|---|
| **Cenário** | A liberação da reserva falha após o pagamento não se confirmar |
| **Impacto** | Veículo preso fora do estoque — receita perdida todo dia em que permanecer assim |
| **Controles** | Compensação idempotente com 6 tentativas e backoff; pedido permanece em `COMPENSATING`, estado **observável**; alarme crítico no `ExecutionsFailed`; **rede de segurança independente**: a expiração de reservas devolve o veículo à vitrine a cada minuto, mesmo que a SAGA tenha morrido |
| **Impacto residual** | **Muito baixo.** Duas rotas independentes precisam falhar simultaneamente |
| **Ação adicional** | Runbook de intervenção manual documentado |

### Risco 8 — Perda de disponibilidade

| | |
|---|---|
| **Cenário** | Falha de zona de disponibilidade, esgotamento de conexões do banco, ou pico de tráfego |
| **Impacto** | Interrupção de vendas |
| **Controles** | Multi-AZ; RDS Proxy absorve o failover; concorrência reservada nas Lambdas protege o pool; WAF barra tráfego abusivo antes da invocação; throttling no stage |
| **Impacto residual** | **Baixo** |
| **Ação adicional** | Teste de carga antes de campanha promocional; revisão do teto de ACU |

### Risco 9 — Exclusão acidental da chave KMS de dados pessoais

| | |
|---|---|
| **Cenário** | Erro operacional ou `terraform destroy` indevido |
| **Impacto** | **Catastrófico e irreversível**: toda a base de dados pessoais torna-se permanentemente ilegível |
| **Controles** | Janela de exclusão de 30 dias; `deletion_protection` no cluster em produção; estado do Terraform com bloqueio; CloudTrail registra a solicitação de exclusão |
| **Impacto residual** | **Baixo**, mas o impacto potencial exige atenção contínua |
| **Ação adicional** | Alarme sobre `ScheduleKeyDeletion`; SCP na organização negando a exclusão desta chave |

### Risco 10 — Fornecedor (provedor de pagamento) comprometido

| | |
|---|---|
| **Cenário** | O provedor sofre incidente e expõe os dados de pagador que recebeu |
| **Impacto** | Nome, CPF e e-mail dos compradores expostos por terceiro |
| **Controles** | Apenas os campos estritamente necessários são enviados — não vão endereço, RG nem data de nascimento; o envio é registrado na trilha de auditoria; o sales-service não persiste o retorno |
| **Impacto residual** | **Médio.** Depende do controlador terceiro — é o risco que a arquitetura **não** consegue eliminar sozinha |
| **Ação adicional** | Cláusula contratual de tratamento de dados; avaliação de segurança do fornecedor; avaliar tokenização do pagador, se o provedor oferecer |

---

## 6. Resposta a incidente

| Fase | Instrumento disponível |
|---|---|
| **Detecção** | GuardDuty (≥ 7 → SNS), alarme de acessos negados a dado pessoal, alarme de DLQ, Security Hub |
| **Contenção** | Revogar o papel IAM; desabilitar o cliente Cognito; bloquear IP no WAF; desabilitar a chave KMS (interrompe toda decifragem imediatamente) |
| **Investigação** | CloudTrail (cada `kms:Decrypt`), trilha de acesso a dado pessoal (quem, quando, qual finalidade, quais campos), VPC Flow Logs, histórico do Step Functions, `correlationId` ponta a ponta |
| **Notificação** | A trilha responde **exatamente quais titulares** tiveram dado acessado — requisito do art. 48, que exige comunicar a ANPD e os titulares afetados em prazo razoável |
| **Recuperação** | Backup do Aurora (30 dias no banco de PII), arquivo de eventos para replay (90 dias) |

O ponto crítico da notificação é a **precisão do escopo**. Sem a trilha, a única
resposta honesta a "quais titulares foram afetados?" seria "todos" — o que
transformaria um incidente contido numa notificação de base inteira, com o dano
reputacional e regulatório correspondente.

---

## 7. Resumo dos controles

| Camada | Controles |
|---|---|
| **Borda** | WAF (5 regras), API Gateway com authorizer JWT, throttling, CORS restrito |
| **Identidade** | Cognito com MFA e advanced security, grupos, escopos M2M granulares, tokens curtos |
| **Aplicação** | Mascaramento por padrão, finalidade obrigatória, verificação de titularidade, validação de schema, rate limit próprio |
| **Dados** | Envelope encryption AES-256-GCM com AAD, índice cego com pepper, CMK por finalidade, criptografia de volume |
| **Rede** | VPC de três camadas, subnets de dados sem rota para a internet, security groups por serviço, VPC endpoints, TLS obrigatório |
| **Acesso** | Papel IAM por serviço, autenticação IAM no RDS Proxy, papel de banco com privilégio mínimo, auditoria append-only |
| **Detecção** | GuardDuty, Security Hub, CloudTrail validado, Flow Logs, alarmes de negócio e de privacidade |
| **Processo** | Fail fast na configuração, modos inseguros proibidos em produção, npm audit, gitleaks, cobertura mínima, imagem mínima sem root |
