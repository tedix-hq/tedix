/**
 * veo-generate-video — executable skill workflow (async video generation).
 *
 * Generates a short video with Google Veo directly from a skill workflow.
 * Veo is asynchronous: submit a long-running operation, then poll until done —
 * the canonical fit for a durable workflow (`step.do` checkpoints + `step.sleep`
 * hibernation between polls, at near-zero cost).
 *
 * Endpoint: Veo's `:predictLongRunning` requires the PROJECT-scoped Vertex path
 * (the express `publishers/google` path returns RESOURCE_PROJECT_INVALID), so
 * the operator supplies its configured project + location endpoint. `capabilities.network: true` lets this
 * call out; the skill-runtime OutboundProxy injects the platform Agent Platform
 * service account is exchanged for a short-lived OAuth token for the regional
 * `*-aiplatform.googleapis.com` host — billed to the project's Cloud account.
 *
 * VALIDATION SCOPE: returns an organization-owned R2 asset receipt — never
 * inline video bytes. The shared media bridge fetches the completed Vertex
 * operation, decodes the inline base64 as a stream, writes it directly to R2,
 * and returns only `{ r2Key, sizeBytes }` to durable Workflow state.
 *
 * params: { vertexEndpoint: string, prompt?: string, model?: string, durationSeconds?: number, aspectRatio?: string }
 */

export default {
	async run(event, step, env) {
		const VEO = event.payload?.vertexEndpoint;
		if (
			typeof VEO !== "string" ||
			!/^https:\/\/[a-z0-9-]+-aiplatform\.googleapis\.com\/v1\/projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/publishers\/google\/models$/.test(
				VEO,
			)
		) {
			return {
				ok: false,
				stage: "configuration",
				error:
					"vertexEndpoint must match the operator-configured project-scoped Vertex endpoint",
			};
		}
		const prompt =
			event.payload?.prompt ??
			"a calm ocean wave at sunset, cinematic, slow motion";
		const model = event.payload?.model ?? "veo-3.0-generate-001";
		const durationSeconds = event.payload?.durationSeconds ?? 4;
		const aspectRatio = event.payload?.aspectRatio ?? "16:9";

		// Submit the long-running operation.
		const submit = await step.do(
			"submit",
			{ timeout: "60 seconds" },
			async () => {
				const res = await fetch(`${VEO}/${model}:predictLongRunning`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						instances: [{ prompt }],
						parameters: { aspectRatio, sampleCount: 1, durationSeconds },
					}),
				});
				const b = await res.json().catch(() => ({}));
				return {
					ok: res.ok,
					status: res.status,
					opName: b?.name ?? null,
					error: b?.error?.message
						? String(b.error.message).slice(0, 300)
						: null,
				};
			},
		);
		if (!submit.ok || !submit.opName) {
			return {
				endpoint: "vertex-veo",
				model,
				ok: false,
				stage: "submit",
				...submit,
			};
		}

		// Durable poll loop — step.sleep hibernates between checks; each poll is
		// its own durable step. Polls return {done} only (tiny). Veo ~1–3 min.
		let done = false;
		let polls = 0;
		for (let i = 0; i < 16; i++) {
			polls = i + 1;
			const p = await step.do(
				`poll-${i}`,
				{ timeout: "30 seconds" },
				async () => {
					const res = await fetch(
						"https://video-assets.tedix.internal/poll-vertex-veo",
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ model, operationName: submit.opName }),
						},
					);
					const op = await res.json().catch(() => ({}));
					return { done: res.ok && !!op?.done };
				},
			);
			if (p.done) {
				done = true;
				break;
			}
			await step.sleep(`wait-${i}`, "15 seconds");
		}
		if (!done) {
			return {
				endpoint: "vertex-veo",
				model,
				prompt,
				ok: false,
				polls,
				video: { note: "not ready within poll budget (16 × 15s)" },
			};
		}

		const asset = await step.do(
			"import-video-to-r2",
			{ timeout: "60 seconds" },
			async () => {
				const res = await fetch(
					"https://video-assets.tedix.internal/import-vertex-veo",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ model, operationName: submit.opName }),
					},
				);
				const receipt = await res.json().catch(() => ({}));
				if (!res.ok) {
					return { ok: false, error: receipt?.error ?? `status ${res.status}` };
				}
				return {
					ok: true,
					r2Key: receipt.r2Key,
					sizeBytes: receipt.sizeBytes,
				};
			},
		);

		return {
			endpoint: "vertex-veo",
			model,
			prompt,
			ok: asset.ok,
			polls,
			video: asset.ok
				? {
						r2Key: asset.r2Key,
						bytes: asset.sizeBytes,
					}
				: { error: asset.error },
		};
	},
};
