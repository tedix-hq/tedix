import { decodeAiGatewayAttribution } from "@tedix/api-contract/schemas/ai-gateway-attribution";
import { ProviderExecutionIdentitySchema } from "@tedix/api-contract/schemas/provider-execution";
import {
	DecisionModelSchema,
	type DecisionModel,
} from "@tedix/api-contract/schemas/jev";
import { assertProviderDispatchReady } from "./gateway-transport";
import {
	authorizedProviderDispatch,
	type WorkersAiClient,
	type WorkersAiTransportEnv,
} from "./transport";

export const JEV_MODEL = "typesafe/jev";
export const JEV_DIRECT_MODEL = "jev-1.13.0";
export const CLEF_MODEL = "@cf/cloudflare/clef";
export const CLEF_FLASH_MODEL = "@cf/cloudflare/clef-flash";
export interface JevEnv extends WorkersAiTransportEnv {
	JEV_TRANSPORT?: string;
	TYPESAFE_API_KEY?: string;
}
export interface JevClient extends WorkersAiClient {
	env: JevEnv;
}

export function resolveJevExecution(
	env: JevEnv,
	model: DecisionModel = JEV_MODEL,
) {
	model = DecisionModelSchema.parse(model);
	const transport = env.JEV_TRANSPORT?.trim() || "cloudflare";
	if (!["cloudflare", "direct"].includes(transport))
		throw new Error("Unknown Jev transport");
	const direct = transport === "direct";
	if (direct && model !== JEV_MODEL)
		throw new Error("Direct transport supports only TypeSafe Jev");
	const workersAi = model !== JEV_MODEL;
	return ProviderExecutionIdentitySchema.parse({
		provider: workersAi ? "workers-ai" : "typesafe",
		requestModel: direct ? JEV_DIRECT_MODEL : model,
		gatewayAccountId: direct ? null : env.AI_GATEWAY_ACCOUNT_ID?.trim(),
		gatewayId: direct ? null : env.AI_GATEWAY_LLM_ID?.trim(),
		transportKind: direct
			? "direct-https"
			: workersAi
				? "gateway-https"
				: "cloudflare-ai-https",
		apiKind: workersAi ? "workers-ai-chat" : "typesafe-systemone",
		providerResource: null,
		providerOrigin: direct ? "https://api.typesafe.ai" : null,
		deployment: null,
	});
}
export type JevValue =
	| string
	| number
	| boolean
	| null
	| JevValue[]
	| { [key: string]: JevValue };
export type JevEntry = string | JevValue[] | { [key: string]: JevValue };
export type JevQuestion =
	| {
			type: "noul";
			instructions: JevEntry;
			criteria?: { true?: JevEntry; false?: JevEntry };
	  }
	| {
			type: "choice";
			instructions: JevEntry;
			criteria: Record<string, JevEntry | null>;
	  }
	| { type: "score"; instructions: JevEntry; criteria: readonly JevEntry[] };
export type JevAnswer =
	| { type: "noul"; noul: number }
	| {
			type: "choice";
			choice: string;
			probabilities: Record<string, number>;
			confidence: number;
	  }
	| {
			type: "score";
			score: number;
			probabilities: Record<string, number>;
			confidence: number;
			legend: Record<string, JevEntry>;
	  };
export type JevAnswers<Q extends Record<string, JevQuestion>> = {
	[K in keyof Q]: Extract<JevAnswer, { type: Q[K]["type"] }>;
};
export interface JevUsage {
	input_tokens: number;
	output_tokens: number;
}
export interface JevResult<
	Q extends Record<string, JevQuestion> = Record<string, JevQuestion>,
> {
	model: string;
	answers: JevAnswers<Q>;
	usage: JevUsage;
	/** Opaque ID for joining this Cloudflare send to a metadata-only Gateway log. */
	gatewayCorrelationId?: string;
}
export interface JevRequest<
	Q extends Record<string, JevQuestion> = Record<string, JevQuestion>,
> {
	/** Exact decision model. Callers promote alternatives independently per purpose. */
	model?: DecisionModel;
	state: JevEntry;
	questions: Q;
	attribution?: Record<string, string>;
	signal?: AbortSignal;
	/** Total dispatch/body deadline. Authorization is owned by the caller. */
	timeoutMs?: number;
}

/** Carries reported usage even when semantic answer validation failed. */
export class JevResponseError extends Error {
	constructor(
		message: string,
		readonly usage?: JevUsage,
		readonly status?: number,
		readonly gatewayCorrelationId?: string,
	) {
		super(message);
		this.name = "JevResponseError";
	}
}
const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const probability = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= 0 &&
	value <= 1;
const jsonValue = (value: unknown, depth = 0): boolean => {
	if (depth > 64) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value))
		return value.every((child) => jsonValue(child, depth + 1));
	return (
		object(value) &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Object.values(value).every((child) => jsonValue(child, depth + 1))
	);
};
const entry = (value: unknown): boolean =>
	(typeof value === "string" || Array.isArray(value) || object(value)) &&
	jsonValue(value);
