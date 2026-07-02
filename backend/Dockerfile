FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV PORT=8000
EXPOSE 8000

# Run as the unprivileged `node` user (present in the official image) rather
# than root.
USER node

CMD ["npm", "start"]
