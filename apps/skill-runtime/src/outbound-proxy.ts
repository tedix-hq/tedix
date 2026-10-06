/**
 * Platform outbound credential-injection proxy for `network: true` skill
 * workflows.
 *
 * Skill workflows that declare `capabilities.network: true` are loaded with a
 * Worker Loader `globalOutbound` set to a stub of this entrypoint instead of
 * the raw default outbound. Every `fetch()` the tenant code makes flows
 * through {@link OutboundProxy.fetch}, which injects the platform-managed API
 * key for recognized provider hosts before forwarding the request upstream.
 *
 * Why a proxy rather than handing the key to tenant code:
 *
 *  - The Cloudflare `dynamic-workflows` guidance is explicit that the
 *    dispatcher envelope (metadata + params) is *persisted* and readable via
 *    `instance.status()`, so secrets must never travel in it
 *    (https://blog.cloudflare.com/dynamic-workflows/ — "treat the metadata as
 *    a routing hint, not as authorization … Don't put secrets in there").
 *  - The key lives only in this entrypoint's `ctx.props`, which runs in the
 *    dispatcher Worker (loader-side). The tenant isolate receives a Fetcher
 *    RPC stub, never the raw secret — the same pattern the tedi runtime uses
 *    when its `TediSandbox` injects Azure `api-key` headers at the Worker
 *    layer (see CLAUDE.md "Outbound HTTP interception"). Key rotation takes
 *    effect on the next run with no tenant code change.
 *
 * Injection is host-scoped: only allow-listed provider hosts receive a
 * credential header. Any other host the tenant reaches is forwarded
 * unmodified (the skill already opted into `network: true`), so this proxy
 * never leaks a platform key to an arbitrary destination.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { sha256 as createSha256 } from "@noble/hashes/sha2.js";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	vertexInlineVideoByteLength,
	vertexInlineVideoStream,
	vertexOperationDone,
} from "./vertex-inline-video";
import {
	extractJudgeJson,
	isOrganizationOwnedJudgeVideoKey,
	MAX_JUDGE_VIDEO_BYTES,
	validateReferenceImages,
	videoJudgePrompt,
	videoJudgeResponseSchema,
} from "./vertex-video-judge";
import {
	extractGeminiKeyframe,
	geminiProductKeyframeRequest,
	assertApprovedKeyframe,
	keyframeJudgePrompt,
	keyframeJudgeResponseSchema,
	parseAndEnforceKeyframeJudgment,
	PRODUCT_KEYFRAME_FIDELITY_THRESHOLD,
	type KeyframeGateReceipt,
	validateProductKeyframeRequest,
	validateVeoAssetReferenceRequest,
	validateVeoBackgroundRequest,
	assertApprovedKeyframePair,
	veoAssetReferenceRequest,
	veoBackgroundRequest,
} from "./vertex-product-keyframes";
import type { SkillRuntimeEnv } from "./env";
import { isVertexHost, isVertexRegionalHost } from "./vertex-host";

/** Platform credentials handed to the proxy via `ctx.props` (loader-side). */
export interface OutboundProxyProps {
	/** Gemini / Google Generative AI API key (Worker secret `GEMINI_API_KEY`). */
	geminiApiKey?: string | null;
	/** Google service-account JSON used only to mint Vertex OAuth tokens. */
	googleServiceAccountKey?: string | null;
	/** Owning organization, used to namespace imported media in R2. */
	organizationId?: string | null;
	/** Vertex model collection endpoint used by the media bridge. */
	vertexVideoEndpoint?: string | null;
}

interface CachedGoogleToken {
	token: string;
	expiresAt: number;
	principal: string;
}

let googleTokenCache: CachedGoogleToken | null = null;

