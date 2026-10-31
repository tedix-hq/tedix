import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { LinkedTediActivityDetails } from "./run-tedi-activity";

describe("linked tedi activity", () => {
	it("labels linked task events and a truncated final result", () => {
		const html = renderToStaticMarkup(
			<LinkedTediActivityDetails
				activity={{
					status: "available",
					activitySource: "linked_tedi_run",
					runStatus: "completed",
					actions: [
						{
							id: "event",
							kind: "tool.completed",
							createdAt: "2026-01-01",
							toolName: "search",
						},
					],
					finalResult: {
						status: "available",
						content: "Found results",
						truncated: true,
					},
					truncated: true,
				}}
			/>,
		);
		expect(html).toContain("linked assistant task");
		expect(html).toContain("Search");
		expect(html).toContain("completed");
		expect(html).toContain("Assistant activity");
		expect(html).toContain("Answer");
		expect(html).toContain("Found results");
		expect(html).toContain("Only part of the assistant activity is shown");
		expect(html).toContain("Only part of the answer was saved");
	});
	it("keeps redacted or unavailable activity hidden even if a payload is supplied", () => {
		for (const status of ["redacted", "unavailable"] as const) {
			const html = renderToStaticMarkup(
				<LinkedTediActivityDetails
					activity={{
						status,
						actions: [
							{
								id: "event",
								kind: "tool.completed",
								createdAt: "2026-01-01",
								toolName: "secret action",
							},
						],
						finalResult: { status: "available", content: "secret result" },
						truncated: false,
					}}
				/>,
			);
			expect(html).not.toContain("secret action");
			expect(html).not.toContain("secret result");
		}
	});
	it("does not call a pending task a final answer", () => {
		const html = renderToStaticMarkup(
			<LinkedTediActivityDetails
				activity={{
					status: "available",
					activitySource: "linked_tedi_run",
					runStatus: "working",
					actions: [],
					finalResult: { status: "unavailable" },
					truncated: false,
				}}
			/>,
		);
		expect(html).toContain("Task status: working");
		expect(html).toContain("No final result is available");
	});
	it("does not expose a redacted final result", () => {
		const html = renderToStaticMarkup(
			<LinkedTediActivityDetails
				activity={{
					status: "available",
					activitySource: "linked_tedi_run",
					actions: [],
					finalResult: { status: "redacted", content: "hidden final" },
					truncated: false,
				}}
			/>,
		);
		expect(html).toContain("The answer is withheld");
		expect(html).not.toContain("hidden final");
	});
	it("withholds a purported final result when the run has not completed", () => {
		for (const runStatus of ["working", "failed", undefined] as const) {
			const html = renderToStaticMarkup(
				<LinkedTediActivityDetails
					activity={{
						status: "available",
						activitySource: "linked_tedi_run",
						runStatus,
						actions: [],
						finalResult: {
							status: "available",
							content: "not a terminal result",
						},
						truncated: false,
					}}
				/>,
			);
			expect(html).not.toContain("not a terminal result");
			expect(html).toContain("No final result is available");
		}
	});
	it("uses plain tool labels and does not expose opaque tool identifiers", () => {
		const opaque = "11111111-1111-4111-8111-111111111111";
		const html = renderToStaticMarkup(
			<LinkedTediActivityDetails
				activity={{
					status: "available",
					activitySource: "linked_tedi_run",
					actions: [
						{
							id: "a",
							kind: "tool.started",
							createdAt: "2026-01-01",
							toolName: "sample.get_saved_workflow",
						},
						{
							id: "b",
							kind: "tool.failed",
							createdAt: "2026-01-01",
							toolName: opaque,
						},
					],
					finalResult: { status: "unavailable" },
					truncated: false,
				}}
			/>,
		);
		expect(html).toContain("Get saved workflow");
		expect(html).toContain("Tool");
		expect(html).not.toContain(opaque);
	});
	it("describes missing verified historic linkage without displaying its raw reason", () => {
		const html = renderToStaticMarkup(
			<LinkedTediActivityDetails
				activity={{
					status: "unavailable",
					reason:
						"No verified historical link: 11111111-1111-4111-8111-111111111111",
					actions: [],
					finalResult: { status: "unavailable" },
					truncated: false,
				}}
			/>,
		);
		expect(html).toContain("Activity unavailable for this older run");
		expect(html).not.toContain("11111111-1111-4111-8111-111111111111");
	});
});
