import type {
	SkillWorkflowRunTimeline,
	SkillWorkflowTimelineEvent,
} from "@tedix/api-contract/schemas/cognitive";

export function runTimelineFixture(
	run: SkillWorkflowRunTimeline["run"],
): SkillWorkflowRunTimeline {
	const start = Date.parse(run.startedAt!);
	const time = (offset: number) => new Date(start + offset).toISOString();
	const events: SkillWorkflowTimelineEvent[] = Array.from(
		{ length: 250 },
		(_, index) => ({
			schemaVersion: 1,
			id: `calls/storefront/list_orders/${index + 1}.json`,
			path: `calls/storefront/list_orders/${index + 1}.json`,
			executionEpoch: run.executionEpoch,
			kind: index % 2 === 0 ? "mcp" : "network",
			name:
				index % 2 === 0
					? `storefront.list_orders ${index + 1}`
					: `GET api.storefront.example ${index + 1}`,
			count: index + 1,
			attempt: 1,
			lane:
				index % 2 === 0 ? "storefront.list_orders" : "api.storefront.example",
			startedAt: time(index * 500),
			endedAt: time(index * 500 + (index === 0 ? 2000 : 300)),
			durationMs: index === 0 ? 2000 : 300,
			status: index === 3 ? "failed" : "succeeded",
			outcome: index === 3 ? "failure" : "success",
			...(index % 2 === 0
				? { namespace: "storefront", method: "list_orders" }
				: {
						host: "api.storefront.example",
						method: "GET",
						httpStatus: index === 3 ? 503 : 200,
					}),
		}),
	);
	events.push({
		schemaVersion: 1,
		id: "waits/approval.json",
		path: "waits/approval.json",
		executionEpoch: run.executionEpoch,
		kind: "wait",
		name: "Publish approval",
		count: 1,
		lane: "Waits",
		startedAt: time(10000),
		endedAt: time(50000),
		durationMs: 40000,
		status: "resolved",
		outcome: "success",
	});
	return {
		run,
		coverage: "complete",
		events,
		lanes: [
			{
				id: "storefront.list_orders",
				label: "storefront.list_orders",
				kind: "mcp",
			},
			{
				id: "api.storefront.example",
				label: "api.storefront.example",
				kind: "network",
			},
			{ id: "Waits", label: "Waits", kind: "wait" },
		],
		phases: [],
		truncated: false,
		warnings: [],
	};
}

export function runTimelineArtifactFixture(path: string) {
	const failure = path === "calls/storefront/list_orders/4.json";
	return {
		path,
		mimeType: "application/json",
		sizeBytes: 10000,
		outcome: failure ? "failure" : "success",
		attempt: 1,
		r2Available: false,
		content: JSON.stringify(
			failure
				? {
						error: {
							message: "Storefront temporarily unavailable",
							status: 503,
						},
					}
				: {
						response: {
							orders: Array.from({ length: 100 }, (_, index) => ({
								id: `sample-order-${index}`,
								status: "paid",
								total: 120,
							})),
						},
					},
		),
	};
}
