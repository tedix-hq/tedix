import { CMS_TEMPLATE_SLUGS } from "../src/template-policy";
import { fileURLToPath } from "node:url";

const commands = [["bun", "install", "--frozen-lockfile"]];
if (!process.argv.includes("--install-only"))
	commands.push(["bun", "run", "build"]);

for (const slug of CMS_TEMPLATE_SLUGS) {
	const cwd = fileURLToPath(new URL(`../templates/${slug}/`, import.meta.url));
	for (const command of commands) {
		const code = await Bun.spawn(command, {
			cwd,
			stdout: "inherit",
			stderr: "inherit",
		}).exited;
		if (code !== 0) process.exit(code);
	}
}
