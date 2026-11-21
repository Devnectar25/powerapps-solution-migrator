# PowerApps Solution Migrator: hosted server image (one continuously running Node.js process).
# Run exactly one instance: Microsoft sign-ins and running migrations are kept in memory.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOSTED=true \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY supabase ./supabase

# Profiles, history and solution packages. Mount a persistent volume here.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
