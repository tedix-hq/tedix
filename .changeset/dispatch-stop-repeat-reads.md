---
"@tedix/cli": patch
---

Lane dispatchers stop re-reading tasks that cannot start or finish for a reason that won't change. A task whose current version already has a recorded result waits until the task changes. A finished run whose completion was refused, for example because the task changed or a newer run exists, stops asking to complete. A task waiting for executor capacity is no longer read again on each retry.
