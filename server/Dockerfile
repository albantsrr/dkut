FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 8787

CMD ["sh", "-c", "node src/db/migrate.js && node src/index.js"]
