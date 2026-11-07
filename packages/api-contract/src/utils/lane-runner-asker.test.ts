import { expect, it } from "vite-plus/test";
import { laneRunnerAsker } from "./lane-runner-asker";

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
