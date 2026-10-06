/**
 * Test Input Generator
 *
 * Generates test inputs from JSON Schema definitions without using AI.
 * Uses sensible defaults based on property names and types.
 * Can also use real example prompts extracted from ChatGPT app pages.
 */

// =============================================================================
// Types
// =============================================================================

interface JSONSchemaProperty {
	type?: string;
	enum?: unknown[];
	default?: unknown;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	format?: string;
	items?: JSONSchemaProperty;
	properties?: Record<string, JSONSchemaProperty>;
	required?: string[];
	description?: string;
}

export interface JSONSchema {
	type?: string;
	properties?: Record<string, JSONSchemaProperty>;
	required?: string[];
}

/**
 * Example prompt extracted from a ChatGPT app page
 */
export interface ExamplePrompt {
	raw: string;
	cleanPrompt: string;
	appMention: string;
}

/**
 * Options for generating test inputs
 */
export interface GenerateTestInputOptions {
	/** Example prompts from the app page - used to extract realistic values */
	examplePrompts?: ExamplePrompt[];
	/** Tool name to help match relevant prompts */
	toolName?: string;
	/** Tool description to help match relevant prompts */
	toolDescription?: string;
}

// =============================================================================
// Smart Defaults by Property Name
// =============================================================================

/**
 * Map of property name patterns to sensible default values
 */
const NAME_DEFAULTS: Array<{
	patterns: RegExp[];
	generator: () => unknown;
}> = [
	// IDs and identifiers
	{
		patterns: [/^id$/i, /Id$/i, /_id$/i, /uuid$/i],
		generator: () => "test-id-123",
	},
	// Queries and searches
	{
		patterns: [/^query$/i, /^search$/i, /^q$/i, /^term$/i, /^keyword/i],
		generator: () => "test search query",
	},
	// Names
	{
		patterns: [/^name$/i, /Name$/i, /^title$/i],
		generator: () => "Test Name",
	},
	// Emails
	{
		patterns: [/email/i, /^e-?mail$/i],
		generator: () => "test@example.com",
	},
	// URLs
	{
		patterns: [/^url$/i, /Url$/i, /^link$/i, /^href$/i, /^uri$/i],
		generator: () => "https://example.com",
	},
	// Descriptions and text
	{
		patterns: [/^description$/i, /^desc$/i, /^content$/i, /^body$/i, /^text$/i],
		generator: () => "This is a test description.",
	},
	// Limits and pagination
	{
		patterns: [/^limit$/i, /^count$/i, /^size$/i, /^pageSize$/i],
		generator: () => 10,
	},
	{
		patterns: [/^offset$/i, /^skip$/i, /^page$/i],
		generator: () => 0,
	},
	// Dates
	{
		patterns: [
			/date/i,
			/time/i,
			/^at$/i,
			/^from$/i,
			/^to$/i,
			/^start$/i,
			/^end$/i,
		],
		generator: () => new Date().toISOString(),
	},
	// Locations
	{
		patterns: [/^location$/i, /^city$/i, /^address$/i, /^place$/i],
		generator: () => "Berlin, Germany",
	},
	{
		patterns: [/^lat$/i, /^latitude$/i],
		generator: () => 52.52,
	},
	{
		patterns: [/^lon$/i, /^lng$/i, /^longitude$/i],
		generator: () => 13.405,
	},
	// Prices and money
	{
		patterns: [/price/i, /cost/i, /amount/i, /^min$/i, /^max$/i],
		generator: () => 100,
	},
	{
		patterns: [/currency/i],
		generator: () => "USD",
	},
	// Categories and types
	{
		patterns: [/^type$/i, /^category$/i, /^kind$/i],
		generator: () => "default",
	},
	// Phone numbers
	{
		patterns: [/phone/i, /mobile/i, /tel/i],
		generator: () => "+1234567890",
	},
	// Countries and regions
	{
		patterns: [/^country$/i, /^countryCode$/i, /^region$/i],
		generator: () => "US",
	},
	// Language
	{
		patterns: [/^lang$/i, /^language$/i, /^locale$/i],
		generator: () => "en",
	},
	// Sort and order
	{
		patterns: [/^sort$/i, /^order$/i, /^sortBy$/i, /^orderBy$/i],
		generator: () => "relevance",
	},
	// Filters and flags
	{
		patterns: [/^filter$/i, /^enabled$/i, /^active$/i, /^visible$/i],
		generator: () => true,
	},
];

