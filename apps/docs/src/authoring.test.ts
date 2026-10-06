import { DOCS_TOOL_SCOPES } from "@tedix/api-contract/contracts/docs-tool-scopes";
import { describe, expect, it, vi } from "vite-plus/test";
import { assertDocsFilePath } from "./authoring-policy";
import { getDocsFile } from "./authoring";

const sandbox = vi.hoisted(() => ({
	writeFile: async () => {},
	exec: undefined as unknown as (argv: string[]) => Promise<unknown>,
}));
vi.mock("./sandbox", () => ({ getDocsSandbox: () => sandbox }));

describe("docs Git authoring boundary", () => {
	it("reads the exact captured revision rather than mutable HEAD", async () => {
		const revision = "a".repeat(40);
		const commands: string[] = [];
		sandbox.exec = async (argv: string[]) => {
			const command = argv.at(-1)!;
			commands.push(command);
			return {
				output: async () => ({
					exitCode: 0,
					timedOut: false,
					truncated: false,
					stdout: command.includes("git clone") ? `${revision}\n` : "# Guide\n",
					stderr: "",
				}),
			};
		};
		const env = {
			ARTIFACTS: {
				get: async () => ({
					createToken: async () => ({ plaintext: Promise.resolve("token") }),
					remote: Promise.resolve("https://artifacts.example/docs.git"),
				}),
			},
		};
		const file = await getDocsFile(
			env as never,
			{
				sourceProvider: "artifacts",
				artifactsRepository: "docs",
				repositoryUrl: null,
				branch: "main",
				contentRoot: "docs",
			} as never,
			"guide.md",
		);
		expect(file).toMatchObject({
			content: "# Guide\n",
			revision,
			path: "guide.md",
		});
		// The read runs as `bash -lc '<git command>'`; unwrap the one quoting layer.
		const show = commands
			.find((command) => command.includes(" show "))!
			.replace(/^bash -lc '/, "")
			.replace(/'$/, "")
			.replaceAll("'\\''", "'");
		expect(show).toContain(`show '${revision}':'docs/guide.md'`);
		expect(show).not.toContain("HEAD");
	});
	it.each([
		["index.md", "index.md"],
		["guides/getting-started.mdx", "guides/getting-started.mdx"],
		["guides\\windows.md", "guides/windows.md"],
	])("accepts safe public Markdown paths", (input, expected) => {
		expect(assertDocsFilePath(input)).toBe(expected);
	});

	it.each([
		"../private/secrets.md",
		"/absolute.md",
		"./relative.md",
		"guide/../private.md",
		"image.png",
		"",
	])("rejects paths outside the configured Markdown surface", (input) => {
		expect(() => assertDocsFilePath(input)).toThrow();
	});
});

describe("docs MCP scope policy", () => {
	it("keeps reads, proposals, and public releases on distinct scope tiers", () => {
		expect(DOCS_TOOL_SCOPES.get_docs_file).toBe("mcp:content.read");
		expect(DOCS_TOOL_SCOPES.search_docs).toBe("mcp:content.read");
		expect(DOCS_TOOL_SCOPES.propose_docs_change).toBe("mcp:content.write");
		expect(DOCS_TOOL_SCOPES.start_docs_build).toBe("mcp:content.write");
		expect(DOCS_TOOL_SCOPES.commit_docs_change).toBe("mcp:content.admin");
		expect(DOCS_TOOL_SCOPES.publish_docs_build).toBe("mcp:content.admin");
		expect(DOCS_TOOL_SCOPES.rollback_docs_build).toBe("mcp:content.admin");
	});

	it("assigns every registered tool to one canonical content scope", () => {
		for (const scope of Object.values(DOCS_TOOL_SCOPES)) {
			expect([
				"mcp:content.read",
				"mcp:content.write",
				"mcp:content.admin",
			]).toContain(scope);
		}
	});
});
