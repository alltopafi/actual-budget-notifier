import * as api from '@actual-app/api';
import { State, isNotified, addNotified, pruneOldTransactions, saveState } from './state';
import { sendDiscordNotification, TransactionRecord } from './discord';

export interface NotifierConfig {
  actualServerUrl: string;
  actualServerPassword: string;
  actualBudgetSyncId: string;
  actualEncryptionPassword?: string;
  actualDataDir: string;
  discordWebhookUrl: string;
  lookbackDays: number;
  stateFilePath: string;
  triggerBankSync: boolean;
}

/**
 * Checks for new transactions in Actual Budget and sends notifications.
 */
export async function checkNewTransactions(config: NotifierConfig, state: State): Promise<void> {
  console.log('Initializing connection to Actual Server...');
  
  await api.init({
    dataDir: config.actualDataDir,
    serverURL: config.actualServerUrl,
    password: config.actualServerPassword
  });

  try {
    console.log(`Loading budget: ${config.actualBudgetSyncId}...`);
    await api.downloadBudget(config.actualBudgetSyncId, {
      password: config.actualEncryptionPassword
    });

    if (config.triggerBankSync) {
      console.log('Triggering bank synchronization...');
      try {
        await api.runBankSync();
        console.log('Bank sync completed.');
      } catch (bankSyncError) {
        console.error('Error during bank synchronization:', bankSyncError);
        // We continue checking for transactions even if bank sync fails,
        // as there might still be new manually entered or already imported transactions.
      }
    }

    // Fetch reference data to resolve names
    console.log('Fetching accounts, payees, and categories...');
    const [accounts, payees, categories] = await Promise.all([
      api.getAccounts(),
      api.getPayees(),
      api.getCategories()
    ]);

    const accountMap = new Map<string, string>(accounts.map(a => [a.id, a.name]));
    const payeeMap = new Map<string, string>(payees.map(p => [p.id, p.name]));
    const categoryMap = new Map<string, string>(categories.map(c => [c.id, c.name]));

    // Calculate start date based on lookback days
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - config.lookbackDays);
    const startDateStr = lookbackDate.toISOString().split('T')[0];
    
    console.log(`Scanning for transactions since ${startDateStr}...`);

    // Query transactions using ActualQL
    const query = api.q('transactions')
      .filter({
        date: { $gte: startDateStr },
        is_child: false // Only parent or non-split transactions
      })
      .select(['*'])
      .options({ splits: 'grouped' });

    const result = (await api.runQuery(query)) as any;
    const rawTransactions = result.data || [];

    console.log(`Found ${rawTransactions.length} transactions in lookback period.`);

    const newTransactions: TransactionRecord[] = [];

    for (const tx of rawTransactions) {
      if (isNotified(state, tx.id)) {
        continue;
      }

      // Map to TransactionRecord, resolving UUIDs to human-readable names
      const record: TransactionRecord = {
        id: tx.id,
        date: tx.date,
        amount: tx.amount,
        'payee.name': tx.payee ? payeeMap.get(tx.payee) : null,
        'category.name': tx.category ? categoryMap.get(tx.category) : null,
        'account.name': tx.account ? accountMap.get(tx.account) : null,
        notes: tx.notes,
        transfer_id: tx.transfer_id,
        is_parent: tx.is_parent
      };

      // Resolve subtransactions for split transactions
      if (tx.is_parent && Array.isArray(tx.subtransactions)) {
        record.subtransactions = tx.subtransactions.map((sub: any) => ({
          amount: sub.amount,
          'category.name': sub.category ? categoryMap.get(sub.category) : null,
          notes: sub.notes
        }));
      }

      newTransactions.push(record);
    }

    if (newTransactions.length > 0) {
      console.log(`Detected ${newTransactions.length} new transaction(s).`);
      
      // Sort chronologically (oldest first) so they display in order in Discord
      newTransactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Send to Discord
      await sendDiscordNotification(config.discordWebhookUrl, newTransactions);

      // Record as notified in the state
      for (const tx of newTransactions) {
        addNotified(state, tx.id, tx.date);
      }

      // Update state file
      state.lastCheckedAt = new Date().toISOString();
      saveState(config.stateFilePath, state);
      console.log('State saved with new notified transactions.');
    } else {
      console.log('No new transactions detected.');
      // Still update the last checked timestamp
      state.lastCheckedAt = new Date().toISOString();
      saveState(config.stateFilePath, state);
    }

    // Prune old transaction IDs from state to prevent unbounded growth.
    // We keep entries for 30 days to ensure that backdated imports don't trigger duplicates.
    const pruneThreshold = new Date();
    pruneThreshold.setDate(pruneThreshold.getDate() - 30);
    const pruneThresholdStr = pruneThreshold.toISOString().split('T')[0];
    
    const prunedCount = pruneOldTransactions(state, pruneThresholdStr);
    if (prunedCount > 0) {
      console.log(`Pruned ${prunedCount} transaction IDs older than 30 days (${pruneThresholdStr}) from state.`);
      saveState(config.stateFilePath, state);
    }

  } finally {
    console.log('Shutting down connection to Actual Server...');
    await api.shutdown();
  }
}
