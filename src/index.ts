import * as dotenv from 'dotenv';
import * as path from 'path';
import * as http from 'http';
import { loadState } from './state';
import { checkNewTransactions, NotifierConfig } from './notifier';

// Override console methods to automatically prefix logs with an ISO timestamp
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

const getTimestamp = () => `[${new Date().toISOString()}]`;

console.log = (...args) => originalLog(getTimestamp(), ...args);
console.error = (...args) => originalError(getTimestamp(), ...args);
console.warn = (...args) => originalWarn(getTimestamp(), ...args);
console.info = (...args) => originalInfo(getTimestamp(), ...args);

// Load environment variables from .env file
dotenv.config();

/**
 * Starts a lightweight HTTP server to listen for push hook triggers.
 */
function startHttpServer(port: number, triggerScan: () => Promise<void>) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/scan') {
      console.log('Received HTTP trigger on POST /scan. Launching database check...');
      
      // Run the scan asynchronously so we can return a response immediately
      triggerScan().catch(err => {
        console.error('HTTP-triggered scan failed:', err);
      });

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'Scan triggered' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found. Exposes POST /scan' }));
    }
  });

  server.listen(port, () => {
    console.log(`HTTP hook listener running on port ${port}. Exposes POST /scan`);
  });
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: Missing required environment variable ${name}`);
    process.exit(1);
  }
  return value.trim();
}

function getOptionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value ? value.trim() : defaultValue;
}

async function main() {
  console.log('Starting Actual Budget Notifier Service...');

  // Validate and read configuration
  const actualServerUrl = getRequiredEnv('ACTUAL_SERVER_URL');
  const actualServerPassword = getRequiredEnv('ACTUAL_SERVER_PASSWORD');
  const actualBudgetSyncId = getRequiredEnv('ACTUAL_BUDGET_SYNC_ID');
  const discordWebhookUrl = getRequiredEnv('DISCORD_WEBHOOK_URL');

  const actualEncryptionPassword = process.env.ACTUAL_ENCRYPTION_PASSWORD || undefined;
  
  const scanIntervalMinutesStr = getOptionalEnv('SCAN_INTERVAL_MINUTES', '5');
  const scanIntervalMinutes = parseInt(scanIntervalMinutesStr, 10);
  if (isNaN(scanIntervalMinutes) || scanIntervalMinutes <= 0) {
    console.error(`Invalid SCAN_INTERVAL_MINUTES: ${scanIntervalMinutesStr}. Must be a positive integer.`);
    process.exit(1);
  }

  const lookbackDaysStr = getOptionalEnv('LOOKBACK_DAYS', '7');
  const lookbackDays = parseInt(lookbackDaysStr, 10);
  if (isNaN(lookbackDays) || lookbackDays <= 0) {
    console.error(`Invalid LOOKBACK_DAYS: ${lookbackDaysStr}. Must be a positive integer.`);
    process.exit(1);
  }

  const actualDataDir = getOptionalEnv('ACTUAL_DATA_DIR', 'data/actual-data');
  const stateFilePath = getOptionalEnv('STATE_FILE_PATH', 'data/state.json');
  const triggerBankSync = getOptionalEnv('TRIGGER_BANK_SYNC', 'false').toLowerCase() === 'true';

  const config: NotifierConfig = {
    actualServerUrl,
    actualServerPassword,
    actualBudgetSyncId,
    actualEncryptionPassword,
    actualDataDir: path.resolve(actualDataDir),
    discordWebhookUrl,
    lookbackDays,
    stateFilePath: path.resolve(stateFilePath),
    triggerBankSync
  };

  console.log('--- Configuration ---');
  console.log(`Server URL:         ${config.actualServerUrl}`);
  console.log(`Sync ID:            ${config.actualBudgetSyncId}`);
  console.log(`Encryption Enabled: ${config.actualEncryptionPassword ? 'Yes' : 'No'}`);
  console.log(`Lookback Days:      ${config.lookbackDays}`);
  console.log(`Interval:           ${scanIntervalMinutes} minute(s)`);
  console.log(`Trigger Bank Sync:  ${config.triggerBankSync}`);
  console.log(`Data Directory:     ${config.actualDataDir}`);
  console.log(`State File Path:    ${config.stateFilePath}`);
  console.log('---------------------');

  // Load state
  console.log(`Loading state from ${config.stateFilePath}...`);
  const state = loadState(config.stateFilePath);
  console.log(`State loaded. Currently tracking ${Object.keys(state.notifiedTransactions).length} transaction(s).`);

  // Validate port configuration
  const portStr = getOptionalEnv('PORT', '3000');
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port <= 0) {
    console.error(`Invalid PORT: ${portStr}. Must be a positive integer.`);
    process.exit(1);
  }

  // Scanner lock to prevent concurrent database opens (which locks sqlite)
  let isScanning = false;
  const triggerScan = async () => {
    if (isScanning) {
      console.log('Scan already in progress. Skipping concurrent trigger.');
      return;
    }
    isScanning = true;
    try {
      await checkNewTransactions(config, state);
    } catch (error) {
      console.error('Scan execution failed:', error);
    } finally {
      isScanning = false;
    }
  };

  // Start the HTTP hook server
  startHttpServer(port, triggerScan);

  // Recursive timeout loop to check for transactions as a backup.
  const runLoop = async () => {
    console.log('\n--- Starting Scheduled Scan ---');
    await triggerScan();
    console.log(`--- Scheduled Scan Completed. Waiting ${scanIntervalMinutes} minute(s) ---`);
    setTimeout(runLoop, scanIntervalMinutes * 60 * 1000);
  };

  // Run the first scan immediately
  runLoop();
}

// Handle termination signals gracefully
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down notifier service...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down notifier service...');
  process.exit(0);
});

main().catch(error => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
