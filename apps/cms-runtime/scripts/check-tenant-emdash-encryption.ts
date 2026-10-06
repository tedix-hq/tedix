import assert from "node:assert/strict";

import { deriveTenantEmdashEncryptionKeys } from "../src/tenant-emdash-encryption";

const first = `emdash_enc_v1_${"A".repeat(43)}`;
const second = `emdash_enc_v1_${"B".repeat(43)}`;
const tenantA = await deriveTenantEmdashEncryptionKeys(first, "alpha");
const tenantB = await deriveTenantEmdashEncryptionKeys(first, "beta");
assert.match(tenantA ?? "", /^emdash_enc_v1_[A-Za-z0-9_-]{43}$/);
assert.notEqual(tenantA, tenantB, "tenant keys must be isolated");
assert.equal(tenantA, await deriveTenantEmdashEncryptionKeys(first, "alpha"));
assert.equal(
	await deriveTenantEmdashEncryptionKeys(`${second},${first}`, "alpha"),
	`${await deriveTenantEmdashEncryptionKeys(second, "alpha")},${tenantA}`,
	"rotation must retain the previous key after the new write key",
);
assert.equal(
	await deriveTenantEmdashEncryptionKeys(undefined, "alpha"),
	undefined,
);
await assert.rejects(
	deriveTenantEmdashEncryptionKeys("bad-key", "alpha"),
	/Invalid EMDASH_ENCRYPTION_KEY format/,
);
