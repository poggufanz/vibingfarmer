# keeper/Dockerfile — lifeboat radar daemon (ledger-speed loop). The 15-min autofarm keeper
# stays a Cloudflare Worker cron; this image runs ONLY the radar (src/radar-runner.mjs).
# node:24-slim for the same @stellar/stellar-sdk native-crypto reason as the relayer image.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
CMD ["node", "src/radar-runner.mjs"]
