import * as dotenv from 'dotenv';
import * as path from 'path';
import { loadState } from './state';
import { checkNewTransactions, NotifierConfig } from './notifier';

// Load environment variables from .env file
dotenv.config();

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

  // Recursive timeout loop to check for transactions.
  // This avoids parallel executions if a sync takes longer than the interval.
  const runLoop = async () => {
    console.log(`\n--- Starting Scan at ${new Date().toISOString()} ---`);
    try {
      await checkNewTransactions(config, state);
    } catch (error) {
      console.error('Unhandled error during scan execution:', error);
    }
    console.log(`--- Scan Completed. Waiting ${scanIntervalMinutes} minute(s) ---`);
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
