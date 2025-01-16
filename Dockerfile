# 1) Base image
FROM node:18-slim

# 2) Create app directory
WORKDIR /app

# 3) Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# 4) Copy the rest of the code
COPY . .

# 5) Start the bot
# No port needs to be exposed if we're only running a Discord bot
CMD ["node", "index.js"]
