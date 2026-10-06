export const TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION = "tedix-prod";
export const TEDIX_ARTIFACTS_DEFAULT_BRANCH = "main";
export const TEDIX_ARTIFACTS_WRITE_TOKEN_TTL_SECONDS = 3_600;
export const TEDIX_ARTIFACTS_R2_BUCKET_NAME = "tedix-tedi-production";
export function artifactsRepoNameForTediId(tediId: string): string {
	return tediId;
}

export function artifactsRepoDescriptionForTediSlug(slug: string): string {
	return `Tedix operating text state for ${slug}`;
}

export function isArtifactsErrorCode(error: unknown, code: string): boolean {
	const expected = code.toUpperCase();
	if (typeof error === "object" && error !== null && "code" in error) {
		const value = (error as { code?: unknown }).code;
		if (typeof value === "string" && value.toUpperCase() === expected) {
			return true;
		}
	}

	// Miniflare remote Artifacts bindings can flatten Cloudflare errors into
	// Error.message without preserving the structured `code` field.
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	const normalized = message.toLowerCase();
	if (expected === "NOT_FOUND") {
		return normalized.includes("repository not found");
	}
	if (expected === "ALREADY_EXISTS") {
		return normalized.includes("already exists");
	}
	return false;
}

export interface DailyLogArtifactEntry {
	ts: number;
	role: "user" | "assistant";
	content: string;
	turnId: string;
}

export interface DailyLogArtifactBatch {
	date: string;
	entries: DailyLogArtifactEntry[];
}

export interface DailyLogArtifactFileWrite {
	/** Repo-relative path: `workspace/daily/YYYY-MM-DD.md`. */
	path: string;
	/** Full file content after this batch is applied. */
	content: string;
}

export function dailyLogArtifactPath(date: string): string {
	return `workspace/daily/${date}.md`;
}

export function formatDailyLogEntry(entry: DailyLogArtifactEntry): string {
	const iso = new Date(entry.ts).toISOString();
	const content = entry.content.trim();
	return `\n## ${iso}  ${entry.role}  \`${entry.turnId}\`\n\n${content}\n\n---\n`;
}

export function utcDateSlug(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10);
}

export interface TurnSummaryArtifactBody {
	turn: {
		turnId: string;
		user: string;
		assistant: string;
	};
	observations: Array<{
		content: string;
		priority?: string;
		type?: string;
	}>;
	currentTasks: string[];
	suggestedResponse: string | null;
}

export interface TurnSummaryArtifactInput {
	tediId: string;
	conversationId: string;
	runId: string;
	turnId: string;
	observerSummary: {
		observations: TurnSummaryArtifactBody["observations"];
		currentTasks?: string[];
		suggestedResponse?: string;
	};
	userText: string;
	assistantText: string;
}
