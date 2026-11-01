#!/usr/bin/env node
// Checks the published plugin tree: every manifest parses, agrees on the
// version, points at the Tedix gateway over HTTPS, ships no hooks or
// credentials, and every skill has a SKILL.md with a name and description.
// Runs with Node alone; this repository has no dependencies.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? ".";
const errors = [];
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => {
	try {
		return JSON.parse(read(path));
	} catch (error) {
		errors.push(`${path}: ${error.message}`);
		return undefined;
	}
};

const manifests = {
	"plugin.json": json("plugin.json"),
	".claude-plugin/plugin.json": json(".claude-plugin/plugin.json"),
	".codex-plugin/plugin.json": json(".codex-plugin/plugin.json"),
	".devin-plugin/plugin.json": json(".devin-plugin/plugin.json"),
	"gemini-extension.json": json("gemini-extension.json"),
};
const versions = new Set(
	Object.values(manifests)
		.filter(Boolean)
		.map((manifest) => manifest.version),
);
if (versions.size !== 1)
	errors.push(`manifests disagree on version: ${[...versions].join(", ")}`);
for (const [path, manifest] of Object.entries(manifests)) {
	if (manifest && "hooks" in manifest)
		errors.push(`${path}: the public repository ships no hooks`);
}

const GATEWAY = "https://connect.mcp.tedix.dev/mcp";
for (const path of ["mcp.json", ".mcp.json"]) {
	const url = json(path)?.mcpServers?.tedix?.url;
	if (url !== GATEWAY) errors.push(`${path}: server url is ${url}`);
}
if (manifests["gemini-extension.json"]?.mcpServers?.tedix?.httpUrl !== GATEWAY)
	errors.push("gemini-extension.json: server httpUrl is not the gateway");

for (const name of readdirSync(join(root, "skills"))) {
	const skill = `skills/${name}/SKILL.md`;
	let text;
	try {
		text = read(skill);
	} catch {
		errors.push(`${skill}: missing`);
		continue;
	}
	const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
	if (!/^name:\s*\S/m.test(front) || !/^description:\s*\S/m.test(front))
		errors.push(`${skill}: frontmatter needs name and description`);
}

// Credential shapes that must never reach a public plugin tree.
const SECRET =
	/(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.)/;
const walk = (dir) => {
	for (const entry of readdirSync(join(root, dir || "."))) {
		if (entry === ".git" || entry === "node_modules") continue;
		const path = dir ? `${dir}/${entry}` : entry;
		if (statSync(join(root, path)).isDirectory()) walk(path);
		else if (/\.(md|json|js|mjs|yml|yaml|txt)$/.test(path)) {
			read(path)
				.split("\n")
				.forEach((line, index) => {
					if (SECRET.test(line))
						errors.push(`${path}:${index + 1}: credential-shaped value`);
				});
		} else if (/^hooks\//.test(path) || /\.(env|pem|key)$/.test(path))
			errors.push(`${path}: must not be published`);
	}
};
walk("");

if (errors.length > 0) {
	console.error(errors.map((error) => `- ${error}`).join("\n"));
	process.exit(1);
}
console.log(
	`plugin tree ok: ${Object.keys(manifests).length} manifests at version ${[...versions][0]}`,
);
