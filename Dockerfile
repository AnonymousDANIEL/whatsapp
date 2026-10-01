FROM node:22-bookworm-slim
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true SERVICE_ROLE=api
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
EXPOSE 3000
CMD ["node", "src/main.js"]
