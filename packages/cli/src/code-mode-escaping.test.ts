import { expect, it, spyOn } from "bun:test";
import { readCodeResultHandle } from "./code-result";
import { callHomeTool } from "./home-client-code-reads";
import { runFlowCommand, type FlowContext } from "./flow";
import { runSkillCommand, type SkillContext } from "./skill";

const hostile =
	'"; throw new Error("escaped"); // ` ${escape()} </script>\u2028\u2029 end';
function execute(source: string, namespace: string, tools: object) {
	expect(source).not.toContain("</script>");
	expect(source).not.toMatch(/[\u2028\u2029]/);
	return new Function(namespace, `return (${source})()`)(tools);
}

it("keeps a result handle inside discover.read_result arguments", async () => {
	let calls = 0;
	const value = await readCodeResultHandle(
		async (source) =>
			execute(source, "discover", {
				read_result: (input: unknown) => {
					calls++;
					expect(input).toEqual({ handle: hostile, offset: 0, limit: 20_000 });
					return { complete: true, value: "read" };
				},
			}),
		hostile,
	);
	expect(value).toBe("read");
	expect(calls).toBe(1);
});

it("keeps Home tool arguments as data", async () => {
	const args = { text: hostile };
	const result = await callHomeTool.call(
		{
			callTool: async (name, input) => {
				expect(name).toBe("code");
				return execute(input.code as string, "home", {
					read_home_run: (value: unknown) => value,
				});
			},
		},
		"read_home_run",
		args,
	);
	expect(result).toEqual(args);
});

it("keeps flow parameters as data while preserving prototype-named keys", async () => {
	const stdout = spyOn(console, "log").mockImplementation(() => {});
	let received: unknown;
	const runCode = async (source: string) =>
		execute(source, "flow", {
			run: (input: { params: unknown }) => {
				received = input.params;
				return { skillId: "skill", runId: "run" };
			},
		});
	const params = JSON.parse('{"__proto__":{"value":1}}');
	params.text = hostile;
	const ctx = {
		client: { runCode, runCodeWithDestructiveApproval: runCode },
		color: { enabled: false },
		json: true,
		workspace: "sample",
		flow: {
			skill: "5eed0005-0000-4000-8000-000000000005",
			params: JSON.stringify(params),
		},
	} as FlowContext;
	try {
		expect(await runFlowCommand("run", ctx)).toBe(0);
		expect(received).toEqual(params);
		expect(Object.hasOwn(received as object, "__proto__")).toBe(true);
	} finally {
		stdout.mockRestore();
	}
});

it.each(["sample-skill", "5eed0005-0000-4000-8000-000000000005"])(
	"keeps skill file paths as data through the %s read branch",
	async (id) => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		let calls = 0;
		const ctx = {
			client: {
				runCode: async (source: string) =>
					execute(source, "skills", {
						get_skills_for_mcp: (input: unknown) => {
							expect(input).toEqual({ slug: id });
							return null;
						},
						list_skills_by_org: (input: unknown) => {
							expect(input).toEqual({
								query: id,
								limit: 20,
								offset: 0,
								summary: true,
							});
							return { entries: [{ slug: "other" }, { slug: id, id }] };
						},
						get_skills: (input: unknown) => {
							calls++;
							expect(input).toEqual({ id });
							return { files: { [hostile]: "file content" } };
						},
					}),
			},
			color: { enabled: false },
			json: true,
			workspace: "sample",
			flow: { file: hostile },
		} as SkillContext;
		try {
			expect(await runSkillCommand(`show ${id}`, ctx)).toBe(0);
			expect(calls).toBe(1);
			expect(stdout.mock.calls[0]?.[0]).toBe(
				JSON.stringify({ path: hostile, content: "file content" }),
			);
		} finally {
			stdout.mockRestore();
		}
	},
);

it("rejects a hostile skill identifier before generating a program", async () => {
	let calls = 0;
	const stderr = spyOn(console, "error").mockImplementation(() => {});
	const ctx = {
		client: {
			runCode: async () => {
				calls++;
			},
		},
		flow: {},
		color: { enabled: false },
	} as unknown as SkillContext;
	try {
		expect(await runSkillCommand(`show ${hostile}`, ctx)).toBe(2);
		expect(calls).toBe(0);
	} finally {
		stderr.mockRestore();
	}
});
