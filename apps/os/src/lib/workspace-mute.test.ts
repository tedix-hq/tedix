import { describe, expect, it } from "vite-plus/test";
import {
	WORKSPACE_MUTE_CHOICES,
	workspaceMuteLabel,
	workspaceMuteUntil,
} from "./workspace-mute";

describe("muting a workspace for a while", () => {
	const now = new Date(2026, 10, 18, 14, 0, 0);

	it("offers the five lengths in order", () => {
		expect(WORKSPACE_MUTE_CHOICES.map((choice) => choice.label)).toEqual([
			"1 hour",
			"3 hours",
			"Until tomorrow morning",
			"3 days",
			"Until I turn it back on",
		]);
	});

	it("works out when each choice ends", () => {
		expect(workspaceMuteUntil("1h", now)).toBe(
			new Date(2026, 10, 18, 15, 0, 0).toISOString(),
		);
		expect(workspaceMuteUntil("3h", now)).toBe(
			new Date(2026, 10, 18, 17, 0, 0).toISOString(),
		);
		expect(workspaceMuteUntil("3d", now)).toBe(
			new Date(now.getTime() + 72 * 60 * 60_000).toISOString(),
		);
		// Tomorrow morning is 08:00 the next day, also just after midnight.
		expect(workspaceMuteUntil("tomorrow", now)).toBe(
			new Date(2026, 10, 19, 8, 0, 0).toISOString(),
		);
		expect(
			workspaceMuteUntil("tomorrow", new Date(2026, 10, 18, 0, 30, 0)),
		).toBe(new Date(2026, 10, 19, 8, 0, 0).toISOString());
		expect(workspaceMuteUntil("manual", now)).toBeNull();
	});

	it("describes a mute by when it ends", () => {
		expect(workspaceMuteLabel(null, now)).toBe("Muted");
		expect(
			workspaceMuteLabel(new Date(2026, 10, 18, 14, 30).toISOString(), now),
		).toBe("Muted until 14:30");
		// Another day names the day, so 08:00 is not read as this morning.
		expect(
			workspaceMuteLabel(new Date(2026, 10, 19, 8, 0).toISOString(), now),
		).toMatch(/^Muted until \S+ 08:00$/);
	});
});
