/**
 * gemini-generate-media — executable skill workflow.
 *
 * Generates an image with Google Gemini directly from a skill workflow,
 * bypassing the tedi runtime provider config. Uses the **Vertex AI express**
 * endpoint (`aiplatform.googleapis.com`), billed to the GCP project's Cloud
 * billing account (`usageMetadata.trafficType` reported back as evidence).
 *
 * `capabilities.network: true` lets this code call Gemini over plain `fetch()`
 * inside `step.do(...)`. The skill-runtime OutboundProxy injects the
 * platform-global Agent Platform API key as `x-goog-api-key` by host — so this
 * code never sees the key, and the key never lands in the persisted Workflow
 * payload.
 *
 * STORAGE NOTE: the raw image bytes are returned (base64) as the
 * `generate-image` step value, which the dispatch shim auto-persists outside
 * the durable step as artifact `outputs/generate-image.json`. We deliberately
 * do not call a bridge write (env.artifacts.writeBlob) from inside `step.do` —
 * a large-payload bridge RPC inside a Workflow step stalls the step (verified:
 * a run sat in `running` past the 120s step timeout). The proper raw-bytes path
 * is a shim post-step hook (TODO), where large bridge writes are proven safe.
 * The run() summary stays light (no base64). Consumers read the bytes via
 * get_skill_run_artifact({ runId, path: "outputs/generate-image.json" }) →
 * .value.imageBase64 (base64-decode to the PNG).
 *
 * params: { prompt?: string, model?: string }
 */

const VERTEX = "https://aiplatform.googleapis.com/v1/publishers/google/models";

export default {
	async run(event, step) {
		const prompt =
			event.payload?.prompt ??
			"A tiny friendly robot mascot, flat vector logo, white background";
		const model = event.payload?.model ?? "gemini-3.1-flash-image-preview";

		// Step 1 — credential + billing probe (proves the platform key reached
		// Vertex; trafficType is echoed back as billing evidence).
		const auth = await step.do("probe", { timeout: "30 seconds" }, async () => {
			const res = await fetch(`${VERTEX}/gemini-2.5-flash:generateContent`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ role: "user", parts: [{ text: "Reply with: OK" }] }],
				}),
			});
			const body = await res.json().catch(() => ({}));
			return {
				ok: res.ok,
				status: res.status,
				trafficType: body?.usageMetadata?.trafficType ?? null,
			};
		});

		// Step 2 — image generation. Returns the base64 PNG as the step value;
		// the shim persists it to outputs/generate-image.json (R2 spill).
		const image = await step.do(
			"generate-image",
			{ timeout: "120 seconds" },
			async () => {
				const res = await fetch(`${VERTEX}/${model}:generateContent`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [{ role: "user", parts: [{ text: prompt }] }],
						generationConfig: { responseModalities: ["IMAGE"] },
					}),
				});
				if (!res.ok) {
					const err = await res.text().catch(() => "");
					return { ok: false, status: res.status, error: err.slice(0, 500) };
				}
				const data = await res.json();
				const parts = data?.candidates?.[0]?.content?.parts ?? [];
				const inline = parts.find((p) => p.inlineData)?.inlineData;
				if (!inline?.data) {
					return {
						ok: false,
						status: res.status,
						error: "no inlineData in response",
					};
				}
				return {
					ok: true,
					status: res.status,
					mimeType: inline.mimeType ?? "image/png",
					imageBase64: inline.data,
					bytes: Math.floor((inline.data.length * 3) / 4),
				};
			},
		);

		// Light reference-only summary (no base64). The image lives in the
		// generate-image artifact; consumers fetch + decode it by runId.
		return {
			endpoint: "vertex-express",
			model,
			prompt,
			credentialInjection: auth.ok
				? "verified"
				: `failed (HTTP ${auth.status})`,
			billedTo: auth.trafficType,
			image: image.ok
				? {
						ok: true,
						mimeType: image.mimeType,
						bytes: image.bytes,
						artifactPath: "outputs/generate-image.json",
					}
				: { ok: false, status: image.status, error: image.error },
		};
	},
};
