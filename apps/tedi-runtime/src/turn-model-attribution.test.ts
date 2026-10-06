import assert from "node:assert/strict";
import { attributableConversationModel } from "./turn-model-attribution";

const azure = { provider: "azure-openai" as const, model: "gpt-5.6-terra" };
const workers = { provider: "workers-ai" as const, model: "@cf/example" };

assert.deepEqual(
	attributableConversationModel({
		selectedModels: [azure, { ...azure }],
		hasFreshText: true,
		stopped: false,
	}),
	azure,
);
for (const input of [
	{ selectedModels: [], hasFreshText: true, stopped: false },
	{ selectedModels: [azure], hasFreshText: false, stopped: false },
	{ selectedModels: [azure], hasFreshText: true, stopped: true },
	{ selectedModels: [azure, workers], hasFreshText: true, stopped: false },
	{
		selectedModels: [azure, { ...azure, model: "another-model" }],
		hasFreshText: true,
		stopped: false,
	},
]) {
	assert.equal(attributableConversationModel(input), null);
}
