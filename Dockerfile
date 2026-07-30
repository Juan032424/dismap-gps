# ---- Etapa de build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Etapa de ejecución ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./
# 3000 = web/API · 5013 = TCP para los GPS (ST-901 / H02)
EXPOSE 3000 5013
CMD ["node", "dist/main.js"]
