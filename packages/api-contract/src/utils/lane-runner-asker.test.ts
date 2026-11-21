import { expect, it } from "vite-plus/test";
import { laneApprovalTitle, laneRunnerAsker } from "./lane-runner-asker";

it.each([
	undefined,
	null,
	{},
	{ laneBlocker: { executor: "codex" } },
	{ source: "unrelated", laneBlocker: { executor: "codex" } },
	{ source: "lane-dispatch-blocker", laneBlocker: null },
	{ source: "lane-dispatch-blocker", laneBlocker: { executor: "unknown" } },
])(
	"does not invent a runner for malformed or unrelated metadata: %j",
	(metadata) => {
		expect(laneRunnerAsker(metadata)).toBeUndefined();
	},
);

it("names each requested action before the task, including when several sentences mention the same action", () => {
	const title = laneApprovalTitle(
		{
			source: "lane-dispatch-blocker",
			laneBlocker: {
				matchedActions: ["delete_data", "public_publish", "delete_data"].map(
					(action) => ({ action }),
				),
			},
		},
		"Retire the sample catalog",
	);
	expect(title).toBe(
		"Delete live data and publish something publicly for “Retire the sample catalog”?",
	);
});
