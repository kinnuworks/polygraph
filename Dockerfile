# Gateway and dashboard. Secrets come from the platform's environment settings, never from the image.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4242
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --include=dev --no-audit --no-fund
COPY data/offers ./data/offers
EXPOSE 4242
CMD ["npx", "tsx", "apps/gateway/src/server.ts"]
