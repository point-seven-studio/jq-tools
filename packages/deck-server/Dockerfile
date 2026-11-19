# JQ Deck Server as a container. Build from the repository root:
#
#   docker build -f packages/deck-server/Dockerfile -t jq-deck-server .
#   docker run -p 4320:4320 -v jq-deck-data:/data jq-deck-server
#
# The data folder is /data: mount a volume there, or every restart forgets who
# may report and who may look. The folder is made on first start.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci && npm run build --workspace=@point-seven-studio/jq-deck-server

FROM node:22-alpine
COPY --from=build /src/packages/deck-server/dist/jq-deck-server.mjs /app/jq-deck-server.mjs
RUN ln -s /app/jq-deck-server.mjs /usr/local/bin/jq-deck-server
ENV JQ_DECK_SERVER_DIR=/data
EXPOSE 4320
# 0.0.0.0 because a container's own 127.0.0.1 is not reachable from outside it.
# Put HTTPS in front: the sign-in cookie is marked Secure.
CMD ["sh", "-c", "[ -f /data/config.json ] || jq-deck-server init /data; exec jq-deck-server serve --host 0.0.0.0 --port ${PORT:-4320}"]
