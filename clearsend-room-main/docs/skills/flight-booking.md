# Skill: flight booking (search -> choose -> confirm -> PayPal)

Follow these steps in order. Do not skip a question.

1. **Collect** origin, destination (3-letter IATA codes; ask if a city is ambiguous, e.g.
   London = LHR/LGW), date `YYYY-MM-DD`, number of adults, and the payer's currency.
2. **Search**:
   `node cli/clearsend.mjs flights --from LOS --to LHR --date 2026-12-15 --adults 1 --currency USD`
   Keep `searchId`. Sources: `sky-scrapper` (live fares, needs RAPIDAPI_KEY),
   `opensky` (real flights observed in the last 48h, no fares), `openflights`
   (route database, no fares). Report each source's `status` honestly (e.g. "Sky-Scrapper:
   rate-limited (429)").
3. **Show** at most 6 options as a numbered list using each option's `ref`:
   airline, flight number, times if present, stops, and the fare as `fareLabel`.
   Schedule-only options must read **"fare unavailable"**.
   If `priced` is 0: say no bookable fare is available right now, show schedule-only
   options for planning, and stop. Do not guess a price.
4. **Ask exactly:** "Which flight would you like?"
5. When they pick a priced option, **ask exactly:**
   "Would you like me to book this and pay with your PayPal account?"
6. On yes, **collect traveller details** for every adult (in a thread): full name as on
   passport, email, date of birth, nationality.
7. **Quote**:
   `node cli/clearsend.mjs trip-quote --search <searchId> --option <ref> --pay-currency USD --requested-by <username> --traveller "Ada Obi|ada@example.com|1990-01-31|NG"`
   (repeat `--traveller` per adult). Post the `breakdown`: fare, mid-market rate and its
   source, converted amount, FX spread (1.2%), platform fee (2.5%), **total**.
8. **Ask for the final yes:** "Total {total} {currency}. Reply 'yes, book it' to create the
   PayPal sandbox order."
9. Only after the payer types it:
   `node cli/clearsend.mjs trip-pay --trip <id> --confirmed-by <username> --confirmation "<exact words>"`
   Post the `approveUrl`: "Approve in PayPal sandbox, then reply 'paid'."
10. On "paid": `node cli/clearsend.mjs trip-capture --trip <id>`. If PayPal says not
    approved yet, say so. On success post the capture id and the `ticketing` note verbatim:
    the payment is captured but **no airline ticket is issued** by this project.

## Status after each step

After each step above, run `node cli/clearsend.mjs status --subject <id> --step <step> --summary "<what happened, what is next>"`.
When a check fails or a person is refused, use `--step blocked`. Test records can be removed with
`trip-delete` / `escrow-delete` (service key; also removes their activity).
