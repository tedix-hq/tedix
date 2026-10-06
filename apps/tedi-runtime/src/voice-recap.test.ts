/**
 * Pure-logic regression for the live voice-call recap formatter.
 *
 * Mirrors the `node:assert` script style of `harness-version.test.ts` /
 * `ledger-mirror.test.ts` (run via `bun run src/voice-recap.test.ts`). The
 * recap text is the durable record of a finished browser voice call landed into
 * the canonical session, so its shape is load-bearing.
 */
import assert from "node:assert/strict";
import { buildVoiceCallRecap, formatDuration } from "./voice-recap";

function main() {
	// ── formatDuration ────────────────────────────────────────────────────────
	assert.equal(formatDuration(0), "0:00", "zero duration");
	assert.equal(formatDuration(-5), "0:00", "negative duration clamps");
	assert.equal(formatDuration(1000), "0:01", "one second");
	assert.equal(formatDuration(84_000), "1:24", "1:24");
	assert.equal(formatDuration(3_661_000), "1:01:01", "hours roll over");

	// ── empty transcript → single-line note (call still recorded) ─────────────
	const empty = buildVoiceCallRecap({ transcript: [] });
	assert.ok(
		empty.startsWith(
			"[Voice call] Live browser voice call ended with no transcript",
		),
		"empty transcript yields no-transcript note",
	);
	assert.ok(!empty.includes("\n"), "empty recap is a single line");

	// ── whitespace-only lines are dropped (count + digest) ────────────────────
	const blankOnly = buildVoiceCallRecap({
		transcript: [
			{ role: "user", content: "   " },
			{ role: "assistant", content: "" },
		],
	});
	assert.ok(
		blankOnly.includes("no transcript"),
		"all-blank transcript counts as empty",
	);

	// ── normal recap: header turn count + duration + digest lines ─────────────
	const recap = buildVoiceCallRecap({
		transcript: [
			{ role: "user", content: "Hey, can you check the deploy status?" },
			{ role: "assistant", content: "The production deploy is green." },
		],
		durationMs: 84_000,
	});
	assert.ok(recap.startsWith("[Voice call]"), "recap header prefix");
	assert.ok(recap.includes("(2 turns, 1:24)"), "turn count + duration");
	assert.ok(
		recap.includes("- user: Hey, can you check the deploy status?"),
		"includes user line",
	);
	assert.ok(
		recap.includes("- assistant: The production deploy is green."),
		"includes assistant line",
	);

	// ── singular turn wording ─────────────────────────────────────────────────
	const single = buildVoiceCallRecap({
		transcript: [{ role: "user", content: "hi" }],
	});
	assert.ok(single.includes("(1 turn)"), "singular turn, no duration");

	// ── long lines are clamped with an ellipsis ───────────────────────────────
	const longText = "x".repeat(500);
	const clamped = buildVoiceCallRecap({
		transcript: [{ role: "user", content: longText }],
		maxLineChars: 50,
	});
	const userLine = clamped.split("\n").find((l) => l.startsWith("- user:"))!;
	assert.ok(userLine.endsWith("…"), "clamped line ends with ellipsis");
	assert.ok(
		userLine.length <= "- user: ".length + 50,
		"clamped line within budget",
	);

	// ── only the most recent maxLines turns are kept ──────────────────────────
	const many = buildVoiceCallRecap({
		transcript: Array.from({ length: 30 }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `line ${i}`,
		})),
		maxLines: 5,
	});
	const bodyLines = many.split("\n").filter((l) => l.startsWith("- "));
	assert.equal(bodyLines.length, 5, "digest capped at maxLines");
	assert.ok(many.includes("line 29"), "keeps the tail (most recent)");
	assert.ok(!many.includes("line 0:"), "drops the head (oldest)");
	assert.ok(
		many.startsWith("[Voice call] Live browser voice call ended (30 turns)"),
		"header counts ALL turns, not just digest",
	);

	console.log("voice-recap.test.ts: all assertions passed");
}

main();
