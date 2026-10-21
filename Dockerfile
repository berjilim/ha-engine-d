ARG BUILD_FROM=node:24-alpine
FROM ${BUILD_FROM}

# Install tini (proper init system for signal forwarding) and tzdata
RUN apk add --no-cache tini tzdata curl

# Set timezone
ENV TZ=Asia/Singapore

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY engine/package.json ./
RUN npm install --production

# Copy engine code
COPY engine/paper_D.js ./
COPY engine/papercore.js ./
COPY engine/src/ ./src/

# Copy entrypoint
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# Create data directory for state persistence
RUN mkdir -p /data /app/logs

# Set environment
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=128"

# Health check
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "const fs=require('fs'); const f='/data/pfD_state.json'; if(!fs.existsSync(f)) process.exit(1); const d=JSON.parse(fs.readFileSync(f,'utf8')); if(!d.updatedAt) process.exit(1); const age=Date.now()-new Date(d.updatedAt).getTime(); if(age>300000) process.exit(1); process.exit(0);"

# Use tini as init system (proper SIGTERM forwarding)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/run.sh"]
