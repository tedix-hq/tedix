/** A provider callback selects persisted authority; parameters never grant it. */
type Receipt = {
	outcome: "confirmed" | "partial" | "conflict";
	mutations: { state: "intent" | "confirmed" | "uncertain" | "conflict" }[];
};
type Step = {
	do<T>(
		name: string,
		options: { retries: { limit: number }; timeout: "5 minutes" },
		callback: () => Promise<T>,
	): Promise<T>;
};
type Environment = {
	MCP: {
		os: {
			reconcile_calendar_subscription(input: {
				subscriptionId: string;
				expectedSkillRevision: number;
			}): Promise<Receipt>;
		};
	};
};
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export default {
	async run(
		event: {
			payload?: {
				providerEvent?: { subscriptionId?: unknown; skillRevision?: unknown };
			};
		},
		step: Step,
		env: Environment,
	) {
		const trigger = event.payload?.providerEvent;
		if (
			typeof trigger?.subscriptionId !== "string" ||
			!UUID.test(trigger.subscriptionId) ||
			!Number.isSafeInteger(trigger.skillRevision) ||
			Number(trigger.skillRevision) < 1
		)
			throw new Error(
				"A persisted provider subscription and reviewed skill revision are required",
			);
		const subscriptionId = trigger.subscriptionId;
		const expectedSkillRevision = Number(trigger.skillRevision);
		return step.do(
			"reconcile-selected-calendars",
			{ retries: { limit: 0 }, timeout: "5 minutes" },
			async () => {
				const receipt = await env.MCP.os.reconcile_calendar_subscription({
					subscriptionId,
					expectedSkillRevision,
				});
				if (
					receipt?.outcome !== "confirmed" ||
					!Array.isArray(receipt.mutations) ||
					receipt.mutations.some((mutation) => mutation.state !== "confirmed")
				)
					throw new Error(
						"Calendar synchronization needs attention; inspect the workspace receipt before retrying",
					);
				return {
					outcome: "confirmed" as const,
					confirmedChanges: receipt.mutations.length,
				};
			},
		);
	},
};
