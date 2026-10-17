import assert from "node:assert/strict";
import {
	requireUnrestrictedModelEgress,
	unrestrictedModelAi,
} from "./unrouted-model-egress";
let calls = 0;
const env = {
	API_SERVICE: {
		fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
			calls++;
			const body = (await new Request(_input, init).json()) as {
				json?: Record<string, unknown>;
				organizationId?: string;
			};
			const input = body.json ?? body;
			assert.equal(input.organizationId, "org_lark");
			return Response.json({
				json: {
					allowed: false,
					message:
						"EU_PROVIDER_ROUTE_REQUIRED: Speech has no verified EU provider route. Ask an administrator to configure it.",
				},
			});
		},
	} as unknown as Fetcher,
};
await assert.rejects(
	requireUnrestrictedModelEgress(env, "org_lark", "Speech"),
	/EU_PROVIDER_ROUTE_REQUIRED.*administrator/,
);
assert.equal(calls, 1);
await assert.rejects(
	requireUnrestrictedModelEgress({}, "org_lark", "Speech"),
	/policy service/,
);
await requireUnrestrictedModelEgress(
	{
		API_SERVICE: {
			fetch: async () => Response.json({ json: { allowed: true } }),
		} as unknown as Fetcher,
	},
	"org_elm",
	"Speech",
);
console.log(
	"PASS auxiliary model policy RPC rejects restricted/unavailable routes and preserves unrestricted routes",
);

{
	let allowed = false,
		sent = 0;
	const ai = {
		logId: "fictional-log",
		async run() {
			sent++;
			return this.logId;
		},
	};
	const scoped = unrestrictedModelAi(
		{
			API_SERVICE: {
				fetch: async () =>
					Response.json({
						json: {
							allowed,
							message: "EU_PROVIDER_ROUTE_REQUIRED: Live voice is blocked",
						},
					}),
			} as unknown as Fetcher,
		},
		ai,
		() => "org_lark",
	);
	await assert.rejects(scoped.run(), /EU_PROVIDER_ROUTE_REQUIRED/);
	assert.equal(sent, 0);
	allowed = true;
	assert.equal(await scoped.run(), "fictional-log");
	assert.equal(scoped.logId, ai.logId);
	allowed = false;
	await assert.rejects(scoped.run(), /EU_PROVIDER_ROUTE_REQUIRED/);
	assert.equal(sent, 1);
}
console.log(
	"PASS voice provider reconnects revalidate policy and preserve binding properties",
);
