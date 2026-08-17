FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY . .
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "apps/api/server.js"]
