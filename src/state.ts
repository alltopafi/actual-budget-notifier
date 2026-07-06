import * as fs from 'fs';
import * as path from 'path';

export interface State {
  notifiedTransactions: Record<string, string>; // transactionId -> YYYY-MM-DD
  lastCheckedAt?: string;
}

/**
 * Loads the state file from the filesystem.
 * If the file does not exist, it returns a default empty state.
 */
export function loadState(filePath: string): State {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        return {
          notifiedTransactions: parsed.notifiedTransactions || {},
          lastCheckedAt: parsed.lastCheckedAt,
        };
      }
    }
  } catch (error) {
    console.error(`Failed to load state from ${filePath}:`, error);
  }

  return {
    notifiedTransactions: {},
  };
}

/**
 * Saves the state file to the filesystem atomically using a temp file.
 */
export function saveState(filePath: string, state: State): void {
  try {
    // Ensure parent directories exist
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    console.error(`Failed to save state to ${filePath}:`, error);
  }
}

/**
 * Checks if a transaction has already been notified.
 */
export function isNotified(state: State, id: string): boolean {
  return !!state.notifiedTransactions[id];
}

/**
 * Marks a transaction as notified.
 */
export function addNotified(state: State, id: string, date: string): void {
  state.notifiedTransactions[id] = date;
}

/**
 * Prunes transactions from the notified list that are older than the threshold date.
 * @param state The state object to modify
 * @param thresholdDateISO The threshold date string in YYYY-MM-DD format
 * @returns The number of pruned transactions
 */
export function pruneOldTransactions(state: State, thresholdDateISO: string): number {
  let prunedCount = 0;
  const threshold = new Date(thresholdDateISO);

  if (isNaN(threshold.getTime())) {
    console.warn(`Invalid threshold date for pruning: ${thresholdDateISO}`);
    return 0;
  }

  for (const [id, dateStr] of Object.entries(state.notifiedTransactions)) {
    const txDate = new Date(dateStr);
    if (!isNaN(txDate.getTime()) && txDate < threshold) {
      delete state.notifiedTransactions[id];
      prunedCount++;
    }
  }

  return prunedCount;
}