const sameKeys = (
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean =>
	Object.keys(value).length === keys.length &&
	keys.every((key) => Object.hasOwn(value, key));

function serializeRequest(
	request: JevRequest,
	direct: boolean,
	model: DecisionModel,
): string {
	if (
		!entry(request.state) ||
		!object(request.questions) ||
		Object.keys(request.questions).length === 0
	)
		throw new Error("Jev requires JSON state and nonempty questions");
	for (const [id, question] of Object.entries(request.questions)) {
		if (!id.trim() || !object(question) || !entry(question.instructions))
			throw new Error("Invalid Jev question instructions");
		if (question.type === "choice") {
			if (
				!object(question.criteria) ||
				Object.keys(question.criteria).length < 2 ||
				Object.keys(question.criteria).length > 255 ||
				Object.entries(question.criteria).some(
					([key, value]) => !key.trim() || (value !== null && !entry(value)),
				)
			)
				throw new Error("Jev Choice requires 2–255 described options");
		} else if (question.type === "score") {
			if (
				!Array.isArray(question.criteria) ||
				question.criteria.length < 2 ||
				question.criteria.length > 10 ||
				!question.criteria.every(entry)
			)
				throw new Error("Jev Score requires 2–10 rubric levels");
		} else if (question.type === "noul") {
			if (
				question.criteria !== undefined &&
				(!object(question.criteria) ||
					Object.entries(question.criteria).some(
						([key, value]) => !["true", "false"].includes(key) || !entry(value),
					))
			)
				throw new Error("Invalid Jev Noul criteria");
		} else throw new Error("Unknown Jev question type");
	}
	const input = { state: request.state, questions: request.questions };
	const body = JSON.stringify(
		direct
			? { model: JEV_DIRECT_MODEL, ...input }
			: model === JEV_MODEL
				? { model: JEV_MODEL, input }
				: { model: model === CLEF_MODEL ? "clef" : "clef-flash", ...input },
	);
	// A conservative UTF-8 bound fits the documented 32k state+question window
	// even when each byte is a token; never silently truncate evidence.
	if (new TextEncoder().encode(body).byteLength > 30_000)
		throw new Error("Jev request exceeds the 30000-byte context budget");
	return body;
}

export function parseJevResult<Q extends Record<string, JevQuestion>>(
	value: unknown,
	questions: Q,
	expectedModel?: DecisionModel | typeof JEV_DIRECT_MODEL,
): JevResult<Q> {
	const rawUsage =
		object(value) && object(value.usage) ? value.usage : undefined;
	const usage =
		rawUsage &&
		Number.isSafeInteger(rawUsage.input_tokens) &&
		Number.isSafeInteger(rawUsage.output_tokens) &&
		(rawUsage.input_tokens as number) >= 0 &&
		(rawUsage.output_tokens as number) >= 0
			? {
					input_tokens: rawUsage.input_tokens as number,
					output_tokens: rawUsage.output_tokens as number,
				}
			: undefined;
	const fail = (): never => {
		throw new JevResponseError("Invalid Jev response", usage);
	};
	if (
		!object(value) ||
		typeof value.model !== "string" ||
		(expectedModel === CLEF_MODEL
			? value.model !== "clef"
			: expectedModel === CLEF_FLASH_MODEL
				? value.model !== "clef-flash"
				: !/^jev-[a-z0-9.-]+$/.test(value.model)) ||
		!usage ||
		!object(value.answers) ||
		!sameKeys(value.answers, Object.keys(questions))
	)
		return fail();
	for (const [id, question] of Object.entries(questions)) {
		const answer = value.answers[id];
		if (!object(answer) || answer.type !== question.type) return fail();
		if (question.type === "noul") {
			if (!probability(answer.noul)) return fail();
			continue;
		}
		const keys =
			question.type === "choice"
				? Object.keys(question.criteria)
				: question.criteria.map((_, i) => String(i));
		if (
			!probability(answer.confidence) ||
			!object(answer.probabilities) ||
			!sameKeys(answer.probabilities, keys)
		)
			return fail();
		const probabilities = answer.probabilities;
		if (
			!Object.values(probabilities).every(probability) ||
			Math.abs(
				Object.values(probabilities).reduce<number>(
					(sum, p) => sum + (p as number),
					0,
				) - 1,
			) > 0.01
		)
			return fail();
		if (question.type === "choice") {
			if (
				typeof answer.choice !== "string" ||
				!keys.includes(answer.choice) ||
				keys.some(
					(key) =>
						(probabilities[key] as number) >
						(probabilities[answer.choice as string] as number) + 0.01,
				)
			)
				return fail();
		} else {
			const expected = keys.reduce(
				(sum, key) => sum + Number(key) * (probabilities[key] as number),
				0,
			);
			if (
				typeof answer.score !== "number" ||
				!Number.isFinite(answer.score) ||
				answer.score < 0 ||
				answer.score > keys.length - 1 ||
				Math.abs(answer.score - expected) > 0.05 ||
				!object(answer.legend) ||
				!sameKeys(answer.legend, keys) ||
				keys.some(
					(key) =>
						JSON.stringify((answer.legend as Record<string, unknown>)[key]) !==
						JSON.stringify(question.criteria[Number(key)]),
				)
			)
				return fail();
		}
	}
	return { model: value.model, answers: value.answers as JevAnswers<Q>, usage };
}

/** One admission, one native Cloudflare send. No implicit retry or provider switch. */
export async function callJev<const Q extends Record<string, JevQuestion>>(
	client: JevClient,
	request: JevRequest<Q>,
): Promise<JevResult<Q>> {
	const requestSignal = request.signal;
	const model = request.model ?? JEV_MODEL;
	const execution = resolveJevExecution(client.env, model);
	const direct = execution.transportKind === "direct-https";
	const body = serializeRequest(request, direct, model);
	const accountId = execution.gatewayAccountId;
	const gatewayId = execution.gatewayId;
	const token = (
		direct ? client.env.TYPESAFE_API_KEY : client.env.CF_WORKERS_AI_TOKEN
	)?.trim();
	if (
		!token ||
		(!direct && (!accountId || !/^[a-zA-Z0-9_-]+$/.test(accountId)))
	)
		throw new Error("Jev transport credential or account is missing");
	const timeoutMs = request.timeoutMs ?? 10_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
		throw new Error("Invalid Jev timeout");
	requestSignal?.throwIfAborted();
	const authorization = await client.authorize({
		execution,
		model: execution.requestModel,
		body,
		attribution: request.attribution,
		signal: requestSignal,
	});
	const dispatch = authorizedProviderDispatch(
		client.beforeDispatch,
		authorization,
		requestSignal,
	);
	dispatch.signal?.throwIfAborted();
	const controller = new AbortController();
	const abort = () => controller.abort(dispatch.signal?.reason);
	dispatch.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error("Jev request timed out")),
		timeoutMs,
	);
	try {
		// Reuse admitted opaque identity while keeping tenant/run/work metadata private.
		const decisionTraceId = direct
			? undefined
			: (decodeAiGatewayAttribution(authorization.attribution?.attribution)
					?.executionId ?? crypto.randomUUID());
		const parseResult = (value: unknown): JevResult<Q> => {
			try {
				const result = parseJevResult(
					value,
					request.questions,
					direct ? JEV_DIRECT_MODEL : model,
				);
				return decisionTraceId
					? { ...result, gatewayCorrelationId: decisionTraceId }
					: result;
			} catch (error) {
				if (error instanceof JevResponseError && decisionTraceId)
					throw new JevResponseError(
						error.message,
						error.usage,
						error.status,
						decisionTraceId,
					);
				throw error;
			}
		};
		assertProviderDispatchReady(dispatch.beforeDispatch);
		controller.signal.throwIfAborted();
		const response = await fetch(
			direct
				? "https://api.typesafe.ai/v1/systemone"
				: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run${model === JEV_MODEL ? "" : `/${model}`}`,
			{
				method: "POST",
				body,
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					...(!direct
						? {
								"cf-aig-gateway-id": gatewayId!,
								"cf-aig-collect-log": "true",
								"cf-aig-collect-log-payload": "false",
								"cf-aig-skip-cache": "true",
								// Third-party Jev must use the governed provider-owned billing lane.
								...(model === JEV_MODEL
									? { "cf-aig-no-wholesale": "true" }
									: {}),
								"cf-aig-metadata": JSON.stringify({
									decision_trace_id: decisionTraceId,
								}),
							}
						: {}),
				},
			},
		);
		if (!response.ok)
			throw new JevResponseError(
				`Jev returned HTTP ${response.status}`,
				undefined,
				response.status,
				decisionTraceId,
			);
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			if (decisionTraceId)
				throw new JevResponseError(
					"Invalid Jev response",
					undefined,
					undefined,
					decisionTraceId,
				);
			throw error;
		}
		// Account REST APIs wrap native model results in the Cloudflare envelope.
		if (!direct && object(payload) && "success" in payload) {
			if (payload.success !== true)
				throw new JevResponseError(
					"Cloudflare Jev request failed",
					undefined,
					undefined,
					decisionTraceId,
				);
			const native = payload.result;
			if (object(native) && "state" in native) {
				if (native.state !== "Completed")
					throw new JevResponseError(
						"Cloudflare Jev request did not complete",
						undefined,
						undefined,
						decisionTraceId,
					);
				return parseResult(native.result);
			}
			return parseResult(native);
		}
		const result = parseResult(payload);
		if (direct && result.model !== JEV_DIRECT_MODEL)
			throw new JevResponseError(
				"Jev returned a different model than the pinned request",
				result.usage,
			);
		return result;
	} finally {
		clearTimeout(timer);
		dispatch.signal?.removeEventListener("abort", abort);
	}
}
