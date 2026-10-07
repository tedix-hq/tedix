/** Standalone assertions for canonical per-surface model policy resolution. */
import assert from "node:assert/strict";
import { CLOUDFLARE_AUTO_MODEL_REF } from "@tedix/api-contract/schemas/model-catalog";
import { selectAzureDeployment } from "./ai-sdk-adapter";
import {
	DEFAULT_TEDI_MODEL_POLICY,
	modelOverrideForSurface,
	normalizeModelPolicy,
	resolveSurfaceModelRef,
} from "./model-policy";

const CHAT_REF = "azure-openai/gpt-5.6-terra";
const CRON_REF = "azure-openai/gpt-5.6-luna";
const OBSERVER_REF = "azure-openai/gpt-5.6-luna";

for (const surface of ["chat", "cron"] as const) {
	assert.equal(
		resolveSurfaceModelRef(undefined, surface),
		CLOUDFLARE_AUTO_MODEL_REF,
	);
	assert.deepEqual(modelOverrideForSurface(undefined, surface), {
		modelRef: CLOUDFLARE_AUTO_MODEL_REF,
	});
	assert.equal(
		resolveSurfaceModelRef(DEFAULT_TEDI_MODEL_POLICY, surface),
		CLOUDFLARE_AUTO_MODEL_REF,
	);
}

// The observer never runs on the Auto Router: a missing policy, the default
// policy, and a stored (D1-backfilled) `cloudflare/auto` observer ref all
// resolve to "unset", i.e. the observer's own env default deployment.
const storedAutoObserver = normalizeModelPolicy({
	chatModelRef: CLOUDFLARE_AUTO_MODEL_REF,
	cronModelRef: CLOUDFLARE_AUTO_MODEL_REF,
	observerModelRef: CLOUDFLARE_AUTO_MODEL_REF,
});
for (const observerPolicy of [
	undefined,
	DEFAULT_TEDI_MODEL_POLICY,
	storedAutoObserver,
]) {
	assert.equal(resolveSurfaceModelRef(observerPolicy, "observer"), null);
	assert.equal(modelOverrideForSurface(observerPolicy, "observer"), undefined);
}
// Chat and cron keep `cloudflare/auto` from the same stored policy.
assert.equal(
	resolveSurfaceModelRef(storedAutoObserver, "chat"),
	CLOUDFLARE_AUTO_MODEL_REF,
);
assert.equal(
	resolveSurfaceModelRef(storedAutoObserver, "cron"),
	CLOUDFLARE_AUTO_MODEL_REF,
);
// With no override, the observer's Azure deployment is the env default.
assert.equal(
	selectAzureDeployment(
		{ AZURE_CHAT_DEPLOYMENT: "gpt-5.6-terra" },
		modelOverrideForSurface(storedAutoObserver, "observer"),
	),
	"gpt-5.6-terra",
);
// An explicit non-auto observer ref is kept, even beside an auto chat ref.
assert.deepEqual(
	modelOverrideForSurface(
		normalizeModelPolicy({
			chatModelRef: CLOUDFLARE_AUTO_MODEL_REF,
			cronModelRef: CLOUDFLARE_AUTO_MODEL_REF,
			observerModelRef: "workers-ai/@cf/openai/gpt-oss-120b",
		}),
		"observer",
	),
	{ modelRef: "workers-ai/@cf/openai/gpt-oss-120b" },
);

assert.deepEqual(normalizeModelPolicy(null), DEFAULT_TEDI_MODEL_POLICY);
assert.deepEqual(normalizeModelPolicy(undefined), DEFAULT_TEDI_MODEL_POLICY);
assert.throws(() => normalizeModelPolicy({ chatModelRef: CHAT_REF } as never));

const policy = normalizeModelPolicy({
	chatModelRef: CHAT_REF,
	cronModelRef: CRON_REF,
	observerModelRef: OBSERVER_REF,
});
assert.equal(resolveSurfaceModelRef(policy, "chat"), CHAT_REF);
assert.equal(resolveSurfaceModelRef(policy, "cron"), CRON_REF);
assert.equal(resolveSurfaceModelRef(policy, "observer"), OBSERVER_REF);

const pinned = normalizeModelPolicy({
	chatModelRef: CHAT_REF,
	cronModelRef: CHAT_REF,
	observerModelRef: CHAT_REF,
});
assert.deepEqual(modelOverrideForSurface(pinned, "cron"), {
	modelRef: CHAT_REF,
});

// An adaptive ref on a fixed-model-only call site resolves to that call site's
// fixed Azure deployment. Adaptive execution requires a compatible context.
assert.equal(
	selectAzureDeployment(
		{ AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna" },
		modelOverrideForSurface(DEFAULT_TEDI_MODEL_POLICY, "chat"),
	),
	"gpt-5.6-luna",
);

console.log("model-policy.test.ts: all assertions passed");
