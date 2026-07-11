# relayer/Dockerfile — standalone /api/vf-cross relayer server.
# node:24-slim (Debian/glibc, not alpine): node:sqlite is built in on Node 24, and
# @stellar/stellar-sdk's native crypto (sodium) ships glibc prebuilds but has musl gaps —
# slim avoids a native-build failure in `npm ci`. Self-contained: the relayer reads all
# addresses from env (see config.mjs), so no deployments/ file is copied.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY server-runner.mjs ./server-runner.mjs
EXPOSE 8788
CMD ["node", "server-runner.mjs"]
