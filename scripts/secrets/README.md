# Master key rotation

`SECRETS_MASTER_KEY` (32 bytes, base64) encrypts four D1 columns via
`packages/db/src/utils/secrets-encryption.ts`, each with its own HKDF derive
function and salt:

| Table                  | Column              | Derive (HKDF info)    | Salt              |
| ---------------------- | ------------------- | --------------------- | ----------------- |
| `organization_secrets` | `encrypted_value`   | `org-secrets`         | `organization_id` |
| `app_secrets`          | `encrypted_value`   | `app-secrets`         | `app_id`          |
| `tedi_secrets`         | `encrypted_value`   | `tedi-secrets`        | `tedi_id`         |
| `app_catalog`          | `scan_auth_headers` | `catalog-app-secrets` | `id`              |

`key_version` on the `*_secrets` tables is a value revision counter, not a key
id; rotation leaves it alone. Other `SECRETS_MASTER_KEY` uses in `apps/api`
(artifact/skill-media URLs, workload grants, CIMD state) sign short-lived
tokens and store nothing, so they need no drain.

## Procedure

1. Generate a key: `openssl rand -base64 32`.
2. Set the secret on every Worker that reads it to `<new>,<old>` (index 0
   encrypts, the rest still decrypt) and deploy. Decrypts try each key in order.
3. Dry run, then apply, from a laptop with `wrangler login`:

   ```sh
   export SECRETS_MASTER_KEY='<new>,<old>'   # env only, never a CLI argument
   bun scripts/secrets/rotate-master-key.ts --remote
   bun scripts/secrets/rotate-master-key.ts --remote --apply
   ```

   Options: `--database <binding or name>` (default: first D1 binding in
   `apps/api/wrangler.jsonc`), `--config <wrangler.jsonc>`, `--local`,
   `--limit N` (rows per table). Output is counts per table plus the ids of
   unreadable rows (exit code 2); plaintext and keys are never printed. Writes
   are optimistic per row: a row changed meanwhile is skipped for the next run.

4. When every table reports `stale=0`, set the secret to `<new>` alone. Tests:
   `bun test scripts/secrets/rotate-master-key.test.ts`.
