FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
# The commit this image was built from; shown in the dashboard and compared
# with the repository to tell when an update is available.
ARG GIT_SHA=""
ENV GATEWAY_VERSION=$GIT_SHA
# Uploaded audio; a volume mounted here keeps this ownership.
RUN mkdir -p /files && chown node:node /files
USER node
EXPOSE 8000
CMD ["node", "server.js"]
