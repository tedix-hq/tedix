/**
 * Voice-call recap formatting — PURE helpers (no SDK / DO / network types) so
 * they are unit-testable offline with `node:assert`.
 *
 * When a live browser voice call ends, the `VoiceCallDO` (sibling DO, holds NO
 * canonical state) asks the canonical `AgentTediDO` to land a COMPACT recap
 * turn into the same conversation the call was keyed on. This mirrors the runtime
 * recap-to-session behavior: the durable record of the call is
 * a single session turn in the cognitive ledger, NOT the voice package's
 * ephemeral `cf_voice_messages` SQLite table.
 *
 * The recap is intentionally terse: a one-line header plus an optional short
 * transcript digest. It is authored as an `assistant`-role turn (a note the
 * tedi made about its own call) so it shows up as a real, ledger-mirrored turn
 * the NEXT chat/voice turn sees as context — without spending an LLM round-trip.
 */

/** One transcript line as captured by the voice pipeline during a live call. */
export interface VoiceRecapTurn {
	role: "user" | "assistant";
	content: string;
}

export interface VoiceRecapInput {
	/** Transcript lines captured during the call (ephemeral, voice-DO-local). */
	transcript: ReadonlyArray<VoiceRecapTurn>;
	/** Call duration in milliseconds, if known. */
	durationMs?: number;
	/** Max transcript lines to include in the digest. @default 12 */
	maxLines?: number;
	/** Max characters per quoted line in the digest. @default 200 */
	maxLineChars?: number;
}

const DEFAULT_MAX_LINES = 12;
const DEFAULT_MAX_LINE_CHARS = 200;

/** Human-friendly mm:ss (or h:mm:ss) from a millisecond duration. */
export function formatDuration(durationMs: number): string {
	if (!Number.isFinite(durationMs) || durationMs <= 0) return "0:00";
	const totalSeconds = Math.round(durationMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
	const ss = String(seconds).padStart(2, "0");
	return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function clampLine(text: string, maxChars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= maxChars) return flat;
	return `${flat.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Build the compact recap turn text for a finished live voice call. PURE.
 *
 * Shape:
 *   [Voice call] Live browser voice call ended (3 turns, 1:24).
 *   - user: …
 *   - assistant: …
 *
 * When the call had no usable transcript (e.g. caller hung up before speaking),
 * returns a single-line note. NOTE: as of the empty-call guard in
 * `VoiceCallDO.onCallEnd`, an empty call no longer reaches this function — the
 * sibling DO skips the recap consult entirely so no turn pair lands in the
 * canonical session. The zero-turn branch is retained as defense-in-depth for
 * any other caller.
 */
export function buildVoiceCallRecap(input: VoiceRecapInput): string {
	const maxLines = input.maxLines ?? DEFAULT_MAX_LINES;
	const maxLineChars = input.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;

	const lines = input.transcript.filter(
		(t) => typeof t.content === "string" && t.content.trim().length > 0,
	);
	const turnCount = lines.length;
	const durationPart =
		input.durationMs != null && input.durationMs > 0
			? `, ${formatDuration(input.durationMs)}`
			: "";

	const header =
		turnCount === 0
			? `[Voice call] Live browser voice call ended with no transcript${durationPart}.`
			: `[Voice call] Live browser voice call ended (${turnCount} ${
					turnCount === 1 ? "turn" : "turns"
				}${durationPart}).`;

	if (turnCount === 0) return header;

	// Keep the most recent `maxLines` turns (the tail of the conversation is the
	// most relevant context for the next turn).
	const digestTurns = lines.slice(-maxLines);
	const body = digestTurns
		.map((t) => `- ${t.role}: ${clampLine(t.content, maxLineChars)}`)
		.join("\n");

	return `${header}\n${body}`;
}
