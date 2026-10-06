import assert from "node:assert/strict";
import {
	resolveModelInputBudgetTokens,
	TEDI_CONTEXT_WINDOW_TOKENS,
} from "./model-input-budget";
assert.equal(
	resolveModelInputBudgetTokens("workers-ai/@cf/openai/gpt-oss-120b"),
	TEDI_CONTEXT_WINDOW_TOKENS,
);
assert.equal(
	resolveModelInputBudgetTokens("workers-ai/@cf/openai/gpt-oss-120b", 128_000),
	128_000,
);
assert.equal(
	resolveModelInputBudgetTokens("azure-openai/gpt-5.6-terra"),
	272_000,
);
assert.equal(
	resolveModelInputBudgetTokens("azure-openai/gpt-5.6-terra", 100_000),
	100_000,
);
assert.equal(
	resolveModelInputBudgetTokens("anthropic/claude", 1_000_000),
	200_000,
);
for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
	assert.equal(
		resolveModelInputBudgetTokens(`azure-openai/${model}`, 1_050_000),
		272_000,
	);
	assert.equal(
		resolveModelInputBudgetTokens(`azure-openai/${model}`, 100_000),
		100_000,
	);
}
console.log("Model input budget OK");
