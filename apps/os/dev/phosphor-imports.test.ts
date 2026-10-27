// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { phosphorImports } from "./phosphor-imports";

describe("development icon imports", () => {
	const plugin = phosphorImports();
	it("uses the installed barrel's leaf exports, including aliases and renamed imports", () => {
		const result = plugin.transform(
			'import { BellSimpleIcon as Bell, ActivityIcon, IconContext, IconBase } from "@phosphor-icons/react"; export { Bell };',
			"component.tsx",
		);
		expect(result?.code).toContain(
			'import { BellSimpleIcon as Bell } from "@phosphor-icons/react/dist/csr/BellSimple";',
		);
		expect(result?.code).toContain(
			'import { PulseIcon as ActivityIcon } from "@phosphor-icons/react/dist/csr/Pulse";',
		);
		expect(result?.code).toContain(
			'from "@phosphor-icons/react/dist/lib/context";',
		);
		expect(result?.code).toContain(
			'import IconBase from "@phosphor-icons/react/dist/lib/IconBase";',
		);
		expect(result?.code).toContain("export { Bell };");
	});

	it("handles dependency JS as well as source JSX without changing rendered content", () => {
		const source =
			'import { Check as c } from "@phosphor-icons/react"; export const App = () => <span>✓</span>;';
		expect(
			plugin
				.transform(source, "view.tsx")
				?.code.endsWith("export const App = () => <span>✓</span>;"),
		).toBe(true);
		expect(
			plugin.transform(
				'import { Check as c } from "@phosphor-icons/react";',
				"kumo.js",
			)?.code,
		).toContain("dist/csr/Check");
	});

	it("preserves type, namespace, unsupported and already direct imports", () => {
		for (const source of [
			'import type { Icon } from "@phosphor-icons/react";',
			'import { type Icon, Check } from "@phosphor-icons/react";',
			'import * as Icons from "@phosphor-icons/react";',
			'import { SSR } from "@phosphor-icons/react";',
			'import { Check } from "@phosphor-icons/react/dist/csr/Check";',
		])
			expect(plugin.transform(source, "view.tsx")).toBeNull();
	});
});
