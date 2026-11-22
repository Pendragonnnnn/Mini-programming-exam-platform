# Aegis API. Includes Java 21, Python 3, GCC/G++ and Node.js so the dev-only "local" runner works in a demo.
# In production set RUNNER=judge0 so student code runs in Judge0's sandbox instead.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 gcc g++ libc6-dev ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=eclipse-temurin:21-jdk /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk PATH=/opt/java/openjdk/bin:$PATH NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 4000
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
