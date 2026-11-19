import { expect, it } from "vite-plus/test";
import { z } from "zod";
import { ReportDispatcherHealthInputSchema } from "./dispatcher-health";
import { ClaimMachineToolCallsInputSchema } from "./machines";

it("accepts an ordinary hostname through the published JSON schema", () => {
	// The CLI checks its input against the tool's JSON schema, which carries a
	// pattern's source without its flags.
	const published = (schema: z.ZodType) =>
		z.fromJSONSchema(
			z.toJSONSchema(schema, { io: "input" }) as Parameters<
				typeof z.fromJSONSchema
			>[0],
		);
	const claim = published(ClaimMachineToolCallsInputSchema);
	for (const machineName of ["build-mac-2", "Mac"])
		expect(
			claim.safeParse({ reporterId: "runner-1", machineName, limit: 5 })
				.success,
		).toBe(true);
	expect(
		claim.safeParse({
			reporterId: "runner-1",
			machineName: "a\u0007b",
			limit: 5,
		}).success,
	).toBe(false);
	expect(
		published(ReportDispatcherHealthInputSchema).safeParse({
			reporterId: "runner-1",
			executor: "codex",
			lane: "primary",
			running: true,
			observedAt: "2026-11-19T22:00:00.000Z",
			lastAdmissionAt: null,
			topReason: null,
			machineName: "build-mac-2",
			machineTools: [],
		}).success,
	).toBe(true);
});
