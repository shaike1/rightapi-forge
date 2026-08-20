FROM node:22-alpine

# Install system dependencies for IT operations
RUN apk add --no-cache     docker-cli     docker-cli-compose     git     openssl     openssh-client     curl     bash     coreutils     procps     util-linux     iptables     iproute2     net-tools     tzdata     wget     jq     chromium     nss     freetype     harfbuzz     ttf-freefont     && rm -rf /var/cache/apk/*

WORKDIR /app

# Install server dependencies
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

# Copy static public assets first (before client build so fresh build overwrites stale app/)
COPY public ./public

# Build React client (outputs to public/app/)
COPY client/package*.json ./client/
RUN cd client && npm ci
COPY client ./client
RUN cd client && npm run build

# Build server
COPY src ./src
COPY bin ./bin
COPY build.mjs ./build.mjs
RUN npm run build
RUN npm prune --production

RUN mkdir -p /data/itops-agents/logs

ENV NODE_ENV=production
ENV PORT=19123
ENV HOST=0.0.0.0

EXPOSE 19123

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3   CMD wget --spider -q http://localhost:19123/api/health || exit 1

COPY init-agents.sh /usr/local/bin/init-agents.sh
RUN chmod +x /usr/local/bin/init-agents.sh
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh
CMD ["/usr/local/bin/start.sh"]
