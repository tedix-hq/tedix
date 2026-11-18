import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { cases } from "./cases";

const selector = process.env.AGENT_GATE_SELECTOR
	? pathToFileURL(resolve(process.env.AGENT_GATE_SELECTOR)).href
	: new URL(
			"../../../packages/cli/src/hooks/lesson-selection.ts",
			import.meta.url,
		).href;
const { selectPromptLessons } = await import(selector);
const fixture = cases.find((c) => c.id === process.argv[2]);
if (!fixture) throw new Error("Unknown evaluation case");
const result = await selectPromptLessons(fixture.lessons, fixture.context);
console.log(JSON.stringify(result.selectedLessonIds));
