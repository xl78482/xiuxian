FROM node:22.23.2-alpine AS frontend-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY apps/miniapp ./apps/miniapp
COPY scripts/build-miniapp.js ./scripts/build-miniapp.js
COPY tailwind.config.cjs tsconfig.json ./
RUN npm run typecheck && npm run build

FROM node:22.23.2-alpine
LABEL org.opencontainers.image.title="XiuXian" \
      org.opencontainers.image.version="1.0.41" \
      org.opencontainers.image.source="https://github.com/xl78482/xiuxian"
WORKDIR /app
COPY --chown=node:node apps/api ./apps/api
COPY --chown=node:node apps/admin ./apps/admin
COPY --chown=node:node apps/worker ./apps/worker
COPY --chown=node:node packages ./packages
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node .env.example ./
COPY --from=frontend-build --chown=node:node /build/apps/miniapp/dist ./apps/miniapp/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "apps/api/server.js"]
