# FORKY API - production image (multi-stage, non-root).
# Build:  docker build -t forky-api ./backend
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S forky && adduser -S forky -G forky
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY package.json ./
# uploads: public images; private-uploads: proof-of-delivery photos (mount both as volumes, or switch to object storage)
RUN mkdir -p uploads private-uploads && chown -R forky:forky /app
USER forky
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD wget -qO- http://127.0.0.1:4000/api/v1/health || exit 1
CMD ["node", "dist/main"]
