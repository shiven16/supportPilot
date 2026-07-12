# Build stage
FROM node:22-slim AS build
ENV NODE_ENV=build
WORKDIR /app

COPY . .

RUN npm ci
RUN npm run build:packages

# Build the application and verify the output
RUN npm run build && ls -la dist/

RUN npm prune --omit=dev

# Production stage
FROM node:22-slim

WORKDIR /app
# Set NODE_ENV to production
ENV NODE_ENV=production

# Copy built application from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/agent-packages ./agent-packages

# Verify the copied files
RUN ls -la dist/

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["node", "dist/src/main.js"]
