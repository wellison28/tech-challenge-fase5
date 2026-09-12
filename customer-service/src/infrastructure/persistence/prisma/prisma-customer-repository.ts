import type { Prisma, PrismaClient } from '@prisma/client';
import { BlindIndex } from '../../../application/ports/crypto';
import { Customer } from '../../../domain/entities/customer';
import {
  CustomerFilters,
  CustomerRepository,
  PageQuery,
  Paginated,
} from '../../../domain/repositories/customer-repository';
import { Cpf } from '../../../domain/value-objects/cpf';
import { Email } from '../../../domain/value-objects/email';
import { CustomerMapper } from './customer-mapper';

type Client = PrismaClient | Prisma.TransactionClient;

export class PrismaCustomerRepository implements CustomerRepository {
  constructor(
    private readonly client: Client,
    private readonly mapper: CustomerMapper,
    private readonly blindIndex: BlindIndex,
    private readonly blindIndexVersion: number,
  ) {}

  async create(customer: Customer): Promise<void> {
    const { scalars, consents } = await this.mapper.toPersistence(customer);

    await this.client.customer.create({
      data: {
        ...(scalars as Prisma.CustomerUncheckedCreateInput),
        cpfBlindIndex: customer.cpf ? await this.blindIndex.compute(customer.cpf.value) : null,
        emailBlindIndex: customer.email ? await this.blindIndex.compute(customer.email.value) : null,
        blindIndexVersion: this.blindIndexVersion,
        consents: { create: consents.map((consent) => ({ ...consent, source: consent.source as never })) },
      },
    });
  }

  /**
   * Atualização com trava otimista. Os consentimentos são regravados por
   * inteiro (delete + create) dentro da mesma transação: o conjunto é pequeno e
   * a substituição integral evita divergência entre o agregado em memória e as
   * linhas em banco.
   */
  async update(customer: Customer, expectedVersion: number): Promise<boolean> {
    const { scalars, consents } = await this.mapper.toPersistence(customer);
    const { id: _id, createdAt: _createdAt, ...data } = scalars;

    const result = await this.client.customer.updateMany({
      where: { id: customer.id, version: expectedVersion },
      data: {
        ...(data as Prisma.CustomerUncheckedUpdateManyInput),
        // Após a anonimização os índices cegos também são apagados: manter o
        // HMAC do CPF permitiria confirmar "esta pessoa esteve aqui".
        cpfBlindIndex: customer.cpf ? await this.blindIndex.compute(customer.cpf.value) : null,
        emailBlindIndex: customer.email ? await this.blindIndex.compute(customer.email.value) : null,
      },
    });

    if (result.count !== 1) {
      return false;
    }

    await this.client.customerConsent.deleteMany({ where: { customerId: customer.id } });
    if (consents.length > 0) {
      await this.client.customerConsent.createMany({
        data: consents.map((consent) => ({
          customerId: customer.id,
          ...consent,
          source: consent.source as never,
        })),
      });
    }

    return true;
  }

  async findById(id: string): Promise<Customer | null> {
    const row = await this.client.customer.findUnique({
      where: { id },
      include: { consents: true },
    });
    return row ? this.mapper.toDomain(row) : null;
  }

  async findByCpf(cpf: Cpf): Promise<Customer | null> {
    const row = await this.client.customer.findUnique({
      where: { cpfBlindIndex: await this.blindIndex.compute(cpf.value) },
      include: { consents: true },
    });
    return row ? this.mapper.toDomain(row) : null;
  }

  async findByEmail(email: Email): Promise<Customer | null> {
    const row = await this.client.customer.findUnique({
      where: { emailBlindIndex: await this.blindIndex.compute(email.value) },
      include: { consents: true },
    });
    return row ? this.mapper.toDomain(row) : null;
  }

  async list(filters: CustomerFilters, page: PageQuery): Promise<Paginated<Customer>> {
    const where: Prisma.CustomerWhereInput = filters.status ? { status: filters.status } : {};

    const [rows, total] = await Promise.all([
      this.client.customer.findMany({
        where,
        include: { consents: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      this.client.customer.count({ where }),
    ]);

    return {
      // Cada item exige uma decifragem; por isso o tamanho de página é limitado
      // a 50 na borda HTTP — listar dado pessoal é caro de propósito.
      items: await Promise.all(rows.map((row) => this.mapper.toDomain(row))),
      total,
      page: page.page,
      pageSize: page.pageSize,
      totalPages: Math.max(1, Math.ceil(total / page.pageSize)),
    };
  }
}
