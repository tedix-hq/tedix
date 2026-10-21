import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TediRuntimeApiKeyRow } from "@tedix/db/queries/tedi-runtime-bootstrap";
import { TEDI_MCP_SCOPES } from "@tedix/mcp-shared/auth/scopes";
import { createIsolateApiKeyValidator } from "./mcp-apikey";

const key = "sk_fictional_runtime_restrictions_test";
const organizationId = "11111111-1111-4111-8111-111111111111";
const row: TediRuntimeApiKeyRow = {
	id: "fictional-api-key",
	organizationId,
	status: "active",
	expiresAt: null,
	ipAllowlist: null,
};

async function validate({
	orgId = organizationId,
	ipAllowlist = null,
	clientIp = "203.0.113.9",
	forwardedIp,
	apiKey = row,
	input = key,
}: {
	orgId?: string | null;
	ipAllowlist?: string | null;
	clientIp?: string | null;
	forwardedIp?: string;
	apiKey?: TediRuntimeApiKeyRow | null;
	input?: string;
} = {}) {
	const reads: unknown[][] = [];
	let usageWrites = 0;
	const db = {
		prepare: (sql: string) => ({
			bind: (...values: unknown[]) => ({
				first: async () => {
					assert.match(sql, /FROM api_keys/);
					reads.push(values);
					return apiKey && { ...apiKey, ipAllowlist };
				},
				run: async () => {
					assert.match(sql, /UPDATE api_keys/);
					assert.equal(values[2], row.id);
					usageWrites++;
				},
			}),
		}),
	} as unknown as D1Database;
	const headers = new Headers();
	if (clientIp !== null) headers.set("CF-Connecting-IP", clientIp);
	if (forwardedIp !== undefined) headers.set("X-Forwarded-For", forwardedIp);
	const auth = await createIsolateApiKeyValidator(
		db,
		{ orgId },
		new Request("https://fictional.example/mcp", { headers }),
	)(input);
	return { auth, reads, usageWrites };
}

const failures: string[] = [];
async function denied(label: string, options: Parameters<typeof validate>[0]) {
	const { auth, usageWrites } = await validate(options);
	if (auth !== null || usageWrites !== 0) failures.push(label);
}

for (const orgId of [null, "", "22222222-2222-4222-8222-222222222222"]) {
	await denied(`unresolved or mismatched organization ${String(orgId)}`, {
		orgId,
	});
}

for (const raw of [
	"",
	" ",
	"[",
	"null",
	"{}",
	"true",
	"17",
	'"203.0.113.9"',
	"[null]",
	"[42]",
	"[{}]",
	'["203.0.113.9",null]',
	'["203.0.113.9",42]',
	'["203.0.113.9",""]',
]) {
	await denied(`corrupt allowlist ${raw}`, { ipAllowlist: raw });
}

const malformedPatterns = [
	"203.0.113.0/24garbage",
	"203.0.113.0/24/extra",
	"203.0.113.0/24.5",
	"203.0.113.0/-1",
	"203.0.113.0/+24",
	"203.0.113.0/33",
	"203.0.113.0/",
	"/24",
	"203.0.113.0/ 24",
	"203.0.113.0/2e1",
	"203.0.113garbage.0/24",
	"203.0.113.0garbage/24",
	"203.0.113.0.1/24",
	"203.0.113/24",
	"203.0..0/24",
	"203.0.-1.0/0",
	"203.0.256.0/0",
	"203.0.1.5.0/0",
	"203.0.+113.0/24",
	"203.0.0x71.0/0",
	"203.0.113.999",
	"203.0.113.9suffix",
	"not-an-ip",
];
for (const pattern of malformedPatterns) {
	await denied(`malformed pattern ${pattern}`, {
		ipAllowlist: JSON.stringify([pattern]),
	});
	await denied(`corrupt mixed restriction ${pattern}`, {
		ipAllowlist: JSON.stringify(["203.0.113.9", pattern]),
	});
}

for (const clientIp of [
	null,
	"203.0.113.9suffix",
	"203.0.113",
	"203.0.113.9.1",
	"203.0..9",
	"203.0.-1.9",
	"203.0.256.9",
	"203.0.+113.9",
	"203.0.113.9, 198.51.100.1",
]) {
	await denied(`invalid client ${String(clientIp)}`, {
		ipAllowlist: '["0.0.0.0/0"]',
		clientIp,
	});
}
await denied("malformed exact pattern cannot match itself", {
	ipAllowlist: '["203.0.113.9suffix"]',
	clientIp: "203.0.113.9suffix",
});
await denied("exact mismatch", { ipAllowlist: '["203.0.113.8"]' });
await denied("CIDR mismatch", { ipAllowlist: '["198.51.100.0/24"]' });
await denied("/32 mismatch", { ipAllowlist: '["203.0.113.8/32"]' });
await denied("CF header takes precedence", {
	ipAllowlist: '["198.51.100.1"]',
	forwardedIp: "198.51.100.1",
});
await denied("unknown key", { apiKey: null });
await denied("revoked key", { apiKey: { ...row, status: "revoked" } });
await denied("expired key", {
	apiKey: { ...row, expiresAt: "2000-01-01T00:00:00.000Z" },
});
await denied("wrong token prefix", { input: "fictional-token" });

for (const options of [
	{ ipAllowlist: null, clientIp: null },
	{ ipAllowlist: "[]", clientIp: null },
	{ ipAllowlist: " [] " },
	{ ipAllowlist: '["2001:db8::1"]', clientIp: "2001:db8::1" },
	{ ipAllowlist: '["203.0.113.9"]' },
	{ ipAllowlist: '["203.0.113.0/24"]' },
	{ ipAllowlist: '["203.0.113.9/32"]' },
	{ ipAllowlist: '["0.0.0.0/0"]' },
	{ ipAllowlist: '["255.255.255.255/0"]' },
	{ ipAllowlist: '["198.51.100.1","203.0.113.9"]' },
	{ ipAllowlist: '["0.0.0.0/32"]', clientIp: "0.0.0.0" },
	{ ipAllowlist: '["255.255.255.255/32"]', clientIp: "255.255.255.255" },
	{
		ipAllowlist: '["203.0.113.9"]',
		clientIp: null,
		forwardedIp: "203.0.113.9",
	},
	{ apiKey: { ...row, expiresAt: "2999-01-01T00:00:00.000Z" } },
]) {
	const { auth, reads, usageWrites } = await validate(options);
	assert.deepEqual(auth, {
		authenticated: true,
		authMethod: "api-key",
		orgId: organizationId,
		scopes: [...TEDI_MCP_SCOPES],
	});
	assert.deepEqual(reads, [[createHash("sha256").update(key).digest("hex")]]);
	assert.equal(usageWrites, 1);
}

assert.deepEqual(failures, [], "restriction cases unexpectedly authenticated");
console.log(
	"Runtime API-key restrictions fail closed and preserve valid scopes",
);
