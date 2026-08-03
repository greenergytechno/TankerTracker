# Build stage — compile TypeScript.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
# No lockfile is committed yet, so `npm install` rather than `npm ci`. Commit a
# package-lock.json and switch to `npm ci` for reproducible builds.
RUN npm install
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Runtime stage — prod deps only, plus psql for the migration runner.
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache postgresql-client
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY db ./db
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
