// cashleg.mjs — real cash-leg lifecycle from the Stripe feed.
//
// Reads recent payments and emits the cash_leg block the engagement
// record carries: initiated → (cleared) → settled, with Stripe's own
// balance-transaction `available_on` as the expected settlement date.
// The token side proceeds on `initiated`; this feed is what lets the
// record say "there was a cash payment, and here is exactly where it
// is in its lifecycle."
//
// Env: STRIPE_KEY — use a RESTRICTED key, read-only on Charges,
// PaymentIntents and Balance transactions. Never the full secret key,
// never committed (.env is gitignored).
//
// Usage:
//   node cashleg.mjs             today's payments as cash_leg JSON
//   node cashleg.mjs --days 7    look back further

const KEY = process.env.STRIPE_KEY;
if (!KEY) {
  console.error("STRIPE_KEY not set (restricted read-only key; see header)");
  process.exit(1);
}
const daysIdx = process.argv.indexOf("--days");
const days = daysIdx >= 0 ? parseInt(process.argv[daysIdx + 1], 10) : 1;
const since = Math.floor(Date.now() / 1000) - days * 86400;

const api = async (path) => {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.type}: ${j.error.message}`);
  return j;
};

const charges = await api(`charges?created[gte]=${since}&limit=20`);
const now = Math.floor(Date.now() / 1000);
const legs = [];
for (const c of charges.data) {
  if (c.status !== "succeeded") continue;
  let availableOn = null, settledAmount = null, fee = null;
  if (c.balance_transaction) {
    const bt = await api(`balance_transactions/${c.balance_transaction}`);
    availableOn = bt.available_on;
    settledAmount = bt.net / 100;
    fee = bt.fee / 100;
  }
  // coarse only: ids and amounts — no customer fields ever leave Stripe
  legs.push({
    provider: "stripe",
    reference: c.id,
    amount_usd: c.amount / 100,
    currency: c.currency,
    initiated_at: new Date(c.created * 1000).toISOString(),
    expected_settlement: availableOn ? new Date(availableOn * 1000).toISOString() : null,
    status: availableOn && availableOn <= now ? "settled" : "pending",
    net_after_fees_usd: settledAmount,
    processor_fee_usd: fee,
    dispute_window_open: !c.disputed && c.status === "succeeded",
  });
}
const pendingTotal = legs.filter((l) => l.status === "pending")
  .reduce((s, l) => s + l.amount_usd, 0);
console.log(JSON.stringify({
  as_of: new Date().toISOString(),
  cash_legs: legs,
  unsettled_total_usd: pendingTotal,
  note: "token side may proceed on initiated; unsettled_total_usd counts against settlementFloatCapUsd (params.local.json)",
}, null, 2));