// =============================================================================
// Generator Functions
// =============================================================================

/**
 * Get a default value based on property name
 */
function getDefaultByName(name: string): unknown | undefined {
	for (const { patterns, generator } of NAME_DEFAULTS) {
		if (patterns.some((p) => p.test(name))) {
			return generator();
		}
	}
	return undefined;
}

/**
 * Generate a value for a JSON Schema property
 */
function generateValue(name: string, schema: JSONSchemaProperty): unknown {
	// Use explicit default if provided
	if (schema.default !== undefined) {
		return schema.default;
	}

	// Use enum value if available
	if (schema.enum && schema.enum.length > 0) {
		return schema.enum[0];
	}

	// Try to get smart default by name
	const nameDefault = getDefaultByName(name);
	if (nameDefault !== undefined) {
		return nameDefault;
	}

	// Fall back to type-based defaults
	switch (schema.type) {
		case "string":
			return generateStringValue(name, schema);
		case "number":
		case "integer":
			return generateNumberValue(schema);
		case "boolean":
			return true;
		case "array":
			return generateArrayValue(name, schema);
		case "object":
			return generateObjectValue(schema);
		case "null":
			return null;
		default:
			// For unknown types, return a simple string
			return "test";
	}
}

/**
 * Generate a string value based on format or pattern
 */
function generateStringValue(name: string, schema: JSONSchemaProperty): string {
	// Handle known formats
	switch (schema.format) {
		case "email":
			return "test@example.com";
		case "uri":
		case "url":
			return "https://example.com";
		case "date":
			return new Date().toISOString().split("T")[0] ?? "2024-01-15";
		case "date-time":
			return new Date().toISOString();
		case "time":
			return "12:00:00";
		case "uuid":
			return "550e8400-e29b-41d4-a716-446655440000";
		case "hostname":
			return "example.com";
		case "ipv4":
			return "192.168.1.1";
		case "ipv6":
			return "::1";
	}

	// Use minLength/maxLength hints
	const minLen = schema.minLength || 1;
	const maxLen = schema.maxLength || 100;
	const targetLen = Math.min(minLen + 10, maxLen);

	// Generate string of appropriate length
	const base = "test_value";
	if (base.length >= targetLen) {
		return base.slice(0, targetLen);
	}
	return base.padEnd(targetLen, "_");
}

/**
 * Generate a number value respecting min/max constraints
 */
function generateNumberValue(schema: JSONSchemaProperty): number {
	const min = schema.minimum ?? 0;
	const max = schema.maximum ?? 100;

	// Return a value in the valid range
	if (schema.type === "integer") {
		return Math.floor((min + max) / 2);
	}
	return (min + max) / 2;
}

/**
 * Generate an array value
 */
function generateArrayValue(
	name: string,
	schema: JSONSchemaProperty,
): unknown[] {
	if (schema.items) {
		// Generate one item of the specified type
		return [generateValue("item", schema.items)];
	}
	return [];
}

/**
 * Generate an object value
 */
function generateObjectValue(
	schema: JSONSchemaProperty,
): Record<string, unknown> {
	if (!schema.properties) {
		return {};
	}

	const result: Record<string, unknown> = {};
	const required = new Set(schema.required || []);

	// Generate values for required properties
	for (const [key, propSchema] of Object.entries(schema.properties)) {
		if (required.has(key)) {
			result[key] = generateValue(key, propSchema);
		}
	}

	return result;
}

// =============================================================================
// Prompt-Based Value Extraction
// =============================================================================

/**
 * Common parameter patterns to extract from prompts
 */
