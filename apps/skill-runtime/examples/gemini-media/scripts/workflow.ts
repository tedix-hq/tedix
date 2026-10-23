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
 * STORAGE NOTE: the image is returned as base64 from `generate-image`. After
 * the durable step resolves, the dispatch shim decodes and stores the raw
 * bytes as `outputs/generate-image.media`. No large bridge RPC runs inside the
 * step, and the run summary stays light.
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

		// Step 2 — image generation. The shim persists its raw media after this
		// durable step resolves.
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

		// Light reference-only summary (no base64).
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
						artifactPath: "outputs/generate-image.media",
					}
				: { ok: false, status: image.status, error: image.error },
		};
	},
};
