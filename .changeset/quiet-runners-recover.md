---
"@tedix/cli": patch
---

Back off executors whose native session setup fails before Work admission, so Auto and idle takeover can use a healthy runner. Retry eligibility returns after the existing backoff window.
