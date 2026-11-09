---
"@tedix/cli": patch
---

A job whose run timed out while waiting for a person is no longer stuck once that question is cancelled or expires. The dispatcher now checks the question for these runs too, and starts the job again or asks a fresh question.
