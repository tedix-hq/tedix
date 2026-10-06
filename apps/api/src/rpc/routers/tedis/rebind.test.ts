import { describe, expect, test } from "vite-plus/test";
import { computeRebindAgentId } from "./crud";

describe("computeRebindAgentId", () => {
	test("generates a fresh {slug}-rebind-{epochMs} name distinct from the current value", () => {
		const { isolateAgentId, previous } = computeRebindAgentId({
			slug: "echo",
			id: "11111111-1111-1111-1111-111111111111",
			currentIsolateAgentId: "echo-recover-1780168873",
			now: 1_790_000_000_000,
		});

		expect(previous).toBe("echo-recover-1780168873");
		expect(isolateAgentId).toBe("echo-rebind-1790000000000");
		expect(isolateAgentId).not.toBe(previous);
	});

	test("falls back to the tedi id when slug is null", () => {
		const { isolateAgentId, previous } = computeRebindAgentId({
			slug: null,
			id: "22222222-2222-2222-2222-222222222222",
			currentIsolateAgentId: null,
			now: 1_790_000_000_001,
		});

		// previous defaults to the slug part (id) when no prior id exists
		expect(previous).toBe("22222222-2222-2222-2222-222222222222");
		expect(isolateAgentId).toBe(
			"22222222-2222-2222-2222-222222222222-rebind-1790000000001",
		);
		expect(isolateAgentId).not.toBe(previous);
	});

	test("appends a random suffix when the generated name collides with the current value", () => {
		// Same millisecond already produced the current id — must still differ.
		const { isolateAgentId, previous } = computeRebindAgentId({
			slug: "echo",
			id: "33333333-3333-3333-3333-333333333333",
			currentIsolateAgentId: "echo-rebind-1790000000000",
			now: 1_790_000_000_000,
			randomSuffix: () => "abcd1234",
		});

		expect(previous).toBe("echo-rebind-1790000000000");
		expect(isolateAgentId).toBe("echo-rebind-1790000000000-abcd1234");
		expect(isolateAgentId).not.toBe(previous);
	});
});
