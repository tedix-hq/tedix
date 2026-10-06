import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { createElement } from "react";
import { render, Text } from "ink";
import { renderBanner, type BannerContext } from "./banner";

const originalLogo = process.env.TEDIX_LOGO;
afterEach(() => {
	if (originalLogo === undefined) delete process.env.TEDIX_LOGO;
	else process.env.TEDIX_LOGO = originalLogo;
});

const context: BannerContext = {
	version: "0.1.0-beta.104",
	workspace: "Operations 東京 👨‍👩‍👧‍👦 workspace",
	gatewayUrl: "https://operations.mcp.tedix.dev/mcp",
	cwd: "/workspace/large-project/東京/meeting-notes",
	color: { enabled: false },
};

function plain(ctx: BannerContext): string[] {
	return renderBanner(ctx).map(stripVTControlCharacters);
}

describe("renderer-width startup banner", () => {
	for (const columns of [30, 40]) {
		for (const enabled of [false, true]) {
			test(`${columns} columns keeps complete identity and a compact header with color ${enabled}`, () => {
				delete process.env.TEDIX_LOGO;
				const lines = plain({ ...context, columns, color: { enabled } });
				expect(lines.every((line) => Bun.stringWidth(line) < columns)).toBe(
					true,
				);
				expect(lines.join("\n")).not.toContain("█");
				expect(lines.join("\n")).toContain("tedix");
				const body = lines
					.filter((line) => line.startsWith("│ "))
					.map((line) => line.slice(2, -2).trim())
					.join("")
					.replace(/\s/g, "");
				for (const identity of [
					context.workspace,
					"operations.mcp.tedix.dev",
					context.cwd,
				]) {
					expect(body).toContain(identity.replace(/\s/g, ""));
				}
				for (const label of ["Workspace:", "Gateway:", "Directory:"])
					expect(body).toContain(label);
			});
		}
	}

	test("wide streams retain the complete default wordmark", () => {
		delete process.env.TEDIX_LOGO;
		const lines = plain({ ...context, columns: 100 });
		expect(lines.filter((line) => /[█╚]/.test(line))).toHaveLength(6);
		expect(lines.every((line) => Bun.stringWidth(line) < 100)).toBe(true);
	});

	test("logo override is read per banner, including empty and wide emoji marks", () => {
		process.env.TEDIX_LOGO = "🪐";
		const marked = plain({ ...context, columns: 30 });
		expect(marked.join("\n")).toContain("🪐 tedix");
		expect(marked.every((line) => Bun.stringWidth(line) < 30)).toBe(true);
		process.env.TEDIX_LOGO = "";
		const bare = plain({ ...context, columns: 80 }).join("\n");
		expect(bare).toContain("tedix");
		expect(bare).not.toMatch(/[🪐█]/u);
	});

	test("missing or invalid columns have a bounded non-TTY fallback", () => {
		delete process.env.TEDIX_LOGO;
		for (const columns of [undefined, Number.NaN, Infinity]) {
			const lines = plain({ ...context, columns });
			expect(lines.every((line) => Bun.stringWidth(line) < 80)).toBe(true);
		}
	});

	test("semantic banner keeps full identity without decorations on generic streams", async () => {
		const lines = renderBanner({ ...context, columns: 30, screenReader: true });
		expect(lines).toContain(`Workspace: ${context.workspace}`);
		expect(lines).toContain(`Gateway: operations.mcp.tedix.dev`);
		expect(lines).toContain(`Directory: ${context.cwd}`);
		expect(lines.join("\n")).not.toMatch(/[█╭╰│·]/u);
		const stdout = new PassThrough();
		const stdin = new PassThrough();
		let output = "";
		stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		const instance = render(createElement(Text, null, lines.join("\n")), {
			stdout,
			stdin,
			stderr: stdout,
			isScreenReaderEnabled: true,
			interactive: true,
			patchConsole: false,
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			await instance.waitUntilRenderFlush();
			const rendered = stripVTControlCharacters(output);
			expect(rendered).toContain("Workspace:");
			expect(rendered).toContain("Alt+Enter newline");
			expect(rendered).toContain("Ctrl+Q queue");
			expect(rendered).not.toMatch(/[█╭╰│·]/u);
		} finally {
			instance.unmount();
			instance.cleanup();
		}
	});
});
