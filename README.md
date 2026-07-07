# Actual Budget Transaction Notifier

A lightweight, containerized daemon written in TypeScript that scans your [Actual Budget](https://actualbudget.org/) for new transactions and sends them as beautifully formatted embeds to a Discord webhook.

Built with native TypeScript, it uses the official `@actual-app/api` Node.js client and is optimized for hosting on a Kubernetes cluster (like k3s) or as a standalone Docker container.

## Features

- 💸 **Beautiful Discord Embeds**: Transaction types are color-coded (Green for Income, Red/Orange for Expenses, Blue for Transfers).
- 🔄 **Split Transaction Support**: Displays parent transactions along with a detailed list of their subtransaction splits and categories.
- 🗃️ **State Persistence**: Uses a local state file (`data/state.json`) to track already notified transactions, preventing double-notifications on container restarts.
- 🧹 **Automatic Historical Cleanup**: Prunes transaction IDs older than 30 days from the state file to prevent unbounded file growth.
- 📦 **Discord Webhook Batching**: Batches up to 10 transaction embeds per Discord webhook request to respect rate limits.
- 🏦 **Optional Bank Sync**: Can trigger bank synchronization (`runBankSync`) on each scan to fetch transactions automatically.
- 🛡️ **Security-First Docker Image**: Builds using a multi-stage process and runs as a non-root `node` user.

---

## Configuration & Environment Variables

Create a `.env` file in the root directory (see `.env.example`). The service expects the following variables:

### 🔒 Sensitive Configurations (Treat as Secrets)
- `ACTUAL_SERVER_URL`: The URL of your Actual Budget sync server (e.g. `https://budget.yourdomain.com`).
- `ACTUAL_SERVER_PASSWORD`: Your login password for the Actual server.
- `ACTUAL_BUDGET_SYNC_ID`: The Sync ID of the specific budget you want to monitor (found in Actual under **Settings → Show advanced settings → Sync ID**).
- `ACTUAL_ENCRYPTION_PASSWORD`: *(Optional)* The end-to-end encryption passphrase for your budget. Required if E2EE is enabled.
- `DISCORD_WEBHOOK_URL`: The webhook URL for the Discord channel where you want notifications sent.

### ⚙️ Optional Notifier Settings
- `SCAN_INTERVAL_MINUTES`: How often the daemon scans for new transactions. Defaults to `5` minutes.
- `LOOKBACK_DAYS`: How far back in time to scan for transactions on each run. Defaults to `7` days.
- `TRIGGER_BANK_SYNC`: Set to `true` to trigger Actual's bank sync before scanning. Defaults to `false`.
- `ACTUAL_DATA_DIR`: Directory where Actual Budget will store its sqlite cache. Defaults to `data/actual-data`.
- `STATE_FILE_PATH`: Path to the JSON state file. Defaults to `data/state.json`.

---

## Deployment in Kubernetes (k3s)

When deploying this service in a Kubernetes cluster, note the following guidelines:

1. **Volume Mount**: The container writes state and caches the budget database in `/app/data`. You should mount a persistent volume (using a `PersistentVolumeClaim`) to `/app/data` to ensure notifications are not duplicated if the Pod restarts.
2. **Secrets**: Inject the sensitive credentials (`ACTUAL_SERVER_URL`, `ACTUAL_SERVER_PASSWORD`, `ACTUAL_BUDGET_SYNC_ID`, `ACTUAL_ENCRYPTION_PASSWORD`, and `DISCORD_WEBHOOK_URL`) using Kubernetes Secrets.
3. **Security Context**: The Docker container runs as user ID `1000` (the default `node` user in Alpine Node images). Ensure your PersistentVolume is writable by this user ID.

---

## HTTP Trigger Hook

To allow instant notifications when new transactions are added from other scripts or input forms (such as your `actual-budget-input` project), the service runs a lightweight HTTP server on port `3000` (configurable via the `PORT` environment variable).

Exposed Endpoint:
- **Method**: `POST`
- **Path**: `/scan`

You can trigger a scan immediately by making a `POST` request to the service:

```bash
curl -X POST http://localhost:3000/scan
```

### Safety & Concurrency
To prevent database lock conflicts on Actual Budget's SQLite cache, the service implements an internal concurrency lock. If a scan is already running (e.g., triggered by the scheduled interval or a previous HTTP request), concurrent triggers will be safely skipped.

---

## Development & Local Testing

### Prerequisites
To test this locally, you must have Node.js (v18+) and npm installed.

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   Copy `.env.example` to `.env` and fill in your connection details:
   ```bash
   cp .env.example .env
   ```

3. **Run in Development Mode**:
   Starts the app in watch mode using `nodemon` and `ts-node`:
   ```bash
   npm run dev
   ```

4. **Build and Run Production Build**:
   ```bash
   npm run build
   npm start
   ```

### Docker Build

You can build the production-ready Docker image with:
```bash
docker build -t actual-budget-notifier:latest .
```
