FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PORT=10000 CACHE_DIR=/tmp/weltenbummler-panos
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js zugang.js olymp.js index.html spiel.js karte.js spiel.css icon.svg datenschutz.html ./
COPY vendor ./vendor
COPY daten ./daten
COPY panos ./panos
EXPOSE 10000
CMD ["node", "server.js"]
