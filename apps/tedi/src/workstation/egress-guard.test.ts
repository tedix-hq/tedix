import { describe, expect, it } from "vite-plus/test";
import { workstationSandboxId } from "./egress-guard";

describe("workstationSandboxId", () => {
	it("keeps UUID tedi ids within the Cloudflare Sandbox id limit", () => {
		const id = workstationSandboxId("5eed0038-0000-4000-8000-000000000038");

		expect(id).toBe("5eed0038-0000-4000-8000-000000000038-we2");
		expect(id.length).toBeLessThanOrEqual(63);
	});

	it("bounds long tedi ids with a deterministic hash", () => {
		const id = workstationSandboxId("tenant:very-long-tedi-id".repeat(5));

		expect(id).toMatch(/-we2$/);
		expect(id.length).toBeLessThanOrEqual(63);
		expect(workstationSandboxId("tenant:very-long-tedi-id".repeat(5))).toBe(id);
	});
});
