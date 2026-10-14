# FORKY web (Admin Console, Restaurant Portal, customer website) - static build served by nginx.
# The REACT_APP_* values are baked into the build: pass them as build args (see docker-compose.yml / deploy/.env.example).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG REACT_APP_API_URL
ARG REACT_APP_WS_URL
ARG REACT_APP_CSP_CONNECT
ARG REACT_APP_CSP_IMG
ARG REACT_APP_CSP_SCRIPT
ARG REACT_APP_CSP_FRAME
ENV REACT_APP_API_URL=$REACT_APP_API_URL \
    REACT_APP_WS_URL=$REACT_APP_WS_URL \
    REACT_APP_CSP_CONNECT=$REACT_APP_CSP_CONNECT \
    REACT_APP_CSP_IMG=$REACT_APP_CSP_IMG \
    REACT_APP_CSP_SCRIPT=$REACT_APP_CSP_SCRIPT \
    REACT_APP_CSP_FRAME=$REACT_APP_CSP_FRAME \
    DISABLE_ESLINT_PLUGIN=true \
    GENERATE_SOURCEMAP=false \
    INLINE_RUNTIME_CHUNK=false
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
