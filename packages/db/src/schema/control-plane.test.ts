import { describe, expect, it } from "vite-plus/test";
import {
	CMO_CONTENT_OPERATIONS_CRON_TEMPLATE,
	DEFAULT_CRON_TEMPLATES,
} from "./control-plane";

describe("shared cognitive cron procedures", () => {
	it.each(DEFAULT_CRON_TEMPLATES)(
		"resolves $name capabilities through the executing tedi's schema",
		({ message }) => {
			expect(message).toContain("own credential-bound Code Mode connection");
			expect(message).toContain("limit: 3, includeParameters: true");
			expect(message).toContain("exact returned callable");
			expect(message).toContain(
				"required arguments, enum values, and input shapes",
			);
			expect(message).toContain("report the missing capability");
			// These persisted instructions caused real Code Mode failures before
			// their retries masked the cause as a provider-call ceiling.
			expect(message).not.toMatch(
				/tedi\.(list_objectives|create_task)|rationale\.(write_rationale|get_rationale_chain|complete_rationale)/,
			);
			expect(message).not.toMatch(
				/category: "(?:operational|technical)"|evidence: \[/,
			);
		},
	);

	it.each(DEFAULT_CRON_TEMPLATES)(
		"keeps $name outcome records grounded in real execution",
		({ message }) => {
			expect(message).toContain("current runId, workItemId, or toolCallRefs");
			expect(message).toContain("do not fabricate an execution link");
			expect(message).toContain(
				"Record failure or partial completion honestly",
			);
		},
	);

	it("routes newly identified work through the Work factory", () => {
		for (const name of ["objective-review", "growth-snapshot"]) {
			const message = DEFAULT_CRON_TEMPLATES.find(
				(cron) => cron.name === name,
			)?.message;
			expect(message).toContain("Work factory");
			expect(message).toMatch(/existing (item|Work Items)/);
		}
	});
});

describe("content-operations cron template", () => {
	it("keeps the CMO factory loop role-scoped and scheduled", () => {
		const cron = CMO_CONTENT_OPERATIONS_CRON_TEMPLATE;
		expect(cron.name).toBe("content-operations");
		expect(cron.schedule).toBe("0 * * * *");
		expect(cron.tools).toEqual(["code"]);
		expect(
			DEFAULT_CRON_TEMPLATES.some(
				(template) => template.name === "content-operations",
			),
		).toBe(false);
	});

	it("keeps disposition, readiness, and runtime state independent", () => {
		const message = CMO_CONTENT_OPERATIONS_CRON_TEMPLATE.message;
		expect(message).toContain("stable projectId");
		expect(message).toContain(
			"disposition and derived readiness independently",
		);
		expect(message).toContain("accepted ready work");
		expect(message).toContain("one authoritative attempt");
		expect(message).not.toMatch(/projectKey|itemType|checkoutId|claimedByMe/);
	});

	it("requires fenced attempts and independently reviewed evidence", () => {
		const message = CMO_CONTENT_OPERATIONS_CRON_TEMPLATE.message;
		expect(message).toContain("attemptId");
		expect(message).toContain("immutable executor session fence");
		expect(message).toContain("artifact-neutral evidence");
		expect(message).toContain("configured reviewer");
		expect(message).toContain("never infer completion from runtime state");
	});
});
