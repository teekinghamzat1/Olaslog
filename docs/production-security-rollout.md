# Production security rollout

This change set is intended for review before deployment. Do not merge or deploy it blindly.

## Required pre-deployment checks

1. Take a consistent SQLite backup while the application is stopped, and verify the backup can be opened. Keep a second copy off the VPS.
2. Confirm the production environment has a long, random `JWT_SECRET`. The application now refuses to start in production without it. Changing this value invalidates existing login tokens, so plan for users to sign in again.
3. Confirm the existing `ENCRYPTION_KEY` value is present and securely backed up. Do not replace it as part of this release. Existing delivered credentials were encrypted with the key active when they were stored. Replacing it without a controlled decrypt-and-re-encrypt migration can make historical credentials permanently unreadable.
4. Confirm `BILLSTACK_SECRET_KEY` is the real production key and that BillStack is configured to send the documented `x-wiaxy-signature-256` and `x-wiaxy-timestamp` headers. Unsigned webhooks are now rejected. Verify the signing format with BillStack's current documentation or support before enabling the change.
5. Verify at least one known administrator account exists before deploying. Production startup now stops rather than silently creating a predictable default administrator.
6. The seed script is now locked to `NODE_ENV=development` plus the explicit `ALLOW_DESTRUCTIVE_SEED=true` opt-in. It deletes user, wallet, order, credential, dispute, inventory and audit data, so use it only against a disposable development database. Never set that flag in production.
7. Test a small wallet deposit with BillStack's approved test procedure, then verify exactly one ledger credit, one confirmation email, and correct displayed balance. Also test a repeated webhook delivery to confirm it does not credit twice.
8. Verify SMTP with a valid certificate. Certificate verification is enabled; fix the SMTP host/certificate configuration rather than disabling TLS verification.
9. Run the project's test suite and a full checkout-to-delivery smoke test in staging before production rollout.

## Changes in this branch

- Production requires an explicitly configured JWT secret; development uses a per-process random secret when none is supplied.
- BillStack signature verification now calls `isMock()` rather than testing the function object, validates timestamp and signature shape, and uses constant-time byte comparison.
- The webhook route rejects missing or invalid signatures.
- SMTP certificate verification is no longer disabled.
- Production refuses to auto-create a default administrator.
- Wallet funding completion now serializes the read/check/update in a SQLite immediate transaction and refuses invalid state transitions.

## Deliberately not changed

- The encryption fallback key was not removed or rotated. This requires a controlled migration using the exact currently active key and a verified backup, because live customer credentials may depend on it.
- The seed script remains a destructive development reset, but now refuses to run unless `NODE_ENV=development` and `ALLOW_DESTRUCTIVE_SEED=true`; its reset operations run in a database transaction.
- Webhook acknowledgement still occurs before asynchronous processing in the current route. A durable inbox/queue with retry and reconciliation remains outstanding; do not assume the HTTP acknowledgement proves the wallet credit completed.
