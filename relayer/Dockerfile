# relayer/Dockerfile — standalone /api/vf-cross relayer server.
# node:24-slim (Debian/glibc, not alpine): node:sqlite is built in on Node 24, and
# @stellar/stellar-sdk's native crypto (sodium) ships glibc prebuilds but has musl gaps —
# slim avoids a native-build failure in `npm ci`. Self-contained: the relayer reads all
# deployment facts are copied from the repository root because config.mjs treats them as
# immutable execution authority and imports them at runtime.
FROM node:24-slim
WORKDIR /app/relayer
COPY --chown=node:node relayer/package.json relayer/package-lock.json ./
RUN npm ci --omit=dev && chown -R node:node /app/relayer
COPY --chown=node:node relayer/src ./src
COPY --chown=node:node relayer/server-runner.mjs ./server-runner.mjs
COPY --chown=node:node deployments/stellar-testnet.json /app/deployments/stellar-testnet.json
COPY --chown=node:node deployments/base-sepolia.json /app/deployments/base-sepolia.json
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8788
CMD ["node", "server-runner.mjs"]
