import { validateSpec } from "@json-render/core";
import { describe, expect, it } from "vite-plus/test";
import { parseSpec, parseYamlSpec } from "./spec-assembler";

/**
 * The assembler builds a Spec with `@json-render/yaml`'s compiler and this repo
 * validates it with `@json-render/core`. Every `@json-render/*` package pins
 * core as an exact dependency rather than a peer, so a version skew installs
 * two cores and the spec is then built by one and validated by another.
 *
 * These cases use shapes only json-render 0.20 understands — nested repeats
 * addressed through an item-relative `statePath`, and a `visible` condition
 * scoped to `$item`. Under a split install the validating core is the older one
 * and rejects them, so this suite fails loudly instead of the skew surfacing as
 * a blank widget in production.
 */
describe("spec-assembler single-core invariant", () => {
	it("round-trips a nested repeat with an item-relative state path", () => {
		const spec = parseYamlSpec(`
root: main
elements:
  main:
    type: Stack
    props:
      direction: vertical
    children: [groups]
  groups:
    type: Stack
    repeat:
      statePath: /groups
      key: id
    children: [rows]
  rows:
    type: Stack
    repeat:
      statePath:
        $item: items
      key: id
    children: [cell]
  cell:
    type: Text
    props:
      content:
        $item: label
state:
  groups:
    - id: g1
      items:
        - id: i1
          label: first
`);
		expect(spec).not.toBeNull();
		const result = validateSpec(spec as never);
		expect(result.issues ?? []).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("accepts an item-scoped visible condition on a repeating element", () => {
		const spec = parseYamlSpec(`
root: main
elements:
  main:
    type: Stack
    children: [list]
  list:
    type: Stack
    repeat:
      statePath: /rows
      key: id
    visible:
      $item: active
    children: [label]
  label:
    type: Text
    props:
      content:
        $item: name
state:
  rows:
    - id: r1
      name: visible row
      active: true
    - id: r2
      name: hidden row
      active: false
`);
		expect(spec).not.toBeNull();
		const result = validateSpec(spec as never);
		expect(result.issues ?? []).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("parseSpec routes YAML through the same compiler", () => {
		const spec = parseSpec(`\`\`\`yaml
root: main
elements:
  main:
    type: Text
    props:
      content: hello
\`\`\``);
		expect(spec).not.toBeNull();
		expect(validateSpec(spec as never).valid).toBe(true);
	});
});
