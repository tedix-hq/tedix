import * as z from "zod";

const DATAFORSEO_BASE_URL = "https://api.dataforseo.com";
const DATAFORSEO_SUCCESS_CODE = 20000;
const DATAFORSEO_USER_AGENT = "Tedix-SEO/1.0";

const DataForSeoTaskSchema = z
	.object({
		id: z.string().min(1),
		status_code: z.number().int(),
		status_message: z.string().optional(),
		cost: z.number().nonnegative(),
		path: z.array(z.string()).optional(),
		result: z.array(z.unknown()).nullable().optional(),
	})
	.passthrough();

const DataForSeoResponseSchema = z
	.object({
		status_code: z.number().int(),
		status_message: z.string().optional(),
		tasks: z.array(DataForSeoTaskSchema).optional(),
	})
	.passthrough();

export interface DataForSeoReceipt {
	providerTaskId: string;
	endpoint: string;
	path: string[];
	costMicros: number;
	statusCode: number;
	statusMessage: string | null;
}

export interface DataForSeoResult {
	result: unknown[];
	receipt: DataForSeoReceipt;
}

export type DataForSeoRecoveryAction = "verify_account";

export type RecordDataForSeoReceipt = (
	receipt: DataForSeoReceipt,
) => Promise<void>;

export class DataForSeoError extends Error {
	constructor(
		message: string,
		public readonly receipt: DataForSeoReceipt | null = null,
		public readonly providerStatusCode: number | null = null,
		public readonly recoveryAction: DataForSeoRecoveryAction | null = null,
	) {
		super(message);
		this.name = "DataForSeoError";
	}
}

interface CreateDataForSeoClientOptions {
	credential: string;
	fetchImpl?: typeof fetch;
	recordReceipt: RecordDataForSeoReceipt;
}

function authorizationHeader(credential: string): string {
	const normalized = credential.trim().replace(/^Basic\s+/i, "");
	if (!normalized) {
		throw new DataForSeoError("DataForSEO credential is empty");
	}
	return `Basic ${normalized}`;
}

function buildReceipt(
	endpoint: string,
	task: z.infer<typeof DataForSeoTaskSchema>,
): DataForSeoReceipt {
	return {
		providerTaskId: task.id,
		endpoint,
		path: task.path ?? endpoint.split("/").filter(Boolean),
		costMicros: Math.round(task.cost * 1_000_000),
		statusCode: task.status_code,
		statusMessage: task.status_message ?? null,
	};
}

function isNoResults(statusMessage: string | undefined): boolean {
	return statusMessage?.toLowerCase().includes("no search results") ?? false;
}

function parseHttpError(responseBody: string): {
	detail: string;
	providerStatusCode: number | null;
	recoveryAction: DataForSeoRecoveryAction | null;
} {
	const boundedBody = responseBody.replace(/\s+/g, " ").trim().slice(0, 300);
	try {
		const parsed = z
			.object({
				status_code: z.number().int().optional(),
				status_message: z.string().optional(),
			})
			.safeParse(JSON.parse(responseBody));
		if (!parsed.success) {
			return {
				detail: boundedBody,
				providerStatusCode: null,
				recoveryAction: null,
			};
		}
		const providerStatusCode = parsed.data.status_code ?? null;
		return {
			detail:
				parsed.data.status_message?.replace(/\s+/g, " ").trim().slice(0, 300) ??
				boundedBody,
			providerStatusCode,
			recoveryAction: providerStatusCode === 40104 ? "verify_account" : null,
		};
	} catch {
		return {
			detail: boundedBody,
			providerStatusCode: null,
			recoveryAction: null,
		};
	}
}

export function createDataForSeoClient({
	credential,
	fetchImpl = fetch,
	recordReceipt,
}: CreateDataForSeoClientOptions) {
	const authorization = authorizationHeader(credential);

	return {
		async post(endpoint: string, taskInput: Record<string, unknown>) {
			const response = await fetchImpl(`${DATAFORSEO_BASE_URL}${endpoint}`, {
				method: "POST",
				headers: {
					Authorization: authorization,
					Accept: "application/json",
					"Content-Type": "application/json",
					"User-Agent": DATAFORSEO_USER_AGENT,
				},
				body: JSON.stringify([taskInput]),
			});

			if (!response.ok) {
				const httpError = parseHttpError(await response.text().catch(() => ""));
				throw new DataForSeoError(
					`DataForSEO request failed with HTTP ${response.status}${httpError.detail ? `: ${httpError.detail}` : ""}`,
					null,
					httpError.providerStatusCode,
					httpError.recoveryAction,
				);
			}

			const parsed = DataForSeoResponseSchema.safeParse(await response.json());
			if (!parsed.success) {
				throw new DataForSeoError(
					"DataForSEO returned an invalid response envelope",
				);
			}
			if (parsed.data.status_code !== DATAFORSEO_SUCCESS_CODE) {
				throw new DataForSeoError(
					parsed.data.status_message ?? "DataForSEO request failed",
				);
			}

			const task = parsed.data.tasks?.[0];
			if (!task) {
				throw new DataForSeoError("DataForSEO response is missing its task");
			}

			const receipt = buildReceipt(endpoint, task);
			await recordReceipt(receipt);

			if (
				task.status_code !== DATAFORSEO_SUCCESS_CODE &&
				!isNoResults(task.status_message)
			) {
				throw new DataForSeoError(
					task.status_message ?? "DataForSEO task failed",
					receipt,
				);
			}

			return {
				result: task.result ?? [],
				receipt,
			} satisfies DataForSeoResult;
		},
	};
}

export type DataForSeoClient = ReturnType<typeof createDataForSeoClient>;
