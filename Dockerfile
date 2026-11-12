# Build the static site, then serve it with nginx (all paths fall back to index.html).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Slim image: no image-filter / XSLT modules, so no libxml2, libxslt, libpng, tiff or libxpm.
# Runs as a non-root user (the platform doesn't give containers root).
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24-slim
# pick up every Alpine security fix released since the base image was built
USER root
RUN apk upgrade --no-cache
USER 101
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/client /usr/share/nginx/html
EXPOSE 8080
