FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src/ ./src/

# Run tests during build (uses node:test built-in runner, no dev deps needed)
RUN npm test

# UI dist is copied in by CI before docker build
COPY ui-dist/ ./ui-dist/

EXPOSE 3000

CMD ["node", "src/index.js"]
