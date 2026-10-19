import { expect, it } from "vite-plus/test";
import { defaultDecisionExpiry } from "./decision-expiry";

const now = "2026-10-19T10:00:00.000Z";
it("uses class lifetimes before kind defaults, including relationship subtypes", () => {
	expect(
		defaultDecisionExpiry({ now, kind: "question", classId: "support.reply" }),
	).toBe("2026-10-22T10:00:00.000Z");
	expect(
		defaultDecisionExpiry({
			now,
			kind: "question",
			classId: "relationship.follow_up",
		}),
	).toBe("2026-11-02T10:00:00.000Z");
	expect(defaultDecisionExpiry({ now, kind: "outbound" })).toBe(
		"2026-10-26T10:00:00.000Z",
	);
});
it("preserves explicit expiry and extends defaults to a later due date", () => {
	const expiresAt = "2026-10-20T10:00:00.000Z";
	expect(defaultDecisionExpiry({ now, kind: "question", expiresAt })).toBe(
		expiresAt,
	);
	const dueAt = "2026-12-01T10:00:00.000Z";
	expect(defaultDecisionExpiry({ now, kind: "question", dueAt })).toBe(dueAt);
	expect(defaultDecisionExpiry({ now, kind: "handoff" })).toBeUndefined();
});
