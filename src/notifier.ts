import * as api from '@actual-app/api';
import { State, isNotified, addNotified, pruneOldTransactions, saveState } from './state';
import { sendDiscordNotification, TransactionRecord, sendDiscordReport } from './discord';

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
  dailyReportCron: string;
  dailyReportTz: string;
  dailyReportStyle: string;
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
        category: tx.category,
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
          category: sub.category,
          'category.name': sub.category ? categoryMap.get(sub.category) : null,
          notes: sub.notes
        }));
      }

      newTransactions.push(record);
    }

    if (newTransactions.length > 0) {
      console.log(`Detected ${newTransactions.length} new transaction(s).`);

      // 1. Gather all unique months to fetch budgets for
      const monthsSet = new Set<string>();
      for (const tx of newTransactions) {
        if (tx.date) {
          monthsSet.add(tx.date.substring(0, 7));
        }
      }

      // 2. Fetch budget details for each represented month
      const monthBudgets = new Map<string, any>();
      for (const month of monthsSet) {
        console.log(`Fetching budget details for month: ${month}`);
        try {
          const budget = await api.getBudgetMonth(month);
          monthBudgets.set(month, budget);
        } catch (err) {
          console.error(`Failed to fetch budget for month ${month}:`, err);
        }
      }

      // Helper to retrieve category from loaded budgets
      const getCategoryFromBudget = (month: string, categoryId: string) => {
        const budget = monthBudgets.get(month);
        if (!budget || !budget.categoryGroups) return null;
        for (const group of budget.categoryGroups) {
          if (group.categories) {
            const cat = group.categories.find((c: any) => c.id === categoryId);
            if (cat) return cat;
          }
        }
        return null;
      };

      // Helper to format amount
      const formatAmountLocal = (amount: number) => {
        const dollarVal = Math.abs(amount / 100).toFixed(2);
        const sign = amount < 0 ? '-' : amount > 0 ? '+' : '';
        return `${sign}$${dollarVal}`;
      };

      // 3. Populate budget details for each transaction
      for (const tx of newTransactions) {
        const txMonth = tx.date.substring(0, 7);

        if (!tx.is_parent) {
          // Regular transaction
          if (tx.category) {
            const catBudget = getCategoryFromBudget(txMonth, tx.category);
            if (catBudget && !catBudget.is_income) {
              const budgetedVal = catBudget.budgeted || 0;
              const spentVal = catBudget.spent || 0;
              const balanceVal = catBudget.balance || 0;

              const budgetedStr = formatAmountLocal(budgetedVal);
              const spentStr = formatAmountLocal(spentVal);

              if (balanceVal < 0) {
                const overspentStr = formatAmountLocal(Math.abs(balanceVal));
                tx.categoryBudgetInfo = `⚠️ Over budget by **${overspentStr}** (Budgeted: ${budgetedStr}, Spent: ${spentStr})`;
              } else {
                const balanceStr = formatAmountLocal(balanceVal);
                tx.categoryBudgetInfo = `✅ Within budget with **${balanceStr}** remaining (Budgeted: ${budgetedStr}, Spent: ${spentStr})`;
              }
            }
          }
        } else if (tx.is_parent && Array.isArray(tx.subtransactions)) {
          // Split transaction
          for (const sub of tx.subtransactions) {
            if (sub.category) {
              const catBudget = getCategoryFromBudget(txMonth, sub.category);
              if (catBudget && !catBudget.is_income) {
                const balanceVal = catBudget.balance || 0;
                if (balanceVal < 0) {
                  const overspentStr = formatAmountLocal(Math.abs(balanceVal));
                  sub.categoryBudgetInfo = `⚠️ Over by ${overspentStr}`;
                } else {
                  const balanceStr = formatAmountLocal(balanceVal);
                  sub.categoryBudgetInfo = `${balanceStr} left`;
                }
              }
            }
          }
        }
      }
      
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

/**
 * Generates and sends a daily category budget report to Discord.
 */
export async function sendDailyReport(config: NotifierConfig): Promise<void> {
  console.log('Daily Report: Initializing connection to Actual Server...');
  await api.init({
    dataDir: config.actualDataDir,
    serverURL: config.actualServerUrl,
    password: config.actualServerPassword
  });

  try {
    console.log(`Daily Report: Loading budget ${config.actualBudgetSyncId}...`);
    await api.downloadBudget(config.actualBudgetSyncId, {
      password: config.actualEncryptionPassword
    });

    // 1. Get current month in the configured timezone (America/Chicago by default)
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: config.dailyReportTz,
      year: 'numeric',
      month: '2-digit'
    });
    const parts = formatter.formatToParts(new Date());
    const yearPart = parts.find(p => p.type === 'year')?.value;
    const monthPart = parts.find(p => p.type === 'month')?.value;
    const currentMonth = `${yearPart}-${monthPart}`;

    console.log(`Daily Report: Fetching budget status for ${currentMonth}...`);
    const budget = await api.getBudgetMonth(currentMonth);

    // Helper to format amount (no "+" sign on positive numbers, only "-" for negative)
    const formatAmountReport = (amount: number) => {
      const dollarVal = Math.abs(amount / 100).toFixed(2);
      const sign = amount < 0 ? '-' : '';
      return `${sign}$${dollarVal}`;
    };

    // Helper to render emoji-based progress bar
    const renderProgressBarLocal = (spent: number, budgeted: number, statusEmoji: string): string => {
      const budgetedVal = Math.max(0, budgeted);
      const spentVal = Math.abs(spent);
      
      let percent = 0;
      if (budgetedVal > 0) {
        percent = Math.round((spentVal / budgetedVal) * 100);
      } else if (spentVal > 0) {
        percent = 100;
      }
      
      let fillEmoji = '🟩'; // default green
      if (statusEmoji === '🔴') {
        fillEmoji = '🟥'; // red
      } else if (statusEmoji === '🔵') {
        fillEmoji = '🟦'; // blue
      } else if (statusEmoji === '⚪') {
        fillEmoji = '⬛'; // unused
      }
      
      const emptyEmoji = '⬛';
      const totalBlocks = 10;
      
      const visualPercent = Math.max(0, Math.min(100, percent));
      const filledBlocks = Math.round((visualPercent / 100) * totalBlocks);
      const emptyBlocks = totalBlocks - filledBlocks;
      
      const barString = fillEmoji.repeat(filledBlocks) + emptyEmoji.repeat(emptyBlocks);
      return `${barString} **${percent}%**`;
    };

    const budgetedTotal = budget.totalBudgeted || 0;
    const spentTotal = budget.totalSpent || 0;
    const balanceTotal = budget.totalBalance || 0;

    const totalBudgetedStr = formatAmountReport(budgetedTotal);
    const totalSpentStr = formatAmountReport(spentTotal);
    const totalBalanceStr = formatAmountReport(balanceTotal);
    const totalStatusIndicator = balanceTotal < 0 ? '🔴 Over budget' : '🟢 Within budget';

    const [year, month] = currentMonth.split('-');
    const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
    const monthName = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const title = `📊 Daily Budget Report — ${monthName}`;
    const color = balanceTotal < 0 ? 15143740 : 3066993;

    const embeds: any[] = [];
    let currentDescription = '';

    // 2. Loop through category groups and categories to build report description
    if (budget.categoryGroups) {
      for (const group of budget.categoryGroups) {
        if (group.is_income || group.hidden) {
          continue;
        }

        let groupBudgeted = 0;
        let groupSpent = 0;
        const catLines: string[] = [];

        if (Array.isArray(group.categories)) {
          for (const cat of group.categories as any[]) {
            if (cat.hidden || cat.is_income) {
              continue;
            }

            const budgetedVal = cat.budgeted || 0;
            const spentVal = cat.spent || 0;
            const balanceVal = cat.balance || 0;

            groupBudgeted += budgetedVal;
            groupSpent += spentVal;

            const budgetedStr = formatAmountReport(budgetedVal);
            const spentStr = formatAmountReport(spentVal);
            const balanceStr = formatAmountReport(balanceVal);

            const isProgressStyle = config.dailyReportStyle.toLowerCase() === 'progress';

            let statusEmoji = '🟢';
            if (balanceVal < 0) {
              statusEmoji = '🔴';
            } else if (balanceVal === 0 && budgetedVal > 0) {
              statusEmoji = '🔵';
            } else if (spentVal === 0 && budgetedVal === 0) {
              statusEmoji = '⚪';
            }

            if (isProgressStyle) {
              const catBlock: string[] = [];
              catBlock.push(`\u2003\u2003${statusEmoji} **${cat.name}**`);
              catBlock.push(`\u2003\u2003${renderProgressBarLocal(spentVal, budgetedVal, statusEmoji)}`);
              
              if (spentVal !== 0 || budgetedVal !== 0) {
                catBlock.push(`\u2003\u2003Spent: ${spentStr} | Budgeted: ${budgetedStr}`);
                catBlock.push(`\u2003\u2003**Remaining: ${balanceStr}**`);
              }
              
              catLines.push(catBlock.join('\n'));
            } else {
              catLines.push(`\u2003\u2003${statusEmoji} **${cat.name}**: Spent ${spentStr} / Budgeted ${budgetedStr} (Balance: ${balanceStr})`);
            }
          }
        }

        if (catLines.length > 0) {
          const groupSpentStr = formatAmountReport(groupSpent);
          const groupBudgetedStr = formatAmountReport(groupBudgeted);
          const isProgressStyle = config.dailyReportStyle.toLowerCase() === 'progress';

          // Header formatted as: "### 📁 Group Name — Spent -$X.XX / Budgeted $Y.YY"
          let groupText = `### 📁 ${group.name} — Spent ${groupSpentStr} / Budgeted ${groupBudgetedStr}\n`;
          const joinSeparator = isProgressStyle ? '\n\n' : '\n';
          groupText += catLines.join(joinSeparator) + '\n\n';

          // Paginate into a new embed if it exceeds safe description limits (4096 is absolute max, we use 3800)
          if (currentDescription.length + groupText.length > 3800) {
            embeds.push({
              title: embeds.length === 0 ? title : `${title} (Continued)`,
              color,
              description: currentDescription.trim()
            });
            currentDescription = '';
          }
          currentDescription += groupText;
        }
      }
    }

    // 3. Overall monthly summary formatted
    const isProgressStyle = config.dailyReportStyle.toLowerCase() === 'progress';
    let summaryText = `### 📊 Overall Monthly Summary\n`;
    if (isProgressStyle) {
      const summaryBar = renderProgressBarLocal(spentTotal, budgetedTotal, balanceTotal < 0 ? '🔴' : '🟢');
      summaryText += `\u2003\u2003${summaryBar}\n` +
                     `\u2003\u2003Spent: ${totalSpentStr} | Budgeted: ${totalBudgetedStr}\n` +
                     `\u2003\u2003**Remaining: ${totalBalanceStr}** (${totalStatusIndicator})`;
    } else {
      summaryText += `\u2003\u2003• **Total Budgeted**: ${totalBudgetedStr}\n` +
                     `\u2003\u2003• **Total Spent**: ${totalSpentStr}\n` +
                     `\u2003\u2003• **Total Balance**: **${totalBalanceStr}** (${totalStatusIndicator})`;
    }

    if (currentDescription.length + summaryText.length > 3800) {
      embeds.push({
        title: embeds.length === 0 ? title : `${title} (Continued)`,
        color,
        description: currentDescription.trim()
      });
      embeds.push({
        title: `${title} — Summary`,
        color,
        description: summaryText,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Actual Budget Notifier'
        }
      });
    } else {
      currentDescription += '\n' + summaryText;
      embeds.push({
        title: embeds.length === 0 ? title : `${title} (Continued)`,
        color,
        description: currentDescription.trim(),
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Actual Budget Notifier'
        }
      });
    }

    await sendDiscordReport(config.discordWebhookUrl, embeds);

  } finally {
    console.log('Daily Report: Shutting down connection to Actual Server...');
    await api.shutdown();
  }
}
