import { PrismaClient } from '@prisma/client';
import { EventFactory } from '../application/events/event-factory';
import { Clock, SystemClock } from '../application/ports/clock';
import { EventPublisher } from '../application/ports/event-publisher';
import { IdGenerator } from '../application/ports/id-generator';
import { UnitOfWork } from '../application/ports/unit-of-work';
import { ConfirmVehicleSaleUseCase } from '../application/usecases/confirm-vehicle-sale';
import { ExpireReservationsUseCase } from '../application/usecases/expire-reservations';
import { GetVehicleUseCase } from '../application/usecases/get-vehicle';
import { ListVehiclesUseCase } from '../application/usecases/list-vehicles';
import { PublishOutboxUseCase } from '../application/usecases/publish-outbox';
import { RegisterVehicleUseCase } from '../application/usecases/register-vehicle';
import { ReleaseReservationUseCase } from '../application/usecases/release-reservation';
import { ReserveVehicleUseCase } from '../application/usecases/reserve-vehicle';
import { UpdateVehicleUseCase } from '../application/usecases/update-vehicle';
import { Env, loadEnv } from './config/env';
import { UuidGenerator } from './config/uuid-generator';
import {
  EventBridgePublisher,
  LoggingEventPublisher,
} from './messaging/eventbridge-publisher';
import { Logger, createLogger } from './observability/logger';
import { PrismaUnitOfWork } from './persistence/prisma/prisma-unit-of-work';
import { getPrismaClient } from './persistence/prisma/prisma-client';

export interface Container {
  env: Env;
  logger: Logger;
  prisma: PrismaClient;
  clock: Clock;
  ids: IdGenerator;
  unitOfWork: UnitOfWork;
  publisher: EventPublisher;
  useCases: {
    registerVehicle: RegisterVehicleUseCase;
    updateVehicle: UpdateVehicleUseCase;
    getVehicle: GetVehicleUseCase;
    listVehicles: ListVehiclesUseCase;
    reserveVehicle: ReserveVehicleUseCase;
    releaseReservation: ReleaseReservationUseCase;
    confirmVehicleSale: ConfirmVehicleSaleUseCase;
    expireReservations: ExpireReservationsUseCase;
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
}

/**
 * Composition root.
 *
 * Único lugar do serviço onde as implementações concretas encontram as
 * abstrações. Os casos de uso não conhecem Prisma, EventBridge nem Fastify —
 * é isso que permite testá-los com dublês e trocar um adaptador (por exemplo,
 * EventBridge por SNS) sem tocar em regra de negócio.
 */
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

  return {
    env,
    logger,
    prisma,
    clock,
    ids,
    unitOfWork,
    publisher,
    useCases: {
      registerVehicle: new RegisterVehicleUseCase(unitOfWork, ids, clock, events),
      updateVehicle: new UpdateVehicleUseCase(unitOfWork, clock, events),
      getVehicle: new GetVehicleUseCase(unitOfWork),
      listVehicles: new ListVehiclesUseCase(unitOfWork),
      reserveVehicle: new ReserveVehicleUseCase(
        unitOfWork,
        ids,
        clock,
        events,
        env.RESERVATION_TTL_MINUTES,
      ),
      releaseReservation: new ReleaseReservationUseCase(unitOfWork, clock, events),
      confirmVehicleSale: new ConfirmVehicleSaleUseCase(unitOfWork, clock, events),
      expireReservations: new ExpireReservationsUseCase(unitOfWork, clock, events),
      publishOutbox: new PublishOutboxUseCase(unitOfWork, publisher, clock),
    },
  };
}
