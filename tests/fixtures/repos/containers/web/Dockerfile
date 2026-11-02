FROM node:20-alpine AS build
WORKDIR /src
EXPOSE 9999
COPY . .
RUN npm ci && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
