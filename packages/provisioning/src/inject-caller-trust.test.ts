/**
 * The runtime fails closed on a missing `x-tedix-caller-trust` tier, so the
 * kernel's inject must stamp `member` (it acts for the organization) or its
 * delegation metadata and learning steering are stripped.
 */
import { CALLER_TRUST_HEADER } from "@tedix/mcp-shared/auth/caller-trust";
import { injectAgentMessage, type ProvisioningConfig } from "./index";

const assert = {
	equal(actual: unknown, expected: unknown, message?: string) {
		if (actual !== expected)
			throw new Error(
				message ?? `Expected ${String(expected)}, received ${String(actual)}`,
			);
	},
};

const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
const config: ProvisioningConfig = {
	workerUrl: "https://tedi",
	fetcher: {
		fetch: (async (url, init) => {
			seen.push({
				url: String(url),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)),
			});
			return Response.json({ success: true, accepted: true, run_id: "run-1" });
		}) as typeof fetch,
	},
};

const result = await injectAgentMessage(config, {
	message: "do the work",
	async: true,
	metadata: { workItemId: "work-1", homeRunId: "home-1" },
});
assert.equal(result.success, true);
assert.equal(seen.length, 1);
assert.equal(seen[0]?.url, "https://tedi/hooks/inject");
assert.equal(seen[0]?.headers.get("X-Service-Binding"), "true");
assert.equal(
	seen[0]?.headers.get(CALLER_TRUST_HEADER),
	"member",
	"kernel inject stamps the member tier",
);
const body = seen[0]?.body as { metadata?: { workItemId?: string } };
assert.equal(body.metadata?.workItemId, "work-1");
console.log("injectAgentMessage stamps x-tedix-caller-trust: member");
