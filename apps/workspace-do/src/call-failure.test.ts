import { expect, test } from "bun:test";
import { z } from "zod";
import {
	callFailureText,
	halfCharacterPath,
	unsavableTextError,
} from "./call-failure";

test("finds half of a character anywhere in a call's arguments", () => {
	expect(
		halfCharacterPath({
			outputId: "doc",
			content: { blocks: [{ text: "whole 😀" }, { text: "half \ud83d" }] },
		}),
	).toBe("content.blocks[1].text");
	expect(halfCharacterPath({ text: "low half first \ude00 here" })).toBe(
		"text",
	);
	expect(halfCharacterPath("\ud83d")).toBe("the text");
	expect(halfCharacterPath({ ["\ud83d"]: 1 })).toBe("a field name under it");
});

test("whole characters, numbers and empty values pass", () => {
	expect(
		halfCharacterPath({
			text: "😀 naïve 日本語 \u0000",
			rows: [[1, null, true, "👩‍👩‍👧"]],
			missing: undefined,
		}),
	).toBeNull();
	expect(unsavableTextError([{ text: "😀" }, 3])).toBeNull();
	expect(unsavableTextError([])).toBeNull();
});

test("the refusal names the field and says what to send instead", () => {
	const message = unsavableTextError([{ rows: [["ok", "cut \ud83d"]] }]);
	expect(message).toContain("rows[0][1] holds half of a character");
	expect(message).toContain("Nothing was changed");
	expect(message).toContain("Send whole characters");
	// The message itself is whole, so it can go back to the model.
	expect(halfCharacterPath(message)).toBeNull();
	expect(unsavableTextError(["fine", "\udc00"])).toContain("[1] holds");
});

test("refused arguments read as fields, not as a JSON dump", () => {
	const schema = z.object({
		expectedRevision: z.number(),
		content: z.object({ blocks: z.array(z.string()) }),
	});
	const refused = schema.safeParse({
		expectedRevision: "1",
		content: { blocks: "no" },
	});
	if (refused.success) throw new Error("The arguments should be refused");
	const text = callFailureText(refused.error);
	expect(text).toStartWith("Invalid arguments: expectedRevision: ");
	expect(text).toContain("; content.blocks: ");
	expect(text).not.toContain("{");
});

test("a thrown value that is not an Error is shown as it is", () => {
	expect(callFailureText(new Error("Revise failed: revision_conflict"))).toBe(
		"Revise failed: revision_conflict",
	);
	expect(callFailureText(new TypeError(""))).toBe("TypeError");
	expect(callFailureText("plain text")).toBe("plain text");
	expect(callFailureText({ code: "E_LOCKED", retry: false })).toBe(
		'The call threw {"code":"E_LOCKED","retry":false} instead of an Error',
	);
	expect(callFailureText(undefined)).toBe(
		"The call threw undefined instead of an Error",
	);
	expect(callFailureText(null)).toBe("The call threw null instead of an Error");
	expect(callFailureText("")).toBe('The call threw "" instead of an Error');
	const loop: Record<string, unknown> = {};
	loop.self = loop;
	expect(callFailureText(loop)).toBe(
		"The call threw [object Object] instead of an Error",
	);
	expect(callFailureText(10n)).toBe("The call threw 10 instead of an Error");
});
