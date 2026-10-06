import { describe, expect, test } from "bun:test";
import {
	approvalIdentity,
	keyboardOwner,
	questionIdentity,
	transitionInteraction,
	type InteractionContext,
	type InteractionMode,
} from "./tui-interaction";

const question = {
	homeRunId: "run",
	prompt: "Choose?",
	options: [{ label: "Yes", value: "yes" }],
	resolving: false,
};
const context: InteractionContext = {
	question: questionIdentity(question),
	approval: null,
	picker: false,
};

describe("exclusive terminal keyboard modes", () => {
	test("editing and inspection resume without reverting to option shortcuts", () => {
		let mode: InteractionMode = { kind: "default" };
		mode = transitionInteraction(context, mode, { type: "edit_question" });
		expect(keyboardOwner(context, mode)).toBe("question_editor");
		mode = transitionInteraction(context, mode, { type: "inspect_decision" });
		expect(keyboardOwner(context, mode)).toBe("decision_detail");
		mode = transitionInteraction(context, mode, { type: "back" });
		expect(keyboardOwner(context, mode)).toBe("question_editor");
		mode = transitionInteraction(context, mode, { type: "back" });
		expect(keyboardOwner(context, mode)).toBe("question_choices");
	});
	test("polling keeps logical decision identity while changed text and scope reset ownership", () => {
		expect(
			questionIdentity({
				...question,
				options: question.options.map((option) => ({ ...option })),
				resolving: true,
			}),
		).toBe(context.question);
		const mode = transitionInteraction(
			context,
			{ kind: "default" },
			{ type: "edit_question" },
		);
		expect(
			keyboardOwner(
				{
					...context,
					question: questionIdentity({ ...question, prompt: "New question" }),
				},
				mode,
			),
		).toBe("question_choices");
		const approval = {
			homeRunId: "run",
			targetLabel: "CTO",
			detail: "Review",
			scope: "read",
			scopeLabel: "Read",
			resolving: false,
		};
		expect(approvalIdentity(approval)).not.toBe(
			approvalIdentity({ ...approval, scope: "write" }),
		);
	});
	test("queue inspection freezes FIFO details and yields to a new decision", () => {
		const normal = { question: null, approval: null, picker: false };
		const entries = ["first", "second"];
		const mode = transitionInteraction(
			normal,
			{ kind: "default" },
			{ type: "inspect_queue", entries },
		);
		entries.shift();
		expect(mode).toEqual({
			kind: "queue_detail",
			entries: ["first", "second"],
		});
		expect(keyboardOwner(normal, mode)).toBe("queue_detail");
		expect(keyboardOwner(context, mode)).toBe("question_choices");
		expect(
			keyboardOwner(
				normal,
				transitionInteraction(normal, mode, { type: "back" }),
			),
		).toBe("composer");
	});
});