function base64url(value: string | ArrayBuffer): string {
	const bytes =
		typeof value === "string"
			? new TextEncoder().encode(value)
			: new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getGoogleAccessToken(
	serviceAccountKeyJson: string,
): Promise<string> {
	const serviceAccount = JSON.parse(serviceAccountKeyJson) as {
		client_email?: string;
		private_key?: string;
	};
	if (!serviceAccount.client_email || !serviceAccount.private_key) {
		throw new Error(
			"GOOGLE_SERVICE_ACCOUNT_KEY is missing client_email or private_key",
		);
	}

	const now = Math.floor(Date.now() / 1000);
	if (
		googleTokenCache?.principal === serviceAccount.client_email &&
		googleTokenCache.expiresAt - 60 > now
	) {
		return googleTokenCache.token;
	}

	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			iss: serviceAccount.client_email,
			scope: "https://www.googleapis.com/auth/cloud-platform",
			aud: "https://oauth2.googleapis.com/token",
			iat: now,
			exp: now + 3600,
		}),
	);
	const pem = serviceAccount.private_key
		.replace(/-----(?:BEGIN|END) PRIVATE KEY-----/g, "")
		.replace(/\s/g, "");
	const keyBytes = Uint8Array.from(atob(pem), (character) =>
		character.charCodeAt(0),
	);
	const key = await crypto.subtle.importKey(
		"pkcs8",
		keyBytes,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const unsigned = `${header}.${payload}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsigned),
	);
	const assertion = `${unsigned}.${base64url(signature)}`;
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		}),
		redirect: "manual",
	});
	const body = (await response.json()) as {
		access_token?: string;
		expires_in?: number;
		error?: string;
		error_description?: string;
	};
	if (!response.ok || !body.access_token) {
		throw new Error(
			`Google service-account token exchange failed: ${body.error_description ?? body.error ?? response.status}`,
		);
	}
	googleTokenCache = {
		token: body.access_token,
		expiresAt: now + (body.expires_in ?? 3600),
		principal: serviceAccount.client_email,
	};
	return body.access_token;
}

/** Suffix match — `host === suffix` or `host` ends with `.${suffix}`. */
function hostMatches(host: string, suffix: string): boolean {
	return host === suffix || host.endsWith(`.${suffix}`);
}

const VIDEO_ASSET_IMPORT_ORIGIN = "https://video-assets.tedix.internal";
const MAX_VIDEO_ASSET_BYTES = 100_000_000;

function bytesToBase64(bytes: Uint8Array): string {
	let encoded = "";
	const chunkSize = 32_768;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		encoded += String.fromCharCode(
			...bytes.subarray(offset, offset + chunkSize),
		);
	}
	return btoa(encoded);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++)
		bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function videoAssetKey(organizationId: string, assetId: string): string {
	return `video-assets/${organizationId}/${assetId}/source.mp4`;
}

async function fetchHttpOnly(request: Request): Promise<Response> {
	const response = await fetch(request);
	if (!response.webSocket) return response;
	try {
		response.webSocket.close(1000, "workflow socket disabled");
	} catch {}
	throw new Error(
		"WORKFLOW_WEBSOCKET_DISABLED: streaming socket lifetimes cannot be bounded by a durable workflow step",
	);
}

export class OutboundProxy extends WorkerEntrypoint<
	SkillRuntimeEnv,
	OutboundProxyProps
> {
	async fetch(request: Request): Promise<Response> {
		const props = this.ctx.props ?? {};
		const upgrade = request.headers.get("upgrade")?.toLowerCase();
		if (upgrade === "websocket" || request.headers.has("sec-websocket-key")) {
			throw new Error(
				"WORKFLOW_WEBSOCKET_DISABLED: streaming socket lifetimes cannot be bounded by a durable workflow step",
			);
		}
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			// Unparseable target — forward untouched and let fetch surface it.
			return fetchHttpOnly(request);
		}

		if (
			request.method === "POST" &&
			url.origin === VIDEO_ASSET_IMPORT_ORIGIN &&
			url.pathname === "/verify-product-keyframe-gate"
		) {
			const input = (await request.json().catch(() => null)) as {
				gateId?: unknown;
				receiptSha256?: unknown;
				productContext?: unknown;
			} | null;
			const organizationId = props.organizationId ?? "";
			if (
				!organizationId ||
				!input ||
				typeof input.gateId !== "string" ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					input.gateId,
				) ||
				typeof input.receiptSha256 !== "string" ||
				!/^[0-9a-f]{64}$/i.test(input.receiptSha256) ||
				typeof input.productContext !== "string" ||
				input.productContext.length < 1 ||
				input.productContext.length > 4_000
			) {
				return Response.json(
					{ error: "valid keyframe gate verification request required" },
					{ status: 400 },
				);
			}
			try {
				const receiptObject = await this.env.VIDEO_BUCKET.get(
					`video-keyframes/${organizationId}/${input.gateId}/receipt.json`,
				);
				if (!receiptObject)
					return Response.json(
						{ error: "keyframe fidelity receipt not found" },
						{ status: 404 },
					);
				const receiptJson = await receiptObject.text();
				const receiptSha256 = await sha256Hex(receiptJson);
				if (
					receiptSha256 !== input.receiptSha256 ||
					receiptObject.customMetadata?.receiptSha256 !== receiptSha256
				) {
					throw new Error("keyframe fidelity receipt hash mismatch");
				}
				const receipt = JSON.parse(receiptJson) as KeyframeGateReceipt;
				const approved = receipt.approvedCandidateIndexes
					.map((index) =>
						receipt.candidates.find((item) => item.index === index),
					)
					.filter((item): item is KeyframeGateReceipt["candidates"][number] =>
						Boolean(item),
					);
				if (approved.length < 2)
					throw new Error(
						"keyframe fidelity receipt admits fewer than two candidates",
					);
				const firstCandidate = approved[0]!;
				const lastCandidate = approved[1]!;
				const [first, last] = await Promise.all([
					this.env.VIDEO_BUCKET.get(firstCandidate.r2Key),
					this.env.VIDEO_BUCKET.get(lastCandidate.r2Key),
				]);
				if (!first || !last)
					throw new Error("approved keyframe endpoint not found");
				const [firstBytes, lastBytes] = await Promise.all([
					first.arrayBuffer(),
					last.arrayBuffer(),
				]);
				assertApprovedKeyframePair(
					organizationId,
					firstCandidate.r2Key,
					lastCandidate.r2Key,
					first.customMetadata,
					last.customMetadata,
					receipt,
					receiptSha256,
					await sha256Hex(input.productContext),
					await sha256Hex(new Uint8Array(firstBytes)),
					await sha256Hex(new Uint8Array(lastBytes)),
				);
				return Response.json({
					verified: true,
					gateId: receipt.gateId,
					receiptR2Key: `video-keyframes/${organizationId}/${receipt.gateId}/receipt.json`,
					receiptSha256,
					judgment: {
						approvedCandidateIndexes: receipt.approvedCandidateIndexes,
					},
					keyframes: receipt.candidates.map((candidate) => ({
						...candidate,
						approved: candidate.fidelityStatus === "approved",
					})),
					motionAllowed: true,
				});
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 403 },
				);
			}
		}

		if (
			request.method === "POST" &&
			url.origin === VIDEO_ASSET_IMPORT_ORIGIN &&
			url.pathname === "/submit-vertex-veo-background"
		) {
			if (!props.googleServiceAccountKey || !props.vertexVideoEndpoint)
				return Response.json(
					{ error: "configured Vertex credentials required" },
					{ status: 503 },
				);
			let input;
			try {
				input = validateVeoBackgroundRequest(await request.json());
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 400 },
				);
			}
			const endpoint = props.vertexVideoEndpoint.replace(
				/\/models\/?$/,
				"/models",
			);
			const upstream = await fetchHttpOnly(
				new Request(
					`${endpoint}/${encodeURIComponent(input.model)}:predictLongRunning`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${await getGoogleAccessToken(props.googleServiceAccountKey)}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(veoBackgroundRequest(input)),
						redirect: "manual",
					},
				),
			);
			const body = (await upstream.json().catch(() => null)) as {
				name?: string;
				error?: { message?: string };
			} | null;
			if (!upstream.ok || !body?.name)
				return Response.json(
					{
						error: `Vertex background submit failed (${upstream.status}): ${body?.error?.message ?? "no operation name"}`,
					},
					{ status: 502 },
				);
			return Response.json({
				operationName: body.name,
				model: input.model,
				productPixelsGenerated: false,
				durationSeconds: input.durationSeconds,
			});
		}

		if (
			request.method === "POST" &&
			url.origin === VIDEO_ASSET_IMPORT_ORIGIN &&
			url.pathname === "/generate-and-judge-product-keyframes"
		) {
			if (!props.googleServiceAccountKey || !props.vertexVideoEndpoint) {
				return Response.json(
					{ error: "configured Vertex credentials required" },
					{ status: 503 },
				);
			}
			let input;
			try {
				input = validateProductKeyframeRequest(await request.json());
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 400 },
				);
			}
			const endpoint = props.vertexVideoEndpoint.replace(
				/\/models\/?$/,
				"/models",
			);
			const token = await getGoogleAccessToken(props.googleServiceAccountKey);
			const globalEndpoint = endpoint
				.replace(
					"https://us-central1-aiplatform.googleapis.com",
					"https://aiplatform.googleapis.com",
				)
				.replace("/locations/us-central1/", "/locations/global/");
			const keyframes = [];
			for (let index = 0; index < input.sampleCount; index++) {
				const generation = await fetchHttpOnly(
					new Request(
						`${globalEndpoint}/gemini-2.5-flash-image:generateContent`,
						{
							method: "POST",
							headers: {
								authorization: `Bearer ${token}`,
								"content-type": "application/json",
							},
							body: JSON.stringify(geminiProductKeyframeRequest(input)),
							redirect: "manual",
						},
					),
				);
				const generationBody = await generation.json().catch(() => null);
				if (!generation.ok || !generationBody)
					return Response.json(
						{
							error: `Vertex Gemini keyframe generation failed: ${generation.status}`,
						},
						{ status: 502 },
					);
				try {
					keyframes.push(extractGeminiKeyframe(generationBody, index));
				} catch (error) {
					return Response.json(
						{ error: error instanceof Error ? error.message : String(error) },
						{ status: 502 },
					);
				}
			}
			const primaryReference = input.referenceImages[0]!;
			keyframes.push({
				data: primaryReference.data ?? "",
				mimeType: primaryReference.mimeType ?? "image/jpeg",
				label: "Primary approved listing identity anchor",
			});
			const parts: Array<Record<string, unknown>> = [
				{ text: keyframeJudgePrompt(input.productContext, keyframes.length) },
			];
			for (const [index, image] of input.referenceImages.entries())
				parts.push(
					{ text: `Approved reference ${index + 1}:` },
					{ inlineData: { mimeType: image.mimeType, data: image.data } },
				);
			for (const [index, image] of keyframes.entries())
				parts.push(
					{ text: `Generated candidate ${index}:` },
					{ inlineData: { mimeType: image.mimeType, data: image.data } },
				);
			const judge = await fetchHttpOnly(
				new Request(`${endpoint}/gemini-2.5-pro:generateContent`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						contents: [{ role: "user", parts }],
						generationConfig: {
							temperature: 0.1,
							responseMimeType: "application/json",
							responseSchema: keyframeJudgeResponseSchema,
						},
					}),
					redirect: "manual",
				}),
			);
			const judgeBody = await judge.json().catch(() => null);
			if (!judge.ok || !judgeBody)
				return Response.json(
					{ error: `Vertex keyframe judge failed: ${judge.status}` },
					{ status: 502 },
				);
			try {
				const judgment = parseAndEnforceKeyframeJudgment(
					judgeBody,
					keyframes.length,
				);
				const gateId = crypto.randomUUID();
				const preparedKeyframes = await Promise.all(
					keyframes.map(async (keyframe, index) => {
						const bytes = base64ToBytes(keyframe.data);
						return {
							bytes,
							index,
							keyframe,
							r2Key: `video-keyframes/${props.organizationId}/${gateId}/${index}.png`,
							sha256: await sha256Hex(bytes),
						};
					}),
				);
				const receipt: KeyframeGateReceipt = {
					schemaVersion: "tedix.product-keyframe-gate.v2",
					gateId,
					organizationId: props.organizationId ?? "",
					productContextSha256: await sha256Hex(input.productContext),
					referenceSha256s: await Promise.all(
						input.referenceImages.map((image) =>
							sha256Hex(base64ToBytes(image.data)),
						),
					),
					judgeModel: "gemini-2.5-pro",
					approvalThreshold: PRODUCT_KEYFRAME_FIDELITY_THRESHOLD,
					approvedCandidateIndexes: judgment.approvedCandidateIndexes,
					candidates: preparedKeyframes.map(
						({ index, keyframe, r2Key, sha256 }) => ({
							index,
							r2Key,
							sha256,
							mimeType: keyframe.mimeType,
							fidelityStatus: judgment.approvedCandidateIndexes.includes(index)
								? "approved"
								: "rejected",
							productFidelityScore:
								judgment.candidates[index]?.productFidelityScore ?? 0,
						}),
					),
					createdAt: new Date().toISOString(),
				};
				const receiptJson = JSON.stringify(receipt);
				const receiptSha256 = await sha256Hex(receiptJson);
				const receiptR2Key = `video-keyframes/${props.organizationId}/${gateId}/receipt.json`;
				await this.env.VIDEO_BUCKET.put(receiptR2Key, receiptJson, {
					httpMetadata: { contentType: "application/json" },
					customMetadata: { kind: "product-keyframe-gate", receiptSha256 },
				});
				const keyframeReceipts = [];
				for (const {
					bytes,
					index,
					keyframe,
					r2Key,
					sha256,
				} of preparedKeyframes) {
					const candidate = judgment.candidates[index];
					const approved = judgment.approvedCandidateIndexes.includes(index);
					await this.env.VIDEO_BUCKET.put(r2Key, bytes, {
						httpMetadata: { contentType: keyframe.mimeType },
						customMetadata: {
							kind: "product-keyframe",
							gateId,
							candidateIndex: String(index),
							fidelityStatus: approved ? "approved" : "rejected",
							productFidelityScore: String(
								candidate?.productFidelityScore ?? 0,
							),
							judgeModel: "gemini-2.5-pro",
							receiptSha256,
						},
					});
					keyframeReceipts.push({
						r2Key,
						mimeType: keyframe.mimeType,
						sizeBytes: bytes.byteLength,
						sha256,
						approved,
						productFidelityScore: candidate?.productFidelityScore ?? 0,
						source:
							index === preparedKeyframes.length - 1
								? "approved-reference"
								: "generated",
					});
				}
				return Response.json({
					model: "gemini-2.5-flash-image",
					judgeModel: "gemini-2.5-pro",
					keyframes: keyframeReceipts,
					gateId,
					receiptR2Key,
					receiptSha256,
					judgment,
					motionAllowed: judgment.approvedCandidateIndexes.length >= 2,
					usageMetadata:
						(judgeBody as { usageMetadata?: unknown }).usageMetadata ?? null,
				});
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 502 },
				);
			}
		}

		if (
			request.method === "POST" &&
			url.origin === VIDEO_ASSET_IMPORT_ORIGIN &&
			url.pathname === "/submit-vertex-veo-reference-assets"
		) {
			if (!props.googleServiceAccountKey || !props.vertexVideoEndpoint)
				return Response.json(
					{ error: "configured Vertex credentials required" },
					{ status: 503 },
				);
			let input;
			try {
				input = validateVeoAssetReferenceRequest(await request.json());
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 400 },
				);
			}
			const endpoint = props.vertexVideoEndpoint.replace(
				/\/models\/?$/,
				"/models",
			);
			const upstream = await fetchHttpOnly(
				new Request(
					`${endpoint}/${encodeURIComponent(input.model)}:predictLongRunning`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${await getGoogleAccessToken(props.googleServiceAccountKey)}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(veoAssetReferenceRequest(input)),
						redirect: "manual",
					},
				),
			);
			const body = (await upstream.json().catch(() => null)) as {
				name?: string;
				error?: { message?: string };
			} | null;
			if (!upstream.ok || !body?.name)
				return Response.json(
					{
						error: `Vertex asset-reference submit failed (${upstream.status}): ${body?.error?.message ?? "no operation name"}`,
					},
					{ status: 502 },
				);
			return Response.json({
				operationName: body.name,
				model: input.model,
				referenceImageCount: input.referenceImages.length,
				referenceType: "asset",
				durationSeconds: input.durationSeconds,
			});
		}

		if (
			request.method === "POST" &&
			url.origin === VIDEO_ASSET_IMPORT_ORIGIN &&
			(url.pathname === "/submit-vertex-veo-keyframes" ||
				url.pathname === "/submit-vertex-veo-keyframe")
		) {
			const singleFrame = url.pathname === "/submit-vertex-veo-keyframe";
			const input = (await request.json().catch(() => null)) as {
				model?: unknown;
				prompt?: unknown;
				frameR2Key?: unknown;
				firstFrameR2Key?: unknown;
				lastFrameR2Key?: unknown;
				productContext?: unknown;
				aspectRatio?: unknown;
				durationSeconds?: unknown;
			} | null;
			const organizationId = props.organizationId ?? "";
			const prefix = `video-keyframes/${organizationId}/`;
			const firstFrameR2Key = singleFrame
				? input?.frameR2Key
				: input?.firstFrameR2Key;
			if (
				!organizationId ||
				!input ||
				typeof input.model !== "string" ||
				!/^[a-zA-Z0-9._-]{1,128}$/.test(input.model) ||
				typeof input.prompt !== "string" ||
				input.prompt.length < 1 ||
				input.prompt.length > 8_000 ||
				typeof firstFrameR2Key !== "string" ||
				!firstFrameR2Key.startsWith(prefix) ||
				(!singleFrame &&
					(typeof input.lastFrameR2Key !== "string" ||
						!input.lastFrameR2Key.startsWith(prefix))) ||
				typeof input.productContext !== "string" ||
				input.productContext.length < 1 ||
				input.productContext.length > 4_000 ||
				!["16:9", "9:16"].includes(String(input.aspectRatio)) ||
				![4, 8].includes(Number(input.durationSeconds)) ||
				!props.googleServiceAccountKey ||
				!props.vertexVideoEndpoint
			)
				return Response.json(
					{ error: "valid organization-owned Veo keyframe request required" },
					{ status: 400 },
				);
			const [first, last] = await Promise.all([
				this.env.VIDEO_BUCKET.get(firstFrameR2Key),
				singleFrame
					? Promise.resolve(null)
					: this.env.VIDEO_BUCKET.get(input.lastFrameR2Key as string),
			]);
			if (!first || (!singleFrame && !last))
				return Response.json({ error: "keyframe not found" }, { status: 404 });
			if (first.size > 7_000_000 || (last?.size ?? 0) > 7_000_000)
				return Response.json(
					{ error: "keyframe exceeds Vertex inline limit" },
					{ status: 413 },
				);
			const firstBytes = await first.arrayBuffer();
			const lastBytes = last ? await last.arrayBuffer() : null;
			try {
				const gateId = first.customMetadata?.gateId;
				if (!gateId) throw new Error("keyframe endpoint has no fidelity gate");
				const receiptObject = await this.env.VIDEO_BUCKET.get(
					`video-keyframes/${organizationId}/${gateId}/receipt.json`,
				);
				if (!receiptObject)
					throw new Error("keyframe fidelity receipt not found");
				const receiptJson = await receiptObject.text();
				const receiptSha256 = await sha256Hex(receiptJson);
				if (receiptObject.customMetadata?.receiptSha256 !== receiptSha256)
					throw new Error("keyframe fidelity receipt hash mismatch");
				const receipt = JSON.parse(receiptJson) as KeyframeGateReceipt;
				const productContextSha256 = await sha256Hex(input.productContext);
				if (singleFrame) {
					assertApprovedKeyframe(
						organizationId,
						firstFrameR2Key,
						first.customMetadata,
						receipt,
						receiptSha256,
						productContextSha256,
						await sha256Hex(new Uint8Array(firstBytes)),
					);
				} else {
					assertApprovedKeyframePair(
						organizationId,
						firstFrameR2Key,
						input.lastFrameR2Key as string,
						first.customMetadata,
						last?.customMetadata,
						receipt,
						receiptSha256,
						productContextSha256,
						await sha256Hex(new Uint8Array(firstBytes)),
						await sha256Hex(new Uint8Array(lastBytes!)),
					);
				}
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 403 },
				);
			}
			const endpoint = props.vertexVideoEndpoint.replace(
				/\/models\/?$/,
				"/models",
			);
			const upstream = await fetchHttpOnly(
				new Request(
					`${endpoint}/${encodeURIComponent(input.model)}:predictLongRunning`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${await getGoogleAccessToken(props.googleServiceAccountKey)}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							instances: [
								{
									prompt: input.prompt,
									image: {
										bytesBase64Encoded: bytesToBase64(
											new Uint8Array(firstBytes),
										),
										mimeType: first.httpMetadata?.contentType ?? "image/png",
									},
									...(last && lastBytes
										? {
												lastFrame: {
													bytesBase64Encoded: bytesToBase64(
														new Uint8Array(lastBytes),
													),
													mimeType:
														last.httpMetadata?.contentType ?? "image/png",
												},
											}
										: {}),
								},
							],
							parameters: {
								aspectRatio: input.aspectRatio,
								sampleCount: 1,
								durationSeconds: input.durationSeconds,
							},
						}),
						redirect: "manual",
					},
				),
			);
			const body = (await upstream.json().catch(() => null)) as {
				name?: string;
				error?: { message?: string };
			} | null;
			if (!upstream.ok || !body?.name)
				return Response.json(
					{
						error: `Vertex submit failed (${upstream.status}): ${body?.error?.message ?? "no operation name"}`,
					},
					{ status: 502 },
				);
			return Response.json({
				operationName: body.name,
				firstFrameR2Key,
				lastFrameR2Key: singleFrame ? null : input.lastFrameR2Key,
			});
		}

		if (
			request.method === "POST" &&
			url.origin === VIDEO_ASSET_IMPORT_ORIGIN &&
			url.pathname === "/judge-video-render"
		) {
			const input = (await request.json().catch(() => null)) as {
				r2Key?: unknown;
				model?: unknown;
				productContext?: unknown;
				rubric?: unknown;
				referenceImages?: unknown;
			} | null;
			const organizationId = props.organizationId ?? "";
			const endpoint = props.vertexVideoEndpoint ?? "";
			if (
				!organizationId ||
				!input ||
				typeof input.r2Key !== "string" ||
				!isOrganizationOwnedJudgeVideoKey(input.r2Key, organizationId) ||
				typeof input.productContext !== "string" ||
				input.productContext.length < 1 ||
				input.productContext.length > 8_000 ||
				!props.googleServiceAccountKey ||
				!endpoint
			) {
				return Response.json(
					{ error: "valid organization-owned video judge request required" },
					{ status: 400 },
				);
			}
			const model =
				typeof input.model === "string" &&
				/^[a-zA-Z0-9._-]{1,128}$/.test(input.model)
					? input.model
					: "gemini-2.5-pro";
			let referenceImages;
			try {
				referenceImages = validateReferenceImages(
					Array.isArray(input.referenceImages)
						? (input.referenceImages as never[])
						: undefined,
				);
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 400 },
				);
			}
			const video = await this.env.VIDEO_BUCKET.get(input.r2Key);
			if (!video)
				return Response.json({ error: "video not found" }, { status: 404 });
			if (video.size > MAX_JUDGE_VIDEO_BYTES) {
				return Response.json(
					{ error: `video exceeds ${MAX_JUDGE_VIDEO_BYTES} byte judge limit` },
					{ status: 413 },
				);
			}
			const parts: Array<Record<string, unknown>> = [
				{
					text: videoJudgePrompt({
						productContext: input.productContext,
						rubric:
							typeof input.rubric === "string"
								? input.rubric.slice(0, 8_000)
								: undefined,
					}),
				},
				{ text: "Candidate video:" },
				{
					inlineData: {
						mimeType: "video/mp4",
						data: bytesToBase64(new Uint8Array(await video.arrayBuffer())),
					},
				},
			];
			for (const [index, image] of referenceImages.entries()) {
				parts.push(
					{ text: image.label || `Approved product reference ${index + 1}:` },
					{ inlineData: { mimeType: image.mimeType, data: image.data } },
				);
			}
			const operationUrl = new URL(
				`${endpoint.replace(/\/$/, "")}/${encodeURIComponent(model)}:generateContent`,
			);
			if (!isVertexRegionalHost(operationUrl.hostname)) {
				return Response.json(
					{ error: "configured Vertex endpoint required" },
					{ status: 503 },
				);
			}
			const upstream = await fetchHttpOnly(
				new Request(operationUrl, {
					method: "POST",
					headers: {
						authorization: `Bearer ${await getGoogleAccessToken(props.googleServiceAccountKey)}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						contents: [{ role: "user", parts }],
						generationConfig: {
							temperature: 0.1,
							responseMimeType: "application/json",
							responseSchema: videoJudgeResponseSchema,
						},
					}),
					redirect: "manual",
				}),
			);
			const upstreamBody = await upstream.json().catch(() => null);
			if (!upstream.ok || !upstreamBody) {
				return Response.json(
					{ error: `Vertex video judge failed: ${upstream.status}` },
					{ status: 502 },
				);
			}
			try {
				return Response.json({
					model,
					video: {
						r2Key: input.r2Key,
						sizeBytes: video.size,
						etag: video.etag,
					},
					referenceImageCount: referenceImages.length,
					usageMetadata:
						(upstreamBody as { usageMetadata?: unknown }).usageMetadata ?? null,
					judgment: extractJudgeJson(upstreamBody),
				});
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 502 },
				);
			}
		}

		if (
			request.method === "POST" &&
			url.origin === VIDEO_ASSET_IMPORT_ORIGIN &&
			(url.pathname === "/import-vertex-veo" ||
				url.pathname === "/poll-vertex-veo")
		) {
			const input = (await request.json().catch(() => null)) as {
				model?: unknown;
				operationName?: unknown;
			} | null;
			const organizationId = props.organizationId ?? "";
			const endpoint = props.vertexVideoEndpoint ?? "";
			if (
				!organizationId ||
				!input ||
				typeof input.model !== "string" ||
				!/^[a-zA-Z0-9._-]{1,128}$/.test(input.model) ||
				typeof input.operationName !== "string" ||
				input.operationName.length < 1 ||
				input.operationName.length > 1_000 ||
				!props.googleServiceAccountKey ||
				!endpoint
			) {
				return Response.json(
					{ error: "valid Vertex Veo import request required" },
					{ status: 400 },
				);
			}
			const operationUrl = new URL(
				`${endpoint.replace(/\/$/, "")}/${encodeURIComponent(input.model)}:fetchPredictOperation`,
			);
			if (!isVertexRegionalHost(operationUrl.hostname)) {
				return Response.json(
					{ error: "configured Vertex endpoint required" },
					{ status: 503 },
				);
			}
			const upstream = await fetchHttpOnly(
				new Request(operationUrl, {
					method: "POST",
					headers: {
						authorization: `Bearer ${await getGoogleAccessToken(props.googleServiceAccountKey)}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ operationName: input.operationName }),
					redirect: "manual",
				}),
			);
			if (!upstream.ok || !upstream.body) {
				return Response.json(
					{ error: `Vertex media fetch failed: ${upstream.status}` },
					{ status: 502 },
				);
			}
			if (url.pathname === "/poll-vertex-veo") {
				return Response.json({
					done: await vertexOperationDone(upstream.body),
				});
			}
			const assetId = crypto.randomUUID();
			const r2Key = videoAssetKey(organizationId, assetId);
			let videoByteLength: number;
			try {
				videoByteLength = await vertexInlineVideoByteLength(
					upstream.body,
					MAX_VIDEO_ASSET_BYTES,
				);
			} catch (error) {
				return Response.json(
					{
						error:
							"Vertex inline media measurement failed: " +
							(error instanceof Error ? error.message : String(error)),
					},
					{ status: 502 },
				);
			}
			const importUpstream = await fetchHttpOnly(
				new Request(operationUrl, {
					method: "POST",
					headers: {
						authorization:
							"Bearer " +
							(await getGoogleAccessToken(props.googleServiceAccountKey)),
						"content-type": "application/json",
					},
					body: JSON.stringify({ operationName: input.operationName }),
					redirect: "manual",
				}),
			);
			if (!importUpstream.ok || !importUpstream.body) {
				return Response.json(
					{
						error: "Vertex media import fetch failed: " + importUpstream.status,
					},
					{ status: 502 },
				);
			}
			const decoded = vertexInlineVideoStream(
				importUpstream.body,
				MAX_VIDEO_ASSET_BYTES,
			);
			const stagingKey = `${r2Key}.uploading-${crypto.randomUUID()}`;
			const hasher = createSha256.create();
			const hashingStream = new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					hasher.update(chunk);
					controller.enqueue(chunk);
				},
			});
			const fixed = new FixedLengthStream(videoByteLength);
			const piped = decoded.readable
				.pipeThrough(hashingStream)
				.pipeTo(fixed.writable);
			// If R2 rejects before it starts consuming the stream, completion may
			// reject after this request has already returned. Observe both branches
			// now; the success path still awaits them below for a full receipt.
			void decoded.completed.catch(() => undefined);
			void piped.catch(() => undefined);
			let object: R2Object;
			let sha256: string;
			try {
				await this.env.VIDEO_BUCKET.put(stagingKey, fixed.readable, {
					httpMetadata: { contentType: "video/mp4" },
					customMetadata: {
						assetId,
						organizationId,
						source: "vertex-inline-staging",
					},
				});
				await Promise.all([decoded.completed, piped]);
				const digest = hasher.digest();
				sha256 = Array.from(digest, (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join("");
				const staged = await this.env.VIDEO_BUCKET.get(stagingKey);
				if (!staged?.body)
					throw new Error("staged Vertex media disappeared before admission");
				object = await this.env.VIDEO_BUCKET.put(r2Key, staged.body, {
					httpMetadata: { contentType: "video/mp4" },
					customMetadata: {
						assetId,
						organizationId,
						source: "vertex-inline",
						sha256,
					},
					sha256: digest.buffer.slice(
						digest.byteOffset,
						digest.byteOffset + digest.byteLength,
					) as ArrayBuffer,
				});
			} catch (error) {
				return Response.json(
					{
						error: `Vertex inline media import failed: ${error instanceof Error ? error.message : String(error)}`,
					},
					{ status: 502 },
				);
			} finally {
				await this.env.VIDEO_BUCKET.delete(stagingKey).catch(() => undefined);
			}
			return Response.json(
				{
					assetId,
					r2Key,
					sizeBytes: object.size,
					mimeType: "video/mp4",
					sha256,
				},
				{ status: 201 },
			);
		}

		const host = url.hostname.toLowerCase();

		// Google Gemini, via either backend:
		//  - Vertex AI (`aiplatform.googleapis.com`, incl. regional
		//    `{region}-aiplatform.googleapis.com`) — bills to the GCP project's
		//    Cloud billing account, so Google Cloud / startup credits apply.
		//    This is the path Tedix uses.
		//  - AI Studio (`generativelanguage.googleapis.com`) — separate prepay
		//    pool; kept for completeness.
		// Inject the platform key as `x-goog-api-key` unless the tenant set one.
		const isVertex = isVertexHost(host);
		const isAiStudio = hostMatches(host, "generativelanguage.googleapis.com");
		if (isVertex || isAiStudio) {
			const headers = new Headers(request.headers);
			if (
				isVertex &&
				props.googleServiceAccountKey &&
				!headers.has("authorization")
			) {
				headers.set(
					"authorization",
					`Bearer ${await getGoogleAccessToken(props.googleServiceAccountKey)}`,
				);
			} else if (props.geminiApiKey && !headers.has("x-goog-api-key")) {
				headers.set("x-goog-api-key", props.geminiApiKey);
				// Strip any `?key=` the tenant may have set so the header wins
				// and the key never appears in tenant-authored query strings.
				url.searchParams.delete("key");
			}
			if (headers.has("authorization") || headers.has("x-goog-api-key")) {
				url.searchParams.delete("key");
				return fetchHttpOnly(
					new Request(url.toString(), {
						method: request.method,
						headers,
						body: request.body,
						// Never auto-follow redirects on a credential-injected request:
						// a cross-host 3xx would otherwise re-send `x-goog-api-key` to
						// the redirect target. With "manual" the 3xx is returned to the
						// tenant unfollowed, so the key only ever reaches the host the
						// tenant explicitly targeted (which we matched above).
						redirect: "manual",
						// @ts-expect-error duplex required for streaming bodies on Workers
						duplex: request.body ? "half" : undefined,
					}),
				);
			}
			return fetchHttpOnly(request);
		}

		// Not an allow-listed provider host — forward unmodified. The skill
		// opted into network access; we just never attach a platform secret.
		return fetchHttpOnly(request);
	}
}
