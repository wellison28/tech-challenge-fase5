# ============================================================================
# Build multi-stágio. O estágio final não contém compilador, código-fonte nem
# dependências de desenvolvimento — reduz o tamanho da imagem e a superfície de
# ataque (menos pacotes instalados, menos CVEs a monitorar no ECR scan).
# ============================================================================
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# dumb-init como PID 1: repassa SIGTERM ao Node, permitindo o encerramento
# gracioso implementado em server.ts (drenar requisições antes de sair).
RUN apk add --no-cache dumb-init

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

COPY --from=build /app/dist ./dist

# Nunca como root: uma execução de código arbitrário fica confinada a um
# usuário sem privilégios.
USER node
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3003/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/infrastructure/http/server.js"]
