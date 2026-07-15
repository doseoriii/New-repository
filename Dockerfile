FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用层缓存，但源码变更会触发后续层全量重建）
COPY package.json ./
RUN npm install --omit=dev

# 复制全部源码（每次 Docker 构建都是全新拉取，不受 Railway Nixpacks 缓存影响）
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
