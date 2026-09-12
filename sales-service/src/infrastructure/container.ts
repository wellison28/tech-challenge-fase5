import { PrismaClient } from '@prisma/client';
import { EventFactory } from '../application/events/event-factory';
import { Clock, SystemClock } from '../application/ports/clock';
import { CustomerDirectoryPort } from '../application/ports/customer-directory';
import { EventPublisher } from '../application/ports/event-publisher';
import { IdGenerator } from '../application/ports/id-generator';
import { PaymentGatewayPort } from '../application/ports/payment-gateway';
import { SagaCallbackPort } from '../application/ports/saga-callback';
import { SagaLauncherPort } from '../application/ports/saga-launcher';
import { UnitOfWork } from '../application/ports/unit-of-work';
import { VehicleCatalogPort } from '../application/ports/vehicle-catalog';
import { PurchaseSagaOrchestrator } from '../application/saga/orchestrator';
import { PurchaseSagaSteps } from '../application/saga/steps';
import { CancelPurchaseUseCase } from '../application/usecases/cancel-purchase';
import { ConfirmPaymentUseCase } from '../application/usecases/confirm-payment';
import { DeliverVehicleUseCase } from '../application/usecases/deliver-vehicle';
import { ExpireOrdersUseCase } from '../application/usecases/expire-orders';
import { GetOrderUseCase, ListOrdersUseCase } from '../application/usecases/get-order';
import { PublishOutboxUseCase } from '../application/usecases/publish-outbox';
import { RegisterPaymentWaiterUseCase } from '../application/usecases/register-payment-waiter';
import { StartPurchaseUseCase } from '../application/usecases/start-purchase';
import { CustomerDirectoryClient } from './clients/customer-directory-client';
import { HttpClient } from './clients/http-client';
import { DevTokenProvider, M2mTokenProvider } from './clients/m2m-token-provider';
import { FakePaymentGateway, HttpPaymentGateway } from './clients/payment-gateway';
import { VehicleCatalogClient } from './clients/vehicle-catalog-client';
import { Env, loadEnv } from './config/env';
import { UuidGenerator } from './config/uuid-generator';
import { EventBridgePublisher, LoggingEventPublisher } from './messaging/eventbridge-publisher';
import { Logger, createLogger } from './observability/logger';
import { getPrismaClient } from './persistence/prisma/prisma-client';
import { PrismaUnitOfWork } from './persistence/prisma/prisma-unit-of-work';
import { NoopSagaCallback, StepFunctionsSagaCallback } from './saga/saga-callback';
import { InlineSagaLauncher, StepFunctionsSagaLauncher } from './saga/saga-launcher';

/** Escopos que o sales-service precisa nos serviços parceiros. */
const M2M_SCOPES = [
  'revenda/vehicles.reserve',
  'revenda/vehicles.sell',
  'revenda/customers.eligibility',
  'revenda/customers.billing',
  'revenda/customers.documentation',
];

export interface Container {
  env: Env;
  logger: Logger;
  prisma: PrismaClient;
  clock: Clock;
  ids: IdGenerator;
  unitOfWork: UnitOfWork;
  publisher: EventPublisher;
  vehicles: VehicleCatalogPort;
  customers: CustomerDirectoryPort;
  payments: PaymentGatewayPort;
  steps: PurchaseSagaSteps;
  orchestrator: PurchaseSagaOrchestrator;
  useCases: {
    startPurchase: StartPurchaseUseCase;
    getOrder: GetOrderUseCase;
    listOrders: ListOrdersUseCase;
    confirmPayment: ConfirmPaymentUseCase;
    cancelPurchase: CancelPurchaseUseCase;
    deliverVehicle: DeliverVehicleUseCase;
    registerPaymentWaiter: RegisterPaymentWaiterUseCase;
    expireOrders: ExpireOrdersUseCase;
    publishOutbox: PublishOutboxUseCase;
  };
}

export interface ContainerOverrides {
  env?: Env;
  prisma?: PrismaClient;
  clock?: Clock;
  ids?: IdGenerator;
  unitOfWork?: UnitOfWork;
  publisher?: EventPublisher;
  vehicles?: VehicleCatalogPort;
  customers?: CustomerDirectoryPort;
  payments?: PaymentGatewayPort;
  sagaLauncher?: SagaLauncherPort;
  sagaCallback?: SagaCallbackPort;
}

