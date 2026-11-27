# Poppy personal agent demo

Public identity documents for the simulated Poppy demo agent used by
`tedix poppy`. `client.json` is the client metadata document (`client_id`)
and `jwks.json` the public JWKS a Poppy company fetches to verify
`Poppy-Session` JWTs. Both are served unchanged from this repository, so the
raw `main` URLs are the stable public addresses.

This is demo material: the name says "Simulated", the key signs only
simulated personas (`tedix poppy identities`), and the private half is never
committed. Generate or rotate a key with:

```sh
tedix poppy keygen --key-file <path-outside-repo> \
  --client-id https://raw.githubusercontent.com/tedix-hq/tedix/main/examples/poppy-personal-agent/client.json
```

then replace `jwks.json` with the printed `jwks` and keep the private JWK as
a secret.
