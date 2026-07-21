FROM node:22-alpine AS build

WORKDIR /app

# package-lock.json was generated on Windows, so it never recorded a Linux
# entry for Rollup's platform-specific optional binary - npm's own bug
# (npm/cli#4828), and `npm ci`/`npm install` against that lockfile both
# reproduce it. Installing from package.json alone forces a fresh resolution
# that correctly picks the linux-musl binary for this image.
COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
