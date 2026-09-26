# Native companion package

`Sources/CapApp-SPM` contains reviewed application code: the Capacitor bridge,
Foundation transport and native voice lifecycle. Edit those sources normally.
The pure protocol/privacy core and its tests live in `apps/ios/native`.

Capacitor regenerates `Package.swift`. Use `npm run sync` from `apps/ios` so
`scripts/sync-native.mjs` restores the local `AssistantCore` dependency afterward.
Keep plugin registration in `AssistantViewController`; never load remote script
code into this native bridge. See `docs/ios-v0.1.md` for build and physical tests.
