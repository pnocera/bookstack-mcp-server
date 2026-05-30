FROM node:20-alpine AS builder
WORKDIR /build
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /build/dist ./dist/
COPY src/http-server.js src/package.json ./src/
EXPOSE 3100
CMD ["node", "src/http-server.js"]
