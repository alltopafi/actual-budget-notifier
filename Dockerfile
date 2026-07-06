# ==========================================
# Stage 1: Build stage
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package definition and config files
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies for compilation)
RUN npm ci

# Copy source files
COPY src/ ./src/

# Compile TypeScript to JavaScript
RUN npm run build

# ==========================================
# Stage 2: Runtime stage
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Copy package definition
COPY package*.json ./

# Install ONLY production dependencies to keep the image small
RUN npm ci --only=production

# Copy compiled files from the builder stage
COPY --from=builder /app/dist ./dist

# Create a directory for local state and Actual Budget cache,
# and give ownership to the default non-root "node" user.
RUN mkdir -p /app/data && chown -R node:node /app

# Switch to the non-root user
USER node

# Expose local volume directory
VOLUME ["/app/data"]

# Define default execution command
CMD ["node", "dist/index.js"]
