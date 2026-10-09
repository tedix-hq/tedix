import { describe, expect, test } from "bun:test";
import { resolveThreadOrganizationId } from "./thread-organization";

const ORGANIZATION_ID = "0f1e2d3c-4b5a-4968-8777-66554433aabb";

describe("@tedix/cli resolveThreadOrganizationId", () => {
	test("awaits codemode.__runtime() and returns the gateway's organization id", async () => {
		const sources: string[] = [];
		const organizationId = await resolveThreadOrganizationId({
			runCode: async (source) => {
				sources.push(source);
				return {
					executionId: "exec-1",
					result: { organizationId: ORGANIZATION_ID },
				};
			},
		});
		expect(organizationId).toBe(ORGANIZATION_ID);
		// `__runtime()` is async; reading `.organizationId` off the pending
		// promise is the bug that made every `--thread` command fail.
		expect(sources).toEqual([
			"async () => { const runtime = await codemode.__runtime(); return { organizationId: runtime.organizationId }; }",
		]);
	});

	test("a promise's organizationId (the unawaited call) is rejected, not trusted", async () => {
		// What the gateway returns for the old unawaited program: the property
		// read off a Promise is undefined, so the result has no organizationId.
		await expect(
			resolveThreadOrganizationId({
				runCode: async () => ({ executionId: "exec-1", result: {} }),
			}),
		).rejects.toThrow(
			"Could not verify the organization for saved conversation names.",
		);
	});

	test("a slug or any non-UUID organization id still fails the check", async () => {
		for (const organizationId of ["tedix", "", 42, null]) {
			await expect(
				resolveThreadOrganizationId({
					runCode: async () => ({ result: { organizationId } }),
				}),
			).rejects.toThrow("Could not verify the organization");
		}
	});

	test("a truncated gateway result is not mistaken for an organization id", async () => {
		await expect(
			resolveThreadOrganizationId({
				runCode: async () => ({
					result: {
						__tedix_truncated: true,
						preview: `{"organizationId":"${ORGANIZATION_ID}"`,
					},
				}),
			}),
		).rejects.toThrow("Could not verify the organization");
	});
});
