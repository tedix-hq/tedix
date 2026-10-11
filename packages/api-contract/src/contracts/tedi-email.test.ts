import { describe, expect, it } from "vite-plus/test";
import { tediEmailContract } from "./tedi-email";

function inputSchemaOf(procedure: unknown) {
	const def = (procedure as { "~orpc": { inputSchemas?: unknown[] } })["~orpc"];
	return def.inputSchemas?.[0] as {
		safeParse: (value: unknown) => { success: boolean; data?: unknown };
	};
}

describe("tediEmail address routing policy", () => {
	const base = {
		addressId: "11111111-1111-4111-8111-111111111111",
		status: "active" as const,
	};

	it("validates the platform provisioning policy like the tenant endpoints", () => {
		const schema = inputSchemaOf(tediEmailContract.provisionAddress);
		expect(
			schema.safeParse({
				...base,
				routingPolicy: { allowedSenders: ["not-an-email"] },
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, routingPolicy: { spamThreshold: 99 } })
				.success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, routingPolicy: { unknownKey: true } })
				.success,
		).toBe(false);
		const ok = schema.safeParse({
			...base,
			routingPolicy: {
				allowedSenders: [" Alice@Example.com ", "@Partner.example.com"],
				untrustedSenders: "quarantine",
				spamThreshold: 3,
				source: "operator",
			},
		});
		expect(ok.success).toBe(true);
		expect((ok.data as { routingPolicy: unknown }).routingPolicy).toEqual({
			allowedSenders: ["alice@example.com", "@partner.example.com"],
			untrustedSenders: "quarantine",
			spamThreshold: 3,
			source: "operator",
		});
	});
});
