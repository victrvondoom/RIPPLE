# Skill: FX quote

`node cli/clearsend.mjs quote --amount 200 --from USD --to GHS`

Post: mid-market rate and its source (open.er-api.com, or frankfurter.app as fallback),
converted amount, FX spread 1.2% (zero for same currency), platform fee 2.5%, total, and
the quote time. Rates move; say the quote is indicative until a PayPal order is created.
If every FX source fails, say so. Never fill in a rate from memory.
Note: PayPal sandbox payouts support a limited currency list (no NGN, GHS or KES payouts);
pay out in USD/EUR/GBP and say so.
