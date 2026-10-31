---
"@tedix/cli": patch
---

Prioritize due lane heartbeats within the existing serialized call queue. Retry one retained admission, settlement, or completion after fresh pickup while native workers remain active; keep optional telemetry retries behind task closure.
