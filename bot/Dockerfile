FROM node:20-slim

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
# We use --omit=dev to keep it light
RUN npm install --omit=dev

# Copy the rest of the app source
COPY . .

# Expose port (not strictly needed for a bot, but good practice)
EXPOSE 3000

# Start the bot
CMD [ "node", "bot.js" ]
