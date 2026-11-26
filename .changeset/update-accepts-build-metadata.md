---
"@tedix/cli": patch
---

`tedix update` installs release builds again. It accepted only a binary that printed the bare version, but release builds also print their source commit (for example `0.37.26+76cb730bc`), so every update stopped at the version check.
