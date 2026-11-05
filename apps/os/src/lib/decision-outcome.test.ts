import { describe, expect, it } from "vite-plus/test";
import { decisionOutcome, notUsefulAnswer } from "./decision-outcome";

const curation = (notUseful?: Record<string, unknown>) => ({
	curation: {
		schema: "tedix.deck-curation.v1",
		revision: 2,
		draftBody: null,
		status: "cancelled",
		successorId: null,
		penalty: 0,
		reason: "Not useful: already decided",
		evidenceRefs: [],
		model: null,
		exampleIds: [],
		...(notUseful ? { notUseful } : {}),
	},
});
const now = new Date("2026-11-05T12:00:00.000Z");

describe("decisionOutcome", () => {
	it("reads a not-useful answer in plain English with its time and note", () => {
		const outcome = decisionOutcome(
			{
				metadata: curation({
					reason: "already_decided",
					sourceKey: "external_agent:7e2202f0-ce78-46de-8a49-4505bd534d83",
					classKey: "decide|external_agent:7e22",
					at: "2026-11-05T08:44:00.000Z",
					note: "Done in Team settings",
				}),
			},
			"cancelled",
			now,
		);
		expect(outcome).toEqual({
			label: "Not needed",
			line: expect.stringMatching(
				/^You said not needed — already decided · \d{1,2}:\d{2}/,
			),
			note: "Done in Team settings",
		});
		expect(JSON.stringify(outcome)).not.toMatch(
			/external_agent|already_decided/,
		);
	});

	it("keeps an older not-useful answer without a time readable", () => {
		expect(
			decisionOutcome(
				{
					metadata: curation({
						reason: "agent_could_do",
						sourceKey: "s",
						classKey: "c",
					}),
				},
				"cancelled",
				now,
			)?.line,
		).toBe("You said not needed — an agent can do this");
	});

	it("tells an agent-withdrawn card apart from a not-useful answer", () => {
		const withdrawn = decisionOutcome({ metadata: curation() }, "cancelled");
		expect(withdrawn?.label).toBe("Withdrawn");
		expect(withdrawn?.line).not.toContain("You said");
		expect(notUsefulAnswer(curation().curation)).toBeNull();
		expect(decisionOutcome({ metadata: {} }, "resolved")?.line).toBe(
			"Answer saved",
		);
		expect(decisionOutcome({ metadata: {} }, "open")).toBeNull();
	});
});
