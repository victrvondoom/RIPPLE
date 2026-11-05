# Skill: escrow (created -> funded -> submitted -> verified|rejected -> released|refunded)

1. **Open.** Collect: title, a written spec, 2-6 acceptance criteria (ask the payer to
   make them checkable), amount + currency the recipient should receive, the payer's
   currency, payer name, recipient name + PayPal email + country, verifier name.
   ```
   node cli/clearsend.mjs escrow-create --title "Pitch deck" --spec "..." \
     --criterion "3 slides" --criterion "Includes market size with a source" \
     --amount 50 --currency USD --pay-currency USD \
     --payer <user> --recipient <user> --recipient-email ada@example.com \
     --recipient-country Ghana --verifier <user> --platform slack --channel <room> --requested-by <user>
   ```
   Post the breakdown and the three `links`, **each addressed to its person** ("@payer this
   is your link"). Explain in one line what each person will do (see the room doc
   `escrow-lifecycle`).
2. **Fund.** Ask the payer: "Reply 'confirm fund' to create the PayPal sandbox order for
   {total} {currency}." Then
   `escrow-fund --escrow <id> --confirmed-by <payer> --confirmation "<exact words>"`
   and post `approveUrl`. When the payer says "paid": `escrow-capture --escrow <id>`.
   State becomes **funded**. Tell the recipient to post the deliverable.
3. **Submit.** When the recipient posts the deliverable (text, links):
   `escrow-submit --escrow <id> --by <recipient> --deliverable "<their text verbatim>"`.
4. **Verify.** Immediately run `escrow-verify --escrow <id>`. Post the decision:
   VERIFIED or REJECTED, the model name, and every criterion with ✅/❌ and its reason.
   - verified: "@verifier reply 'approve release' to pay {amount} {currency} to {recipient}."
   - rejected: "@recipient fix the ❌ items and post again" (resubmit with step 3), or the
     payer/verifier may type "refund".
5. **Release.** Only on the verifier's (or payer's) explicit words, never the recipient's:
   `escrow-release --escrow <id> --confirmed-by <verifier> --confirmation "<exact words>"`.
   Post the PayPal payout batch id and status.
6. **Refund.** `escrow-refund --escrow <id> --confirmed-by <payer|verifier> --confirmation "<exact words>"`.

`escrow-show --escrow <id>` returns `nextSteps` per party. Use it whenever someone asks
"where are we?" and answer per person.

## Status after each step

After each step above, run `node cli/clearsend.mjs status --subject <id> --step <step> --summary "<what happened, what is next>"`.
When a check fails or a person is refused, use `--step blocked`. Test records can be removed with
`trip-delete` / `escrow-delete` (service key; also removes their activity).
