import { PrismaClient } from '@prisma/client';
import { AuditRecorder } from '../application/audit/audit-recorder';
import { EventFactory } from '../application/events/event-factory';
import { Clock, SystemClock } from '../application/ports/clock';
import { BlindIndex, FieldCipher } from '../application/ports/crypto';
import { EventPublisher } from '../application/ports/event-publisher';
import { IdGenerator } from '../application/ports/id-generator';
import { UnitOfWork } from '../application/ports/unit-of-work';
import { AnonymizeCustomerUseCase } from '../application/usecases/anonymize-customer';
import { ChangeCustomerStatusUseCase } from '../application/usecases/change-customer-status';
import { CheckPurchaseEligibilityUseCase } from '../application/usecases/check-purchase-eligibility';
import { ExportPersonalDataUseCase } from '../application/usecases/export-personal-data';
import { GetCustomerUseCase } from '../application/usecases/get-customer';
import { ManageConsentUseCase } from '../application/usecases/manage-consent';
import { PublishOutboxUseCase } from '../application/usecases/publish-outbox';
import { RegisterCustomerUseCase } from '../application/usecases/register-customer';
import { UpdateCustomerUseCase } from '../application/usecases/update-customer';
import { Env, loadEnv } from './config/env';
import { getSecret } from './config/secrets';
import { UuidGenerator } from './config/uuid-generator';
import { HmacBlindIndex } from './crypto/hmac-blind-index';
import { KmsFieldCipher } from './crypto/kms-field-cipher';
import { LocalFieldCipher } from './crypto/local-field-cipher';
import { EventBridgePublisher, LoggingEventPublisher } from './messaging/eventbridge-publisher';
import { Logger, createLogger } from './observability/logger';
import { getPrismaClient } from './persistence/prisma/prisma-client';
import { PrismaUnitOfWork } from './persistence/prisma/prisma-unit-of-work';

export interface Container {
  env: Env;
  logger: Logger;
  prisma: PrismaClient;
  clock: Clock;
  ids: IdGenerator;
  cipher: FieldCipher;
  blindIndex: BlindIndex;
  unitOfWork: UnitOfWork;
  publisher: EventPublisher;
  useCases: {
    registerCustomer: RegisterCustomerUseCase;
    getCustomer: GetCustomerUseCase;
    updateCustomer: UpdateCustomerUseCase;
    changeStatus: ChangeCustomerStatusUseCase;
    manageConsent: ManageConsentUseCase;
    anonymizeCustomer: AnonymizeCustomerUseCase;
    checkEligibility: CheckPurchaseEligibilityUseCase;
    exportPersonalData: ExportPersonalDataUseCase;
    publishOutbox: PublishOutboxUseCase;
  };
}

export interface ContainerOverrides {
  env?: Env;
  prisma?: PrismaClient;
  clock?: Clock;
  ids?: IdGenerator;
  cipher?: FieldCipher;
  blindIndex?: BlindIndex;
  unitOfWork?: UnitOfWork;
  publisher?: EventPublisher;
}

/**
 * Resolve o pepper do índice cego.
 *
 * Em produção vem do Secrets Manager; a variável de ambiente é aceita apenas
 * como caminho de desenvolvimento. Colocar o pepper em variável de ambiente da
 * Lambda o exporia em `GetFunctionConfiguration`, que é uma permissão de
 * leitura comum — e o pepper é o que impede o ataque de dicionário sobre os
 * hashes de CPF.
 */
async function resolvePepper(env: Env): Promise<string> {
  if (env.CPF_PEPPER_SECRET_ID && env.NODE_ENV === 'production') {
    return getSecret(env.CPF_PEPPER_SECRET_ID, {
      region: env.AWS_REGION,
      ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    });
  }
  if (env.CPF_BLIND_INDEX_PEPPER) {
    return env.CPF_BLIND_INDEX_PEPPER;
  }
  if (env.CPF_PEPPER_SECRET_ID) {
    return getSecret(env.CPF_PEPPER_SECRET_ID, {
      region: env.AWS_REGION,
      ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    });
  }
  throw new Error('Pepper do índice cego não configurado');
}

/**
 * Composition root.
 *
 * É assíncrono porque a inicialização precisa buscar segredos. O custo é pago
 * uma vez por cold start da Lambda, não por requisição.
 */
export async function buildContainer(overrides: ContainerOverrides = {}): Promise<Container> {
  const env = overrides.env ?? loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    serviceName: env.SERVICE_NAME,
    env: env.NODE_ENV,
  });

  const prisma = overrides.prisma ?? getPrismaClient();
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new UuidGenerator();

  const cipher =
    overrides.cipher ??
    (env.CRYPTO_MODE === 'kms'
      ? new KmsFieldCipher(env.KMS_KEY_ID!, {
          region: env.AWS_REGION,
          ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
        })
      : new LocalFieldCipher(env.LOCAL_MASTER_KEY!));

  const blindIndex =
    overrides.blindIndex ?? new HmacBlindIndex(await resolvePepper(env), env.BLIND_INDEX_VERSION);

  const unitOfWork =
    overrides.unitOfWork ??
    new PrismaUnitOfWork(prisma, cipher, blindIndex, env.BLIND_INDEX_VERSION);

  const publisher =
    overrides.publisher ??
    (env.NODE_ENV === 'development' && !env.AWS_ENDPOINT_URL
      ? new LoggingEventPublisher((message, payload) => logger.info({ payload }, message))
      : new EventBridgePublisher(env.EVENT_BUS_NAME, `revenda.${env.SERVICE_NAME}`, {
          region: env.AWS_REGION,
          ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
        }));

  const events = new EventFactory(ids, clock);
  const audit = new AuditRecorder(ids, clock);

  return {
    env,
    logger,
    prisma,
    clock,
    ids,
    cipher,
    blindIndex,
    unitOfWork,
    publisher,
    useCases: {
      registerCustomer: new RegisterCustomerUseCase(
        unitOfWork, ids, clock, events, audit, env.PRIVACY_POLICY_VERSION,
      ),
      getCustomer: new GetCustomerUseCase(unitOfWork, audit),
      updateCustomer: new UpdateCustomerUseCase(unitOfWork, clock, events, audit),
      changeStatus: new ChangeCustomerStatusUseCase(unitOfWork, clock, events, audit),
      manageConsent: new ManageConsentUseCase(
        unitOfWork, clock, events, audit, env.PRIVACY_POLICY_VERSION,
      ),
      anonymizeCustomer: new AnonymizeCustomerUseCase(unitOfWork, clock, events, audit),
      checkEligibility: new CheckPurchaseEligibilityUseCase(unitOfWork, clock, audit),
      exportPersonalData: new ExportPersonalDataUseCase(unitOfWork, clock, audit),
      publishOutbox: new PublishOutboxUseCase(unitOfWork, publisher, clock),
    },
  };
}
