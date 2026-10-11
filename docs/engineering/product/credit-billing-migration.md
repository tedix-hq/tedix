# A monetary credit wallet

## First implementation

- A pure inference quote records a versioned customer rate and provider rate.
- Usage has four separate buckets: uncached input, cache read, cache write and output.
- Every amount uses integer USD micros. The complete event rounds up once to a micro; it does not round each token bucket or charge a whole credit per call.
- Proposed display value: **1 credit = $0.01 of billed service value**. This is a proposal, not an active catalog change. The rate receipt carries the denomination.
- Customer price and provider cost are independent. No automatic markup is defined.
- BYOK removes Tedix's estimated provider liability. Its separately published customer rate may cover only platform/service fees; it must not charge again for inference the customer pays directly to the provider. A zero platform rate is valid. Each snapshot pins its funding mode; a managed rate cannot be reused for BYOK.
- Unknown pricing cannot be quoted as zero. Estimates and observed usage are identified separately; neither proves a provider invoice.

The opt-in engine now reserves monetary funds atomically, pins published provider receipts and settles the existing credit journal once. Monthly and per-run caps count only monetary usage, preserving legacy statements. Late receipts cannot consume another call's hold; usage beyond its reservation is absorbed and recorded. Accounts remain on their existing plan until explicitly configured. The quote helper itself changes no entitlement.

The first wallet denomination is USD. New monthly grants carry forward without expiry; purchased/promotional splitting is not claimed. The overview separates the monthly allowance from the total wallet. The credit budget endpoint changes the monthly cap without enabling cash overage. Per-run caps apply across calls sharing a run ID; stage estimates and replayable completed stages remain subsequent work.

## Provider counter normalization

Current metering passes recorded input/output counters to legacy settlement and retains cache counters in metadata. The new helper deliberately cannot consume those input counters directly: it accepts explicitly **uncached** input. Each provider adapter must declare whether its input counter includes cache reads and writes, preserve the original receipt, subtract subsets only when that receipt establishes the relationship, and reject inconsistent or unknown combinations. Do not assume all providers use the same convention. A cache subset must not be charged again as uncached input.

## Migration steps

1. **Price and allowances.** Publish immutable customer rate versions and monetary plan allowances. Set Business's allowance using observed workflow costs, a safety margin and the intended economics. Do not convert the old token allowance at an arbitrary rate.
2. **Shadow quotes.** Compare the new quote to existing settlements without changing balances or blocking decisions. Report unknown prices, cache normalization failures, duplication, unattributed spend and rounding differences.
3. **Reserve and settle.** Pin the monetary rate before each provider call. Atomically reserve wallet funds, settle once using the provider event identity, release unused funds and fence concurrent calls. Reuse the monetary credit journal and renewal grants. Keep customer charge, provider estimate and reconciled provider invoice separate.
4. **Plan cutover.** Pin accounts to new plan versions at a documented boundary. Preserve old statements and prices. Keep legacy token mode available for existing periods; never retroactively debit customers for shadow quotes. Define promotional/purchased grant expiry, rollover, refunds and mid-period migration before activation.
5. **Run controls.** Show an estimated run cost, reserve a run ceiling and apply stage limits. Add budget warnings and hard stops at safe checkpoints. Idempotent retries must not double charge; completed stages should be reusable.
6. **Human views.** Lead with credits remaining, monetary worth, credits used by run and projected month coverage. Put tokens, cache details and provider reconciliation in diagnostic views. Distinguish managed inference, BYOK, tools and infrastructure.

## Acceptance before activation

- Missing pricing and missing attribution remain visible instead of becoming zero-cost usage.
- Concurrent reservations cannot overspend; retries cannot create duplicate debits.
- Cache-inclusive provider counters are normalized into disjoint buckets once.
- Historical statements reproduce their original price and credit denomination.
- A complete workflow displays its estimate, reserved amount and final charge by stage.
- A failed workflow explains charged work and released funds; a billing denial creates no provider call.
- Tool/service credits use a declared conversion or remain visibly separate. The existing SEO credit journal is not silently merged with the monetary wallet.
- Proposed product value is never presented as cash redeemability or as an automatic EUR conversion.
