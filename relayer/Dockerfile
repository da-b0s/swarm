# Swarm relayer. Holds a hot-wallet key: set RELAYER_KEY as a secret in the host's
# dashboard, never in this file, the image, or the repo.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.ts ./
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "--experimental-strip-types", "server.ts"]
