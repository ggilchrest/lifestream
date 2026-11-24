# Native iOS build and installation checklist

Use this checklist for every operator test build and release. Keep private packages,
generated projects, screenshots and signed artifacts outside Git. Record the source,
required asset catalog, dependency versions, compile flavor and build number.

## Required build checks

- [ ] Inspect the public and private Git roots; preserve existing changes. Use a fresh output directory.
- [ ] Select an independently approved required asset catalog and audio test clip. Preserve the saved appearance IDs, digests and animation preferences.
- [ ] Verify every model, texture, reference/rest model, animation clip, physics profile, trusted adapter and audio clip against that inventory. Check sizes and digests.
- [ ] Match renderer capabilities to every packaged schema. External animation packages require their trusted-adapter preparation, controls and disposal path.
- [ ] Build the web bundle from the selected compatible sources and record all shared renderer hashes and dependency/build aliases.
- [ ] Run the executable all-assets gate below. Every shipped appearance, including neutral, must prepare and render; every declared embedded or external clip must resolve and run. Inspect every saved rendered image.
- [ ] Exercise every ordered pair of bundled appearances directly, including both directions between large models, without a test-harness unload. Require the old decoded/GPU owners to be released before successor retrieval, correct new identity and nonblank output. Record direct-transition results separately from individual model/animation tests.
- [ ] Require zero page errors, asset warnings, undeclared dependencies or external network requests. Record any known browser-driver warnings separately.
- [ ] Select the required adapter context-loss check from the independent inventory regardless of catalog order. Require its actual passing result; allow `notApplicable` only when that inventory has no adapter. Verify controls/preview refuse, motion stops and repeated disposal releases each owner once. Run focused admission, cancellation and cleanup regressions for changed code.
- [ ] Build with Xcode using the selected existing signing identity/profile. Record actual compiler conditions for optional integration/recovery modes; signed entitlements alone do not prove disabled startup behavior.
- [ ] Verify bundle ID, version/build, certificate, current provisioning/device coverage and exact intended entitlements. Preserve the original app container with an in-place update.
- [ ] Run the same all-assets gate again with `--public` pointing into the final signed app. Its web bundle must equal the recompiled tested product and its resources must match the required inventory. Keep the passing result bound to the final signed file map.
- [ ] Verify all generated web files copied into the app match the selected outputs. A generic build or Capacitor sync after private packaging can replace the catalog; rerun the entire package gate after any such operation.

## Executable gate

From the selected source root, provide explicit paths to the packaged public files,
the independently selected catalog/audio, installed dependencies, an installed browser
and a new evidence directory outside Git:

```sh
npm --prefix apps/ios run verify:release-assets -- \
  --source "$IOS_RELEASE_SOURCE" \
  --public "$IOS_RELEASE_APP_PUBLIC" \
  --expected-catalog "$IOS_RELEASE_REQUIRED_CATALOG" \
  --expected-audio "$IOS_RELEASE_REQUIRED_AUDIO" \
  --dependencies "$IOS_RELEASE_DEPENDENCIES" \
  --browser "$IOS_RELEASE_BROWSER" \
  --output "$IOS_RELEASE_NEW_EVIDENCE"
```

The gate uses a local-only browser context, the app's actual GLTF loader and
Content Security Policy, and hash-verified adapter modules. It writes `RESULTS.json`,
rendered images and bundle input metadata. Missing assets, incompatible renderer
sources, stale web output or failed runtime preparation stop installation. Fixture
and desktop-browser checks remain distinct from physical iPhone acceptance.

## Device verification

- [ ] Confirm the exact connected target, existing installed bundle and readiness. Ask for unlock/trust only when needed; never uninstall or reset to resolve a package failure.
- [ ] Coordinate the unchanged server pair and quiet window before launch/testing; coordinate separately before any server restart.
- [ ] Confirm the non-secret saved server origin before automatic credential contact. Verify actual Connected status.
- [ ] Confirm optional speech/audio capture is off before microphone testing unless the user explicitly authorizes retention. Keep routine bounded diagnostics separate.
- [ ] On the phone, load every selected avatar, switch directly between every pair in both directions without an intermediate choice, and exercise animation selection/cycle, view/framing and supported physics. Retain settings and disabled animation choices.
- [ ] Compare local media/conversation audio and streamed short/long speech on speaker and AirPods; verify microphone, echo control, route changes and spoken interruption.
- [ ] Record installed, connected, graphical and listening outcomes separately. A failed device check keeps acceptance pending.
