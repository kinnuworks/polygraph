# Evidence

Every number in the main README, with the file behind it and the Stripe or CreateOS id where there is one.

| Claim | File | Ids |
|---|---|---|
| 6 of 6 dishonest offers refused on the live gateway, 5 before any payment existed | [tamper-matrix.json](tamper-matrix.json) | 0 PaymentIntents for cases 1 to 5; case 6 `pi_3URgX4QwaSeLdSm41NHkyJwX` refunded as `re_3URgX4QwaSeLdSm41bxUtXlm` |
| The seller agent's first draft failed 1 of 20 tests, the fix passed 20 of 20, then 17 of 17 hidden tests | [seller-build-with-fix.log](seller-build-with-fix.log) | drafted by claude-haiku-5-5, fixed by claude-sonnet-5-5 |
| A seller build that passed on the first try (the live genuine offer's digest `e1413d16…`) | [seller-build-first-try-pass.log](seller-build-first-try-pass.log) | |
| Link wallet: a tampered tool paid, caught by the buyer's hashing, refunded | [link-wallet-run.log](link-wallet-run.log) | `pi_3URgu5QwaSeLdSm40559yn2j`, refund `re_3URgu5QwaSeLdSm40UyyiI6x` |
| Link wallet: the genuine offer paid and delivered, including the 45 s refund and warm retry | [link-wallet-genuine-run.log](link-wallet-genuine-run.log) | `pi_3URhcNQwaSeLdSm40X1GjUTu`, worker `sb-01m5653cnme048ejes6pdhd5nb`, parent `sb-01m55xnadd6p0d29vvsxx1ynnj` |
| The receipt the buyer kept for that purchase, with all 23 checks | [receipt-genuine-link.json](receipt-genuine-link.json) | |
| The returned PDF is PDF/A-2b, 2 pages | [pdfa-check.txt](pdfa-check.txt) | sha256 `4a776d81…4b93` |
| Stripe Projects provisioned the CreateOS account and the deploy target | [stripe-projects-status.txt](stripe-projects-status.txt), [../../.projects/state.json](../../.projects/state.json) | |
