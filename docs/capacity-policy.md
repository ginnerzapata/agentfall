# Capacity safety policy

Agentfall fails closed before it approaches the Cloudflare Workers Free daily request limit or the D1 Free daily row limits. Cloudflare currently resets these limits at 00:00 UTC and documents Free allowances of 100,000 Worker requests, 5,000,000 D1 rows read, and 100,000 D1 rows written per day. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

The application deliberately admits against only 50,000 requests, 2,000,000 rows read, and 60,000 rows written per UTC day. Before accepting a floor it reserves 500 requests, 20,000 reads, and 2,000 writes for its full lifetime. Those reservations remain until the UTC reset even if a floor ends early, so an admitted session has its budget protected and partial usage cannot be undercounted.

Practice admissions additionally leave 20,000 write reservations available for ranked play. Ranked sessions can consume that headroom, so practice sheds first. If a reservation cannot fit, the application returns `CAPACITY_EXHAUSTED` with the next UTC midnight; it does not start the floor or mutate run state.

The deployed Worker stays on the Workers Free plan and uses only the configured D1 binding. This was confirmed on 2026-11-19 against the Cloudflare pricing documentation: Workers Free is the default plan, and a Free D1 database rejects queries after its daily allowance instead of upgrading the account. `wrangler.jsonc` has no paid-service binding, paid usage model, or scheduled resource. Moving an account to Workers Paid remains an explicit account-owner action outside this repository; no configured resource can initiate it automatically.
