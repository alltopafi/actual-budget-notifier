# ==========================================
# Stage 1: Build stage (installs compilation tools)
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies required for compiling native C++ modules (like better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy package definition and config files
COPY package*.json tsconfig.json ./

# Install all dependencies (which compiles better-sqlite3 successfully)
RUN npm ci

# Copy source files
COPY src/ ./src/

# Compile TypeScript to JavaScript
RUN npm run build

# Prune devDependencies to leave only production packages in node_modules
RUN npm prune --omit=dev

# ==========================================
# Stage 2: Runtime stage
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Copy package definition, compiled files, and pruned node_modules from builder
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create a directory for local state and Actual Budget cache,
# and give ownership to the default non-root "node" user.
RUN mkdir -p /app/data && chown -R node:node /app

# Switch to the non-root user
USER node

# Expose default HTTP hook port
EXPOSE 3000

# Expose local volume directory
VOLUME ["/app/data"]

# Define default execution command
CMD ["node", "dist/index.js"]
