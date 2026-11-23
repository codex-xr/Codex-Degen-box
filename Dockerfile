FROM node:24-slim

WORKDIR /app

# Install dependencies first for layer caching
COPY package*.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies after build to keep container light
RUN npm prune --omit=dev

RUN mkdir -p /data

ENV NODE_ENV=production
ENV DATA_DIR=/data

CMD ["node", "dist/index.js"]
