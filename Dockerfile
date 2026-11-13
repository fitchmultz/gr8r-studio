# Build the client, then ship the sync server with the built app.
# The client token is baked into the bundle at build time (single-user app) and
# is delivered through a BuildKit secret mount so it never lands in image
# history. GR8R_TOKEN stays a runtime secret for the API.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_SYNC_URL=/api
RUN --mount=type=secret,id=vite_token,required=true \
    VITE_SYNC_URL=$VITE_SYNC_URL VITE_SYNC_TOKEN="$(cat /run/secrets/vite_token)" npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4180 HOST=0.0.0.0
COPY server/ server/
COPY --from=build /app/dist dist/
RUN mkdir -p server/data && chown -R node:node /app
USER node
EXPOSE 4180
CMD ["node", "server/server.js"]
