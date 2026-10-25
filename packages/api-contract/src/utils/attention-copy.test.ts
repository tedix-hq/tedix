import { describe, expect, it } from "vite-plus/test";
import {
	ATTENTION_COPY,
	attentionSourceLabel,
	attentionStatusLabel,
	inactiveSessionLabel,
	localSessionInactive,
} from "./attention-copy";

describe("Attention copy", () => {
	it("contains no device guesses or personal labels", () => {
		expect(Object.values(ATTENTION_COPY).join(" ")).not.toMatch(
			/\b(laptop|offline|asleep|Lead|Aaron)\b/i,
		);
	});
	it("describes only the heartbeat age", () => {
		const now = new Date("2026-10-17T12:00:00Z");
		expect(inactiveSessionLabel("2026-10-17T11:48:00Z", now)).toBe(
			"Inactive · last seen 12 min ago",
		);
		expect(inactiveSessionLabel("2026-10-17 11:48:00", now)).toBe(
			"Inactive · last seen 12 min ago",
		);
		expect(localSessionInactive("2026-10-17T11:56:00Z", now)).toBe(false);
		expect(localSessionInactive("2026-10-17T11:55:00Z", now)).toBe(true);
		expect(localSessionInactive(null, now)).toBe(false);
		expect(inactiveSessionLabel(null, now)).toBe("Heartbeat not reported");
	});
	it("labels registered source kinds without inferring from names", () => {
		expect(attentionSourceLabel("local_codex")).toBe("Local · Codex");
		expect(attentionSourceLabel("local_claude")).toBe("Local · Claude");
		expect(attentionSourceLabel("cloud_tedi", "CTO")).toBe("Tedi (CTO)");
		expect(attentionSourceLabel("factory", "Inbox opportunities")).toBe(
			"Factory (Inbox opportunities)",
		);
		expect(attentionSourceLabel("coordinator")).toBe("Scheduled job");
		expect(attentionSourceLabel("unknown", "Codex")).toBe("Source unknown");
	});
	it("ages local sessions without changing observed cloud run states", () => {
		const now = new Date("2026-10-17T12:00:00Z");
		for (const [column, label] of [
			["moving", "Running"],
			["waiting", "Waiting on you"],
			["blocked", "Blocked: Approval denied"],
			["done", "Done"],
		] as const) {
			const card = {
				column,
				heartbeatAt: "2026-10-17T11:48:00Z",
				note: column === "blocked" ? "Approval denied" : "",
			};
			expect(
				attentionStatusLabel({ ...card, activitySource: "local_codex" }, now),
			).toBe("Inactive · last seen 12 min ago");
			for (const activitySource of [
				"cloud_tedi",
				"factory",
				"coordinator",
			] as const) {
				expect(attentionStatusLabel({ ...card, activitySource }, now)).toBe(
					label,
				);
				expect(
					attentionStatusLabel(
						{ ...card, heartbeatAt: null, activitySource },
						now,
					),
				).toBe(label);
			}
		}
	});
	it("keeps an open human question waiting regardless of its host heartbeat", () => {
		const now = new Date("2026-10-17T12:00:00Z");
		for (const heartbeatAt of [null, "2026-10-17T11:48:00Z"]) {
			expect(
				attentionStatusLabel(
					{
						source: "interaction",
						activitySource: "local_codex",
						column: "waiting",
						heartbeatAt,
						note: "Which address?",
					},
					now,
				),
			).toBe("Waiting on you");
		}
	});
});