const PROMPT_PARAMETER_PATTERNS: Array<{
	paramNames: string[];
	patterns: RegExp[];
}> = [
	// Query/search terms
	{
		paramNames: ["query", "search", "q", "term", "keyword", "text"],
		patterns: [
			/search\s+(?:for\s+)?["']?([^"'\n]+)["']?/i,
			/find\s+["']?([^"'\n]+)["']?/i,
			/look\s+(?:for|up)\s+["']?([^"'\n]+)["']?/i,
			/["']([^"']{5,50})["']/i, // Quoted text
		],
	},
	// URLs
	{
		paramNames: ["url", "link", "website", "uri", "href"],
		patterns: [/(https?:\/\/[^\s]+)/i],
	},
	// Locations
	{
		paramNames: ["location", "city", "place", "address", "destination"],
		patterns: [
			/(?:in|to|from|at|near)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
			/([A-Z][a-z]+(?:,\s*[A-Z]{2})?)\s+weather/i,
		],
	},
	// Numbers/quantities
	{
		paramNames: ["limit", "count", "number", "amount", "max", "top"],
		patterns: [
			/(?:top|first|last)\s+(\d+)/i,
			/(\d+)\s+(?:items|results|entries)/i,
		],
	},
	// Dates
	{
		paramNames: ["date", "when", "time", "day"],
		patterns: [
			/(today|tomorrow|yesterday)/i,
			/(next\s+(?:week|month|year))/i,
			/(\d{4}-\d{2}-\d{2})/,
		],
	},
];

/**
 * Extract parameter values from example prompts
 */
function extractValuesFromPrompts(
	prompts: ExamplePrompt[],
	paramName: string,
	_toolName?: string,
): string | number | null {
	// Find matching parameter pattern
	const patternConfig = PROMPT_PARAMETER_PATTERNS.find((p) =>
		p.paramNames.some(
			(name) =>
				name.toLowerCase() === paramName.toLowerCase() ||
				paramName.toLowerCase().includes(name.toLowerCase()),
		),
	);

	if (!patternConfig) return null;

	// Try each prompt
	for (const prompt of prompts) {
		const text = prompt.cleanPrompt || prompt.raw;

		// Try each pattern
		for (const pattern of patternConfig.patterns) {
			const match = pattern.exec(text);
			if (match?.[1]) {
				const value = match[1].trim();

				// Convert to number if the param expects a number
				if (
					["limit", "count", "number", "amount", "max", "top"].some((n) =>
						paramName.toLowerCase().includes(n),
					)
				) {
					const num = Number.parseInt(value, 10);
					if (!Number.isNaN(num)) return num;
				}

				return value;
			}
		}
	}

	return null;
}

/**
 * Find the most relevant prompt for a tool based on tool name/description
 */
function findRelevantPrompt(
	prompts: ExamplePrompt[],
	toolName?: string,
	toolDescription?: string,
): ExamplePrompt | null {
	if (!prompts || prompts.length === 0) return null;

	// Build keywords from tool name and description
	const keywords: string[] = [];
	if (toolName) {
		// Split camelCase and snake_case
		keywords.push(
			...toolName
				.split(/(?=[A-Z])|_|-/)
				.map((s) => s.toLowerCase())
				.filter((s) => s.length > 2),
		);
	}
	if (toolDescription) {
		// Extract key verbs and nouns
		const descWords = toolDescription
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 3);
		keywords.push(...descWords.slice(0, 5));
	}

	if (keywords.length === 0) {
		return prompts[0] ?? null;
	}

	// Score each prompt by keyword matches
	let bestPrompt: ExamplePrompt | null = null;
	let bestScore = 0;

	for (const prompt of prompts) {
		const text = (prompt.cleanPrompt || prompt.raw).toLowerCase();
		let score = 0;

		for (const keyword of keywords) {
			if (text.includes(keyword)) {
				score++;
			}
		}

		if (score > bestScore) {
			bestScore = score;
			bestPrompt = prompt;
		}
	}

	return bestPrompt || prompts[0] || null;
}

// =============================================================================
// Main Export
// =============================================================================

/**
 * Generate test input from a JSON Schema definition
 *
 * @param schema - JSON Schema for the tool's input
 * @param options - Optional configuration including example prompts
 * @returns Generated test input object
 */
