export interface TransactionRecord {
  id: string;
  date: string;
  amount: number;
  category?: string | null;
  'payee.name'?: string | null;
  'category.name'?: string | null;
  'account.name'?: string | null;
  notes?: string | null;
  transfer_id?: string | null;
  is_parent?: boolean;
  subtransactions?: Array<{
    amount: number;
    category?: string | null;
    'category.name'?: string | null;
    notes?: string | null;
    categoryBudgetInfo?: string | null;
  }>;
  categoryBudgetInfo?: string | null;
}

/**
 * Formats a monetary amount from Actual Budget's internal integer cent representation
 * to a user-friendly string (e.g., -1050 -> "-$10.50").
 */
function formatAmount(amount: number): string {
  const dollarVal = Math.abs(amount / 100).toFixed(2);
  const sign = amount < 0 ? '-' : amount > 0 ? '+' : '';
  return `${sign}$${dollarVal}`;
}

/**
 * Constructs a Discord embed object for a single transaction.
 */
function buildEmbedForTransaction(tx: TransactionRecord): any {
  const isTransfer = !!tx.transfer_id;
  const isIncome = tx.amount > 0;
  
  // Decide title, color, and icon based on transaction type
  let title = '💸 New Expense';
  let color = 15143740; // Hex #e74c3c (Red/Orange)
  
  if (isTransfer) {
    title = '🔄 Account Transfer';
    color = 3447003; // Hex #3498db (Blue)
  } else if (isIncome) {
    title = '📥 New Income';
    color = 3066993; // Hex #2ecc71 (Green)
  }

  const payeeName = tx['payee.name'] || 'Unknown Payee';
  const categoryName = tx['category.name'] || (isTransfer ? 'Transfer' : 'Uncategorized');
  const accountName = tx['account.name'] || 'Unknown Account';
  const amountStr = formatAmount(tx.amount);
  
  const fields = [
    { name: 'Amount', value: `**${amountStr}**`, inline: true },
    { name: 'Payee', value: payeeName, inline: true },
    { name: 'Account', value: accountName, inline: true },
    { name: 'Category', value: categoryName, inline: true },
    { name: 'Date', value: tx.date, inline: true }
  ];

  if (tx.notes) {
    fields.push({ name: 'Notes', value: tx.notes, inline: false });
  }

  if (tx.categoryBudgetInfo) {
    fields.push({ name: 'Budget Status', value: tx.categoryBudgetInfo, inline: false });
  }

  let description = '';
  // If this is a split transaction, list the details
  if (tx.is_parent && tx.subtransactions && tx.subtransactions.length > 0) {
    description = '**Splits:**\n' + tx.subtransactions.map(sub => {
      const subCategory = sub['category.name'] || 'Uncategorized';
      const subAmountStr = formatAmount(sub.amount);
      const budgetStr = sub.categoryBudgetInfo ? ` — *(${sub.categoryBudgetInfo})*` : '';
      const noteStr = sub.notes ? ` *(${sub.notes})*` : '';
      return `• **${subAmountStr}** ➔ ${subCategory}${budgetStr}${noteStr}`;
    }).join('\n');
  }

  return {
    title,
    description: description || undefined,
    color,
    fields,
    timestamp: new Date().toISOString()
  };
}

/**
 * Sends a list of transactions to Discord in batches of up to 10 embeds.
 */
export async function sendDiscordNotification(webhookUrl: string, transactions: TransactionRecord[]): Promise<void> {
  if (transactions.length === 0) return;

  console.log(`Preparing to send ${transactions.length} transaction notification(s) to Discord...`);

  // Discord webhooks accept a maximum of 10 embeds per request
  const batchSize = 10;
  for (let i = 0; i < transactions.length; i += batchSize) {
    const chunk = transactions.slice(i, i + batchSize);
    const embeds = chunk.map(tx => buildEmbedForTransaction(tx));

    const payload = { embeds };

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Failed to send webhook chunk to Discord. Status: ${response.status} ${response.statusText}. Response: ${errorText}`);
      } else {
        console.log(`Successfully sent batch of ${chunk.length} notifications to Discord.`);
      }
    } catch (error) {
      console.error('Network error sending webhook to Discord:', error);
    }

    // Add a short delay between batches if there are more to send, to prevent rate limits
    if (i + batchSize < transactions.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Sends a custom embed daily report (or array of embeds) directly to the Discord webhook.
 */
export async function sendDiscordReport(webhookUrl: string, embeds: any | any[]): Promise<void> {
  const payload = { embeds: Array.isArray(embeds) ? embeds : [embeds] };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to send Discord daily report. Status: ${response.status} ${response.statusText}. Response: ${errorText}`);
    } else {
      console.log('Successfully sent Daily Budget Report to Discord.');
    }
  } catch (error) {
    console.error('Network error sending daily report to Discord:', error);
  }
}
