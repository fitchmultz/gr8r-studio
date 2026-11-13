# Build the client, then ship the sync server with the built app.
# The client fetches its sync token from GET /api/config at runtime, so no
# token is needed at build time: rotating GR8R_TOKEN only restarts the
# container, and a cached build can never ship a stale token.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_SYNC_URL=/api
RUN VITE_SYNC_URL=$VITE_SYNC_URL npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4180 HOST=0.0.0.0
COPY server/ server/
COPY --from=build /app/dist dist/
RUN mkdir -p server/data && chown -R node:node /app
USER node
EXPOSE 4180
CMD ["node", "server/server.js"]
