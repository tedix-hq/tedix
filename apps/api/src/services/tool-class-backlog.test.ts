import { describe, expect, it } from "vite-plus/test";
import {
	guessToolClassFromName,
	summarizeUndeclaredToolClasses,
} from "./tool-class-backlog";

describe("undeclared tool class backlog", () => {
	it("guesses from the name, camelCase included", () => {
		expect(guessToolClassFromName("deleteConfluencePage")).toBe("destructive");
		expect(guessToolClassFromName("createConfluencePage")).toBe("write");
		// The guess is only a guess: "issue" is on the money list, so creating
		// a Jira issue reads as destructive.
		expect(guessToolClassFromName("createJiraIssue")).toBe("destructive");
		expect(guessToolClassFromName("search_astro_docs")).toBe("no_write_verb");
		// The guess is only a guess: this one deletes and reads as nothing.
		expect(guessToolClassFromName("tidy_mailbox")).toBe("no_write_verb");
	});

	it("counts annotation answers apart from name guesses", () => {
		expect(
			summarizeUndeclaredToolClasses([
				{ toolId: "list_things", derivable: "read" },
				{ toolId: "createThing", derivable: null },
				{ toolId: "purge_cache", derivable: null },
				{ toolId: "atlassianUserInfo", derivable: null },
			]),
		).toEqual({
			total: 4,
			fromAnnotations: { read: 1, write: 0, destructive: 0 },
			fromNameGuess: { destructive: 1, write: 1, no_write_verb: 1 },
		});
	});
});
