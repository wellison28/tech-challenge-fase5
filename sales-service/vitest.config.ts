import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/domain/**', 'src/application/**'],
      // O núcleo (domínio + aplicação) é onde mora a regra de negócio; é ele
      // que precisa de cobertura alta. Adaptadores são cobertos pelos testes
      // de integração, que sobem Postgres real.
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
