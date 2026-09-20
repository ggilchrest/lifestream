# Local Mac endpoint

The native endpoint uses the same authenticated local web core as the browser.
It contains no backend, private appearance, credentials, provider configuration
or Lab. Start the configured candidate separately. The default endpoint is
`http://127.0.0.1:43182/control/#conversation`.

For development, run `pnpm desktop`. To select another existing loopback core:

```sh
pnpm desktop --url http://127.0.0.1:43199/control/#conversation
```

If the local server is unavailable, a static connection page explains the
problem. Start the server and click **Retry connection**. Retry preserves the
selected endpoint. Closing the window quits the shell; it does not stop the
server or change saved data. No remote endpoint or automatic fallback is used.

## Build a local application

Commit the scoped packaging inputs, then use a new absolute output directory
whose parent already exists, outside this checkout:

```sh
pnpm desktop:package /absolute/local-output/lifestream-mac
```

The builder uses the already installed exact Electron pin and an explicit
application-file allowlist. It never installs or downloads dependencies,
replaces existing output, embeds private packs or copies the repository.
It produces `Lifestream.app`, an architecture-specific ZIP and a receipt with
source hashes, revision, file counts and archive digest. Third-party Electron
resources retain their own notices; Apache-2.0 applies only where eligible.

Open `Lifestream.app` after starting the configured core. For an explicit local
URL, use `open -a /absolute/path/Lifestream.app --args --url URL`. Both packaged
and development hosts honor this argument. The application remains sandboxed,
isolates its preload, denies external navigation and camera permission, and
protects private output on the existing lock/suspend signal.

Signing is ad-hoc and local. No Developer ID, notarization, installer,
redistribution approval or cross-machine Gatekeeper acceptance is claimed.
Inspect the final ZIP and test the extracted application, including offline
retry and privacy cleanup. Build success alone is not runtime verification.
