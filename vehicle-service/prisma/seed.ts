import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/**
 * Massa de dados para desenvolvimento e demonstração.
 * Preços deliberadamente fora de ordem, para evidenciar a ordenação exigida
 * nas listagens de veículos à venda e vendidos.
 */
const prisma = new PrismaClient();

const catalog = [
  { brand: 'Volkswagen', model: 'Nivus Highline 200 TSI', modelYear: 2024, manufactureYear: 2023, color: 'Prata', mileageKm: 18_500, fuelType: 'FLEX', transmission: 'AUTOMATIC', priceInCents: 12_999_000 },
  { brand: 'Fiat', model: 'Argo Drive 1.0', modelYear: 2022, manufactureYear: 2022, color: 'Branco', mileageKm: 42_300, fuelType: 'FLEX', transmission: 'MANUAL', priceInCents: 6_890_000 },
  { brand: 'Toyota', model: 'Corolla XEi 2.0', modelYear: 2023, manufactureYear: 2023, color: 'Preto', mileageKm: 27_800, fuelType: 'FLEX', transmission: 'CVT', priceInCents: 16_450_000 },
  { brand: 'Hyundai', model: 'HB20 Comfort 1.0', modelYear: 2021, manufactureYear: 2021, color: 'Cinza', mileageKm: 58_900, fuelType: 'FLEX', transmission: 'MANUAL', priceInCents: 5_990_000 },
  { brand: 'Jeep', model: 'Compass Longitude T270', modelYear: 2024, manufactureYear: 2024, color: 'Azul', mileageKm: 9_100, fuelType: 'FLEX', transmission: 'AUTOMATIC', priceInCents: 18_990_000 },
  { brand: 'Chevrolet', model: 'Onix LT 1.0 Turbo', modelYear: 2023, manufactureYear: 2022, color: 'Vermelho', mileageKm: 31_200, fuelType: 'FLEX', transmission: 'AUTOMATIC', priceInCents: 8_750_000 },
  { brand: 'Honda', model: 'HR-V EXL', modelYear: 2022, manufactureYear: 2022, color: 'Prata', mileageKm: 46_700, fuelType: 'FLEX', transmission: 'CVT', priceInCents: 14_200_000 },
  { brand: 'Renault', model: 'Kwid Zen 1.0', modelYear: 2023, manufactureYear: 2023, color: 'Laranja', mileageKm: 12_400, fuelType: 'FLEX', transmission: 'MANUAL', priceInCents: 5_490_000 },
  { brand: 'BYD', model: 'Dolphin Mini GS', modelYear: 2025, manufactureYear: 2024, color: 'Branco', mileageKm: 3_200, fuelType: 'ELECTRIC', transmission: 'AUTOMATIC', priceInCents: 11_590_000 },
  { brand: 'Toyota', model: 'Hilux SRV 4x4', modelYear: 2021, manufactureYear: 2021, color: 'Prata', mileageKm: 89_600, fuelType: 'DIESEL', transmission: 'AUTOMATIC', priceInCents: 22_900_000 },
] as const;

const VIN_ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const PLATE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function vin(index: number): string {
  const suffix = String(index).padStart(6, '0');
  return `9BW${VIN_ALPHABET.slice(0, 8)}${suffix}`.slice(0, 17).toUpperCase();
}

function plate(index: number): string {
  const letters = [0, 1, 2].map((offset) => PLATE_LETTERS[(index * 3 + offset) % 26]).join('');
  return `${letters}${index % 10}${PLATE_LETTERS[index % 26]}${String(index % 100).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  await prisma.outboxEvent.deleteMany();
  await prisma.vehicle.deleteMany();

  const now = new Date();
  const soldOrderId = randomUUID();
  const soldCustomerId = randomUUID();

  await prisma.vehicle.createMany({
    data: catalog.map((item, index) => {
      // Os dois últimos entram como vendidos, para popular a listagem de vendidos.
      const isSold = index >= catalog.length - 2;
      return {
        id: randomUUID(),
        vin: vin(index + 1),
        licensePlate: plate(index + 1),
        ...item,
        status: isSold ? ('SOLD' as const) : ('AVAILABLE' as const),
        ...(isSold
          ? {
              saleOrderId: index === catalog.length - 1 ? soldOrderId : randomUUID(),
              saleCustomerId: soldCustomerId,
              soldAt: new Date(now.getTime() - index * 86_400_000),
              soldPriceInCents: item.priceInCents,
            }
          : {}),
      };
    }),
  });

  const available = await prisma.vehicle.count({ where: { status: 'AVAILABLE' } });
  const sold = await prisma.vehicle.count({ where: { status: 'SOLD' } });
  // eslint-disable-next-line no-console
  console.log(`Seed concluído: ${available} veículo(s) à venda, ${sold} vendido(s).`);
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
