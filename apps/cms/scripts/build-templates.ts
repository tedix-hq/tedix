import { CMS_TEMPLATE_SLUGS } from "../src/template-policy";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { checkPublicJsBudget } from "./public-js-budget";

const templateFlag = process.argv.indexOf("--template");
const selectedTemplate =
	templateFlag === -1 ? null : process.argv[templateFlag + 1];
const templates = CMS_TEMPLATE_SLUGS.filter(
	(slug) => selectedTemplate === null || slug === selectedTemplate,
);
if (templates.length === 0)
	throw new Error(`Unknown CMS template: ${selectedTemplate}`);

const installOnly = process.argv.includes("--install-only");
const commands = [["bun", "install", "--frozen-lockfile"]];
if (!installOnly) {
	commands.push([
		"bun",
		"run",
		"build",
		"--config",
		"../../scripts/template-validation.config.mjs",
	]);
}

for (const slug of templates) {
	const cwd = fileURLToPath(new URL(`../templates/${slug}/`, import.meta.url));
	for (const command of commands) {
		const code = await Bun.spawn(command, {
			cwd,
			stdout: "inherit",
			stderr: "inherit",
		}).exited;
		if (code !== 0) process.exit(code);
	}
	if (!installOnly) {
		console.log(
			`[${slug}] public JS:`,
			await checkPublicJsBudget(resolve(cwd, "dist/client")),
		);
	}
}
