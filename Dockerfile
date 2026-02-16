FROM node:20-slim

# Create app directory
WORKDIR /app

# Copy package files from current directory
COPY package.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy the rest of the source
COPY . .

# Expose port
EXPOSE 3000

# Start the bot
CMD [ "node", "bot.js" ]
