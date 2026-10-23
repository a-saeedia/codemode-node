FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY README.md LICENSE ./

# stdio MCP server: starts, pools whatever MCP config it finds, waits on stdin
ENTRYPOINT ["node", "src/server.mjs"]
