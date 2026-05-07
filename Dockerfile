# Use Playwright's official Docker image — includes Chromium + all system deps
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# Copy dependency manifests first (layer caching)
COPY package.json package-lock.json ./

# Install production deps only
RUN npm ci --omit=dev

# Playwright browsers are pre-installed in the base image, but the
# version must match the npm package. Install just Chromium to be safe.
RUN npx playwright install chromium

# Copy application code
COPY server.js ./
COPY public/ ./public/
COPY answers/ ./answers/

# Create data dir for submissions log
RUN mkdir -p data

# The app reads PORT from env (default 3000)
ENV PORT=3000
EXPOSE 3000

# Run as non-root for security
USER pwuser

CMD ["node", "server.js"]
