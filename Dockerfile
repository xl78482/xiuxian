FROM node:22.23.2-alpine
LABEL org.opencontainers.image.title="XiuXian" \
      org.opencontainers.image.version="1.0.15" \
      org.opencontainers.image.source="https://github.com/xl78482/xiuxian"
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "apps/api/server.js"]
