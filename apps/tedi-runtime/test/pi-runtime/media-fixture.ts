import {
	persistWorkflowImages,
	describeWorkflowImages,
	cleanupWorkflowImages,
	type WorkflowImageRef,
	workflowImageUri,
} from "../../src/workflow-image-handoff";

import {
	ConversationFacet,
	type ConversationTurnConfiguration,
} from "../../src/conversation-facet";
import type { LanguageModelV4 } from "@ai-sdk/provider";

/** Inherit the real conversation policy; no parent RPC is needed for storage. */
export class PiFacetMediaFixture extends ConversationFacet {
	// Standalone media loop fixture: no registered parent custody or admission proof.
	protected override facetAdmissionClassName(): string | null {
		return null;
	}
	private async assertImageOwner(
		runId: string,
		refs: WorkflowImageRef[],
	): Promise<() => void> {
		const owner = await this.ctx.storage.get<{
			tediId: string;
			orgId: string;
			sessionKey: string;
			runId: string;
			refs: WorkflowImageRef[];
		}>(`fixture:image-owner:${runId}`);
		if (
			!owner ||
			JSON.stringify(owner) !==
				JSON.stringify({
					tediId: "image-tedi",
					orgId: "image-org",
					sessionKey: "images",
					runId,
					refs,
				})
		)
			throw new Error("Original media fixture owner changed");
		if (await this.ctx.storage.get("fixture:image-held"))
			throw new Error("Media fixture held");
		return () => {
			if (
				this.ctx.storage.kv.get("fixture:image-held") ||
				JSON.stringify(
					this.ctx.storage.kv.get(`fixture:image-owner:${runId}`),
				) !== JSON.stringify(owner)
			)
				throw new Error("Media fixture held or owner changed");
		};
	}

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		Object.assign(this, {
			parentAgent: async () => ({
				enrollFacetDispatchRun: async () => {},
				assertChatTurnActive: async () => {},
				reservePiStep: async (input: { estimatedTokens: number }) => {
					await this.ctx.storage.put("fixture:estimate", input.estimatedTokens);
				},
				recordPiStep: async () => {},
				reconcileFacetToolEffect: async () => null,
				recordFacetModelStep: async () => {},
				checkFacetTurnBudget: async () => ({ abort: false }),
			}),
			generationSettings: () => ({
				requested: {},
				resolved: null,
				turnConfig: {},
			}),
		});
	}
	protected selectModelForTurn() {
		return {
			model: this.imageModel(),
			identity: {
				provider: "workers-ai" as const,
				model: "@cf/private-images",
			},
		};
	}
	private imageModel(): LanguageModelV4 {
		return {
			specificationVersion: "v4",
			provider: "local-fixture",
			modelId: "private-images",
			supportedUrls: {},
			doGenerate: async () => {
				throw new Error("stream only");
			},
			doStream: async ({ prompt }) => {
				const images: Array<{ bytes: number; last: number }> = [];
				const notes: string[] = [];
				for (const message of prompt) {
					if (typeof message.content === "string") continue;
					for (const part of message.content) {
						if (part.type === "text") {
							if (
								part.text.includes("image from an earlier turn") ||
								part.text.includes("same attached image")
							)
								notes.push(part.text);
							continue;
						}
						if (part.type !== "file" || part.data.type !== "data") continue;
						const bytes =
							typeof part.data.data === "string"
								? atob(part.data.data)
								: part.data.data;
						images.push({
							bytes: bytes.length,
							last:
								typeof bytes === "string"
									? bytes.charCodeAt(bytes.length - 1)
									: bytes.at(-1)!,
						});
					}
				}
				const calls =
					((await this.ctx.storage.get<number>("fixture:calls")) ?? 0) + 1;
				await this.ctx.storage.put("fixture:calls", calls);
				await this.ctx.storage.put("fixture:model-input", { images, notes });
				return {
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							controller.enqueue({ type: "text-start", id: "answer" });
							controller.enqueue({
								type: "text-delta",
								id: "answer",
								delta: "images received",
							});
							controller.enqueue({ type: "text-end", id: "answer" });
							controller.enqueue({
								type: "finish",
								finishReason: { unified: "stop", raw: "stop" },
								usage: {
									inputTokens: {
										total: 4,
										noCache: 4,
										cacheRead: 0,
										cacheWrite: 0,
									},
									outputTokens: { total: 2, text: 2, reasoning: 0 },
								},
							});
							controller.close();
						},
					}),
				};
			},
		};
	}
	private imageInput(runId: string, refs: WorkflowImageRef[]) {
		return {
			configuration: {
				system: "Fixture",
				modelRef: null,
				aigMetadata: { tediId: "image-tedi", orgId: "image-org" },
				sessionKey: "images",
				runId,
				maxSteps: null,
				toolDescriptors: [],
			},
			text: "Inspect every image",
			imageRefs: refs,
			durableSubmissionId: `${runId}:segment:0`,
		};
	}
	async seedImages(runId: string, count = 4, size = 5 * 1024 * 1024) {
		const images = [];
		for (let i = 0; i < count; i++) {
			const bytes = new Uint8Array(size);
			bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
			bytes[size - 1] = i + 1;
			let binary = "";
			for (let offset = 0; offset < bytes.length; offset += 32768)
				binary += String.fromCharCode(
					...bytes.subarray(offset, offset + 32768),
				);
			images.push({
				kind: "base64" as const,
				data: btoa(binary),
				mediaType: "image/png",
				fileName: `image-${i}.png`,
			});
		}
		const described = await describeWorkflowImages("image-tedi", runId, images);
		const owner = {
			tediId: "image-tedi",
			orgId: "image-org",
			sessionKey: "images",
			runId,
			refs: described,
		};
		const original = await this.ctx.storage.get(`fixture:image-owner:${runId}`);
		if (original && JSON.stringify(original) !== JSON.stringify(owner))
			throw new Error("Original media fixture owner changed");
		await this.ctx.storage.put(`fixture:image-owner:${runId}`, owner);
		const refs = await persistWorkflowImages(
			(this.env as unknown as { TEDI_STORAGE: R2Bucket }).TEDI_STORAGE,
			"image-tedi",
			runId,
			images,
			() => this.assertImageOwner(runId, described),
		);
		await this.ctx.storage.put(`fixture:refs:${runId}`, refs);
		return refs;
	}
	async stageImages(runId: string) {
		const refs = (await this.ctx.storage.get<WorkflowImageRef[]>(
			`fixture:refs:${runId}`,
		))!;
		const input = this.imageInput(runId, refs);
		const configured = await (
			this as unknown as {
				configureConversationTurn(
					config: ConversationTurnConfiguration,
				): Promise<number>;
			}
		).configureConversationTurn(input.configuration);
		this.setState({ ...this.state, imageRefs: refs });
		await this.ctx.storage.put("pi-facet-pending-submission", {
			configuration: input.configuration,
			submissionId: input.durableSubmissionId,
			priorTurnCount: configured,
			turnInput: { text: input.text, imageRefs: refs },
		});
		await this.submitMessages(
			[
				{
					role: "user",
					parts: [
						{ type: "text", text: input.text },
						...refs.map((ref) => ({
							type: "file" as const,
							mediaType: ref.mediaType,
							filename: ref.fileName,
							url: workflowImageUri(ref),
						})),
					],
					id: `${input.durableSubmissionId}:user`,
				} as never,
			],
			{
				submissionId: input.durableSubmissionId,
			},
		);
		await this.waitForSubmission(input.durableSubmissionId);
		return this.inspectImageRows();
	}
	async finishImages(runId: string) {
		const refs = (await this.ctx.storage.get<WorkflowImageRef[]>(
			`fixture:refs:${runId}`,
		))!;
		return this.runConfiguredConversationTurn(this.imageInput(runId, refs));
	}
	async continueImages(runId: string) {
		const refs = (await this.ctx.storage.get<WorkflowImageRef[]>(
			`fixture:refs:${runId}`,
		))!;
		return this.runConfiguredConversationTurn({
			...this.imageInput(runId, refs),
			durableSubmissionId: `${runId}:segment:1`,
		});
	}
	async invalidImages(runId: string, mode: "missing" | "foreign") {
		const refs = (await this.ctx.storage.get<WorkflowImageRef[]>(
			`fixture:refs:${runId}`,
		))!;
		if (mode === "missing")
			await (
				this.env as unknown as { TEDI_STORAGE: R2Bucket }
			).TEDI_STORAGE.delete(refs[0]!.key);
		else refs[0]!.key = refs[0]!.key.replace("/image-tedi/", "/foreign-tedi/");
		try {
			await this.runConfiguredConversationTurn(this.imageInput(runId, refs));
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		throw new Error("invalid image unexpectedly inferred");
	}
	async cleanedHistory(runId: string) {
		const refs = (await this.ctx.storage.get<WorkflowImageRef[]>(
			`fixture:refs:${runId}`,
		))!;
		await cleanupWorkflowImages(
			(this.env as unknown as { TEDI_STORAGE: R2Bucket }).TEDI_STORAGE,
			"image-tedi",
			runId,
			{
				cursor: null,
				allowedKeys: [
					...refs.map((ref) => ref.key),
					`__runtime/workflow-images/image-tedi/${encodeURIComponent(runId)}/manifest.json`,
				],
				assertReady: () => this.assertImageOwner(runId, refs),
				issued: async (page) => {
					await this.ctx.storage.put(`fixture:image-delete:${runId}`, {
						page,
						stage: "issued",
					});
				},
				acknowledged: async (page) => {
					await this.ctx.storage.put(`fixture:image-delete:${runId}`, {
						page,
						stage: "acknowledged",
					});
				},
			},
		);
		return this.runConfiguredConversationTurn(
			this.imageInput(`${runId}:next`, []),
		);
	}
	async inspectImageRows() {
		const pending = await this.ctx.storage.get("pi-facet-pending-submission");
		return {
			estimate: await this.ctx.storage.get<number>("fixture:estimate"),
			calls: await this.ctx.storage.get<number>("fixture:calls"),
			input: await this.ctx.storage.get<{
				images: Array<{ bytes: number; last: number }>;
				notes: string[];
			}>("fixture:model-input"),
			pendingBytes: JSON.stringify(pending ?? null).length,
			stateBytes: JSON.stringify(this.state).length,
			submissionBytes: JSON.stringify(
				await (
					await this.piHarness.storage()
				).submissionByRequest(
					(await this.nativeConversation()).id,
					`${this.state.runId}:segment:0`,
					{
						abortSignal: undefined,
						value: () => undefined,
						toString: () => "media-fixture",
					},
				),
			).length,
			historyBytes: JSON.stringify(await this.historyMessages()).length,
		};
	}
}