export function generateTestInput(
	schema: JSONSchema | null | undefined,
	options?: GenerateTestInputOptions,
): Record<string, unknown> {
	if (!schema || !schema.properties) {
		return {};
	}

	const result: Record<string, unknown> = {};
	const required = new Set(schema.required || []);
	const { examplePrompts, toolName, toolDescription } = options || {};

	// Find the most relevant prompt for this tool
	const relevantPrompt = examplePrompts
		? findRelevantPrompt(examplePrompts, toolName, toolDescription)
		: null;

	// Generate values for all properties, prioritizing required ones
	for (const [key, propSchema] of Object.entries(schema.properties)) {
		// Always include required properties
		// Include optional properties if we can generate sensible defaults
		if (required.has(key) || getDefaultByName(key) !== undefined) {
			// First try to extract value from example prompts
			let value: unknown = null;

			if (examplePrompts && examplePrompts.length > 0) {
				value = extractValuesFromPrompts(examplePrompts, key, toolName);
			}

			// Fall back to schema-based generation
			if (value === null || value === undefined) {
				value = generateValue(key, propSchema);
			}

			result[key] = value;
		}
	}

	// If we have a relevant prompt and a "query" type field, use the prompt text
	if (relevantPrompt && Object.keys(result).length > 0) {
		const queryFields = [
			"query",
			"q",
			"search",
			"text",
			"prompt",
			"message",
			"input",
		];
		for (const field of queryFields) {
			if (field in result && typeof result[field] === "string") {
				// Use the clean prompt as the query value
				result[field] = relevantPrompt.cleanPrompt || relevantPrompt.raw;
				break;
			}
		}
	}

	// If no properties were generated, try to generate at least the first required one
	if (
		Object.keys(result).length === 0 &&
		schema.required &&
		schema.required.length > 0
	) {
		const firstRequired = schema.required[0];
		if (firstRequired) {
			const propSchema = schema.properties[firstRequired];
			if (propSchema) {
				result[firstRequired] = generateValue(firstRequired, propSchema);
			}
		}
	}

	return result;
}

// =============================================================================
// Output Validation
// =============================================================================

export interface ValidationResult {
	valid: boolean;
	issues: string[];
}

/**
 * Validate tool output for basic sanity checks
 *
 * @param output - The tool output to validate
 * @returns Validation result with any issues found
 */
export function validateToolOutput(output: unknown): ValidationResult {
	const issues: string[] = [];

	// Check for null/undefined
	if (output === null || output === undefined) {
		issues.push("Output is null or undefined");
		return { valid: false, issues };
	}

	// Check for error responses
	if (typeof output === "object" && output !== null) {
		const obj = output as Record<string, unknown>;

		// Check for error indicators
		if (obj.error || obj.Error || obj.ERROR) {
			issues.push("Output contains error field");
		}

		// Check for empty content in MCP response format
		if (Array.isArray(obj.content) && obj.content.length === 0) {
			issues.push("Output content array is empty");
		}
	}

	// Check for empty arrays
	if (Array.isArray(output) && output.length === 0) {
		issues.push("Output is an empty array");
	}

	// Check for empty strings
	if (typeof output === "string" && output.trim() === "") {
		issues.push("Output is an empty string");
	}

	return {
		valid: issues.length === 0,
		issues,
	};
}

/**
 * Truncate output to a maximum size (for storage)
 *
 * @param output - Output to truncate
 * @param maxBytes - Maximum size in bytes
 * @returns Truncated output (as string if truncated)
 */
export function truncateOutput(
	output: unknown,
	maxBytes: number = 10000,
): unknown {
	// Handle null/undefined
	if (output === null || output === undefined) {
		return output;
	}

	const str = JSON.stringify(output);

	// JSON.stringify can return undefined for certain inputs
	if (!str) {
		return output;
	}

	if (str.length <= maxBytes) {
		return output;
	}

	// Truncate and add indicator
	const truncated = str.slice(0, maxBytes - 50);
	return `${truncated}...[TRUNCATED, original size: ${str.length} bytes]`;
}