export function buildContainer(overrides: ContainerOverrides = {}): Container {
  const env = overrides.env ?? loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    serviceName: env.SERVICE_NAME,
    env: env.NODE_ENV,
  });

  const prisma = overrides.prisma ?? getPrismaClient();
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new UuidGenerator();
  const unitOfWork = overrides.unitOfWork ?? new PrismaUnitOfWork(prisma);
  const events = new EventFactory(ids, clock);

  const publisher =
    overrides.publisher ??
    (env.NODE_ENV === 'development' && !env.AWS_ENDPOINT_URL
      ? new LoggingEventPublisher((message, payload) => logger.info({ payload }, message))
      : new EventBridgePublisher(env.EVENT_BUS_NAME, `revenda.${env.SERVICE_NAME}`, {
          region: env.AWS_REGION,
          ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
        }));

  const tokenProvider =
    env.AUTH_MODE === 'dev'
      ? new DevTokenProvider(env.JWT_DEV_SECRET ?? 'dev-only-secret-change-me', M2M_SCOPES)
      : new M2mTokenProvider({
          tokenUrl: env.M2M_TOKEN_URL!,
          clientId: env.M2M_CLIENT_ID!,
          clientSecret: env.M2M_CLIENT_SECRET!,
          scopes: M2M_SCOPES,
        });

  const httpFor = (baseUrl: string): HttpClient =>
    new HttpClient({
      baseUrl,
      timeoutMs: env.PARTNER_REQUEST_TIMEOUT_MS,
      maxRetries: env.PARTNER_MAX_RETRIES,
      getAuthToken: () => tokenProvider.getToken(),
    });

  const vehicles =
    overrides.vehicles ?? new VehicleCatalogClient(httpFor(env.VEHICLE_SERVICE_URL));
  const customers =
    overrides.customers ?? new CustomerDirectoryClient(httpFor(env.CUSTOMER_SERVICE_URL));

  const payments =
    overrides.payments ??
    (env.PAYMENT_PROVIDER === 'fake'
      ? new FakePaymentGateway(env.PAYMENT_WEBHOOK_SECRET)
      : new HttpPaymentGateway(httpFor(env.PAYMENT_API_URL!), env.PAYMENT_WEBHOOK_SECRET));

  const steps = new PurchaseSagaSteps(
    unitOfWork,
    clock,
    events,
    vehicles,
    customers,
    payments,
    env.PAYMENT_WINDOW_MINUTES,
  );

  const orchestrator = new PurchaseSagaOrchestrator(steps, {
    info: (payload, message) => logger.info(payload, message),
    warn: (payload, message) => logger.warn(payload, message),
    error: (payload, message) => logger.error(payload, message),
  });

  /**
   * No modo inline não há execução suspensa para retomar: o próprio processo
   * segue adiante, e o callback é um dublê que não faz nada.
   */
  const sagaCallback =
    overrides.sagaCallback ??
    (env.SAGA_MODE === 'stepfunctions'
      ? new StepFunctionsSagaCallback({
          region: env.AWS_REGION,
          ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
        })
      : new NoopSagaCallback());

  const sagaLauncher =
    overrides.sagaLauncher ??
    (env.SAGA_MODE === 'stepfunctions'
      ? new StepFunctionsSagaLauncher(env.PURCHASE_SAGA_STATE_MACHINE_ARN!, {
          region: env.AWS_REGION,
          ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
        })
      : new InlineSagaLauncher(orchestrator));

  return {
    env,
    logger,
    prisma,
    clock,
    ids,
    unitOfWork,
    publisher,
    vehicles,
    customers,
    payments,
    steps,
    orchestrator,
    useCases: {
      startPurchase: new StartPurchaseUseCase(unitOfWork, ids, clock, events, sagaLauncher),
      getOrder: new GetOrderUseCase(unitOfWork),
      listOrders: new ListOrdersUseCase(unitOfWork),
      confirmPayment: new ConfirmPaymentUseCase(unitOfWork, clock, events, steps, sagaCallback),
      cancelPurchase: new CancelPurchaseUseCase(unitOfWork, clock, steps, sagaCallback),
      deliverVehicle: new DeliverVehicleUseCase(unitOfWork, clock, events),
      registerPaymentWaiter: new RegisterPaymentWaiterUseCase(unitOfWork, clock),
      expireOrders: new ExpireOrdersUseCase(unitOfWork, clock, steps, payments),
      publishOutbox: new PublishOutboxUseCase(unitOfWork, publisher, clock),
    },
  };
}
