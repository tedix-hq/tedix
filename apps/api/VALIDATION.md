# Extraction Validation Layer

## Overview

The validation layer runs **between transformation steps** to catch data loss early during extraction workflows.

## Architecture

```
Firecrawl Extract
       ↓
  parseExtractResult()
       ↓
  [✓ VALIDATION #1: normalized]  ← Quality score, missing fields
       ↓
  normalizeItems()
       ↓
  enrichItemsWithGeocoding() (optional)
       ↓
  [✓ VALIDATION #2: pre-insert]  ← Catch transformation issues
       ↓
  toItemInsert()
       ↓
  upsertItems()
```

## Validation Points

### 1. After Parsing (normalized)

**Location:** `ExtractionWorkflow.extractItems()` (line ~509)

**Checks:**

- Total items extracted > 0
- Field coverage across first 3 items
- Vertical-specific critical fields present
- Quality score (0.0 - 1.0 based on field coverage)

**Output:**

```
[Workflow] Quality score: 85%
[Workflow] Warnings: ["Item 'BMW X3 2024...' missing: transmissionType"]
[Workflow] LOW QUALITY extraction (65%), missing: ["make", "model"]
```

### 2. Before Insertion (pre-insert)

**Location:** `ExtractionWorkflow.saveItems()` (line ~586)

**Checks:**

- Same validation as #1
- Catches any data loss during normalization/enrichment
- Warns if quality dropped below 70%

**Output:**

```
[Workflow] Pre-insert validation failed (55%): ["CRITICAL: Make/Model missing"]
```

## Critical Fields by Vertical

### Automotive

```typescript
[
	"title",
	"price",
	"make",
	"model",
	"year",
	"mileage",
	"fuel",
	"transmissionType",
	"power",
	"condition",
	"accidentFree",
	"image",
	"url",
];
```

**Critical errors:**

- Missing `make` or `model` → Vehicle search won't work
- Missing `externalId` → Deduplication fails

**Warnings:**

- Missing `transmissionType` → Check fallback to `transmission` field

### E-commerce

```typescript
["title", "price", "image", "url"];
```

### Marketplace

```typescript
["title", "price", "location", "seller", "image", "url"];
```

### Real Estate

```typescript
["title", "price", "location", "image", "url"];
```

## Quality Score Calculation

```typescript
score = fields_present / fields_expected;

// Example: Automotive extraction (13 critical fields × 3 sample items = 39 expected)
// Item 1: 11/13 fields present
// Item 2: 12/13 fields present
// Item 3: 13/13 fields present
// Total: 36/39 = 92% quality score ✓
```

**Thresholds:**

- **≥ 70%** = Valid (green)
- **< 70%** = Low quality warning (yellow)
- **< 50%** = Critical errors (red)

## ValidationResult Interface

```typescript
interface ValidationResult {
	valid: boolean; // true if score ≥ 0.7 and no errors
	score: number; // 0.0 to 1.0
	warnings: string[]; // Non-critical issues
	errors: string[]; // Critical failures
	coverage: {
		expected: number; // Total fields checked
		present: number; // Fields with values
		missing: string[]; // Unique missing fields
	};
}
```

## Usage Example

```typescript
import { validateExtraction } from "../services/extraction-validator";

const items = normalizeItems(rawItems);

// Validate after normalization
const validation = validateExtraction(items, "automotive", "normalized");

console.log(`Quality: ${(validation.score * 100).toFixed(0)}%`);
console.log(`Missing: ${validation.coverage.missing.join(", ")}`);

if (!validation.valid) {
	console.warn("Low quality extraction:", validation.errors);
}
```

## Benefits

### 1. Early Detection

Catch data loss **during extraction** instead of discovering hours later when users search and find nothing.

### 2. Debugging Clarity

Clear logs show exactly which fields are missing and why quality is low:

```
[Workflow] Item "BMW X3 2024 xDrive30i..." missing: transmissionType, power
[Workflow] Item "Audi Q5 2023 quattro..." missing: transmissionType
```

### 3. Config Iteration

Validate field mappings before committing extraction configs:

- Missing field? Update `config.schema`
- Wrong data type? Fix field mapping
- Low coverage? Adjust extraction prompt

### 4. No Performance Impact

Validation only samples first 3 items (fast field checks, no heavy parsing).

## Real-World Example

**Before validation:**

```
[Workflow] Extracted 448 vehicles
[Workflow] Saved 448 items to D1
[Hours later] User searches "BMW X3" → 0 results (make/model were null!)
```

**After validation:**

```
[Workflow] Extracted 448 vehicles
[Workflow] Quality score: 45%
[Workflow] CRITICAL: Make/Model missing - vehicle search won't work
[Workflow] Missing: ["make", "model", "transmissionType"]
→ Fix extraction config BEFORE saving
```

## File Locations

- **Validator:** `/apps/api/src/services/extraction-validator.ts`
- **Integration:** `/apps/api/src/workflows/extraction-workflow.ts`
- **Type:** `ValidationResult` interface exported from validator

## Future Enhancements

1. **Custom thresholds per vertical** (e.g., automotive needs 85%, marketplace needs 70%)
2. **Field importance weighting** (missing `make` = -50%, missing `color` = -5%)
3. **Historical quality tracking** (D1 table with extraction_id, score, timestamp)
4. **Auto-retry with different configs** if quality < 50%
