# ---- Build both client and server ----
FROM node:20-alpine AS base
WORKDIR /app

# deps
COPY client/package*.json ./client/
COPY server/package*.json ./server/
RUN npm --prefix server ci || npm --prefix server install
RUN npm --prefix client ci  || npm --prefix client install

# source
COPY client ./client
COPY server ./server

# build client -> /client/dist
RUN npm --prefix client run build

# ---- Runtime ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# install server deps only (prod)
COPY --from=base /app/server/package*.json ./server/
RUN npm --prefix server ci --omit=dev || npm --prefix server install --omit=dev

COPY --from=base /app/server ./server
COPY --from=base /app/client/dist ./client/dist

EXPOSE 8080
CMD ["node", "server/server.js"]
