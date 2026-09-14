# Crew AI in a container, so trying it does not mean trusting it with your machine.
#
#   docker run -d --name crew -p 127.0.0.1:8800:8800 -v crew-data:/data harsh132/crew-ai
#
# Published for amd64 and arm64, together with npm, by `bun run release patch`
# (see release.mjs).
#
# The runtime and the agents' tools see only this image and the /data volume.
# Published on the host's loopback only: the runtime holds the crew's key.
FROM node:22-slim

WORKDIR /app
COPY package.json README.md ./
COPY bin ./bin
COPY server ./server
COPY dist ./dist

# Owned by the unprivileged user before it becomes a volume, so a new named
# volume starts out writable by it.
RUN mkdir /data && chown node:node /data

ENV CREW_HOST=0.0.0.0 \
    CREW_PORT=8800 \
    CREW_HOME=/data \
    NODE_ENV=production

USER node
VOLUME /data
EXPOSE 8800
CMD ["node", "bin/crew.mjs"]
