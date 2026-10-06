import assert from "node:assert/strict";
import { classifyTediContextOverflow } from "./context-overflow";
import {
	MODEL_INPUT_BUDGET_CLIFFS,
	resolveModelInputBudgetTokens,
	TEDI_CONTEXT_WINDOW_TOKENS,
} from "./model-input-budget";

// Native compaction execution is proved by test/pi-runtime/pi.workerd.test.ts.
for (const error of [
	new Error("maximum context length exceeded"),
	{ error: { message: "context_length_exceeded" } },
	"too many input tokens",
])
	assert.equal(classifyTediContextOverflow(error), "context_overflow");
for (const error of [
	new Error("network interrupted"),
	{ status: 429 },
	undefined,
])
	assert.equal(classifyTediContextOverflow(error), undefined);
// ── Input budget resolution ─────────────────────────────────────────────────

assert.equal(
	TEDI_CONTEXT_WINDOW_TOKENS,
	200_000,
	"the documented fallback window must stay 200K",
);

// THE fallback case: an unknown model is the expected case, not an error. It
// must resolve to the window — the caller's if given, the documented constant
// otherwise — and never to a cliff belonging to some other model.
assert.equal(
	resolveModelInputBudgetTokens("azure-openai/some-unlisted-deployment"),
	TEDI_CONTEXT_WINDOW_TOKENS,
	"an unknown model must fall back to the fallback window",
);
assert.equal(
	resolveModelInputBudgetTokens(
		"azure-openai/some-unlisted-deployment",
		1_000_000,
	),
	1_000_000,
	"an unknown model with a known window must fall back to THAT window",
);
assert.equal(
	resolveModelInputBudgetTokens(undefined),
	TEDI_CONTEXT_WINDOW_TOKENS,
	"no model ref at all must fall back to the fallback window",
);
assert.equal(
	resolveModelInputBudgetTokens(null, 512_000),
	512_000,
	"no model ref with an explicit window must use that window",
);
assert.equal(
	resolveModelInputBudgetTokens("not-a-ref"),
	TEDI_CONTEXT_WINDOW_TOKENS,
	"a malformed ref must fall back rather than partially match a cliff prefix",
);

// The cliff itself: on a large-window model the budget must be the cliff, NOT
// the window. This is the whole point of the change.
assert.equal(
	resolveModelInputBudgetTokens("azure-openai/gpt-5.6-sol", 1_000_000),
	272_000,
	"a known cliff must beat a larger window",
);
// The Responses-API spelling is the ref the certified runtime stamps; matching
// only the `azure-openai/` spelling would leave tedis on that ref budgeting
// against the window.
assert.equal(
	resolveModelInputBudgetTokens("azure-openai/gpt-5.6-terra", 1_050_000),
	272_000,
	"the Responses-API model ref must reach the same cliff",
);
assert.equal(
	resolveModelInputBudgetTokens("AZURE-OPENAI/GPT-5.6-Terra"),
	272_000,
	"cliff matching must be case-insensitive",
);
assert.equal(
	resolveModelInputBudgetTokens("anthropic/claude-opus-5", 1_000_000),
	200_000,
	"a 1M-context Anthropic model must still compact at its 200K price cliff",
);
// Never budget above a window we were actually told about.
assert.equal(
	resolveModelInputBudgetTokens("azure-openai/gpt-5.6-luna", 128_000),
	128_000,
	"a cliff above an explicit window must be capped by that window",
);

// Every cliff must carry its provenance: the table is only defensible if each
// number names where it came from.
assert.ok(
	MODEL_INPUT_BUDGET_CLIFFS.length > 0,
	"the cliff table must not be empty",
);
for (const entry of MODEL_INPUT_BUDGET_CLIFFS) {
	assert.ok(
		entry.refPrefix.length > 0,
		"every cliff entry must name a ref prefix",
	);
	assert.ok(
		entry.inputBudgetTokens > 0,
		`cliff ${entry.refPrefix} must carry a positive budget`,
	);
	assert.ok(
		entry.because.trim().length > 20,
		`cliff ${entry.refPrefix} must justify its number`,
	);
}
