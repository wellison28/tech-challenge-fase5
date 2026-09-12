# Infraestrutura

Terraform da plataforma de revenda de veículos na AWS. Provisiona rede, bancos,
funções, API, autenticação, orquestração da SAGA, serviços de segurança e
observabilidade.

## Como rodar

```bash
cd infra
cp environments/prod.tfvars.example environments/prod.tfvars   # e ajuste
terraform init
terraform plan  -var-file=environments/prod.tfvars
terraform apply -var-file=environments/prod.tfvars
```

O estado fica em S3 com bloqueio no DynamoDB (ver `versions.tf`). Estado local
em projeto de equipe produz `apply` concorrentes e destruição acidental.

Validação sem credenciais AWS:

```bash
terraform fmt -recursive -check
terraform init -backend=false && terraform validate
```

## Organização

| Arquivo | Conteúdo |
|---|---|
| `network.tf` | VPC de três camadas, NAT por AZ, VPC endpoints, Flow Logs |
| `security.tf` | KMS (3 chaves), Secrets Manager, WAF, GuardDuty, Security Hub, CloudTrail |
| `cognito.tf` | User pool, grupos, resource server com escopos, clientes web e M2M |
| `database.tf` | Três clusters Aurora Serverless v2 + RDS Proxy |
| `iam.tf` | Um papel de execução por serviço, com permissões escritas caso a caso |
| `lambdas.tf` | 3 APIs, 6 tasks da SAGA, 5 processos periódicos |
| `api.tf` | HTTP API, authorizer JWT, rotas, stage, associação com o WAF |
| `messaging.tf` | EventBridge bus, arquivo, DLQs, EventBridge Scheduler |
| `saga.tf` | Máquina de estados do Step Functions |
| `observability.tf` | Alarmes, filtros de métrica, painel |
| `modules/aurora-serverless` | Cluster + Proxy + credenciais, reutilizado 3× |
| `modules/lambda-function` | Função padronizada: log cifrado, retenção, tracing |

A definição da SAGA vive com o serviço que a implementa
(`sales-service/infra/statemachine/purchase-saga.asl.json`) e é lida daqui com
`templatefile`.

## Decisões que valem destacar

**Três clusters, não um.** Database-per-service. Custa mais — três clusters em
vez de um — e é pago conscientemente: com Serverless v2 no piso de 0,5 ACU o
gasto em repouso é baixo, e em troca nenhum serviço alcança as tabelas de outro.

**Subnets de dados sem rota para a internet.** Nem de saída. Um banco que não
consegue iniciar conexão para fora é um banco de onde não se exfiltra por
conexão reversa.

**Um NAT por zona.** Um NAT único economizaria, mas a perda daquela zona
derrubaria a saída de internet de todas as Lambdas.

**VPC endpoints para KMS e Secrets Manager.** Sem eles, as chamadas que
decifram dado pessoal sairiam pelo NAT e atravessariam a internet pública.

**Três chaves KMS, não uma.** A política de cada chave define quem pode usá-la.
Com uma chave só, quem pudesse decifrar log poderia decifrar CPF.

**Contexto de criptografia obrigatório dos dois lados.** A política da chave e a
política do papel exigem `kms:EncryptionContext:service`. Uma decifragem sem
contexto é recusada, e o contexto fica registrado no CloudTrail.

**Concorrência reservada nas Lambdas.** Sem teto, um pico abre execuções até
esgotar o pool do RDS Proxy — e derruba também o que estava funcionando.

**ARN da máquina de estados montado, não referenciado.** As Lambdas dos passos
precisam do ARN, e a máquina de estados precisa do ARN das Lambdas. Referenciar
os dois sentidos cria ciclo no grafo; montar o ARN (determinístico a partir do
nome) quebra o ciclo sem perder nada.

**Segredos fora dos outputs.** Outputs ficam em texto claro no arquivo de
estado. O segredo do cliente M2M é gravado no Secrets Manager.

## Custo estimado (ambiente de produção pequeno)

| Item | Ordem de grandeza/mês |
|---|---|
| 3× Aurora Serverless v2 (0,5–4 ACU) | maior parcela; escala com o uso |
| 3× RDS Proxy | por vCPU da instância-alvo |
| Lambda (ARM64) | proporcional a invocações; o nível gratuito cobre tráfego baixo |
| API Gateway HTTP | ~1/3 do REST API |
| NAT Gateway (2×) | custo fixo relevante — é o item a revisar primeiro |
| WAF + regras gerenciadas | fixo por ACL + por milhão de requisições |
| Step Functions Standard | por transição de estado |
| GuardDuty, Security Hub, CloudTrail | proporcional ao volume de eventos |

Duas alavancas de redução, se o orçamento apertar: trocar os dois NAT Gateways
por um só (aceitando o risco de zona) e reduzir a faixa máxima de ACU dos
clusters.
