FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
USER node
EXPOSE 8000
CMD ["node", "server.js"]
