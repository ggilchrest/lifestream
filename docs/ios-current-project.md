# Current iOS development project

Use `apps/ios/ios/App/Lifestream.xcodeproj`, shared scheme and target **Lifestream**.
This repository is the single maintained iOS codebase. `App/` remains an internal
source-folder name for Capacitor compatibility, not a second project.

The November 12 consolidation recovered the advanced native HealthKit, Calendar,
Reminders and UI sources from the source snapshot used for installed build 37.
The older repository copy was incomplete. Historical packaged projects are recovery
artifacts, not independent development roots. Do not edit or install those copies.

- Bundle ID stays `org.lifestream.assistant`; signing team and automatic signing stay unchanged.
- HealthKit capability and the operator's Health read-purpose text are retained.
- Use the regular build for Apple Health sharing. The recovery packaging flavor disables native Health setup. Sharing begins when the user turns it on in Settings.
- Private resources are outside Git. The project's ignored `App/public` link references
  a preserved build-37 resource snapshot. Do not commit this link or resources.
- Generic `npm run sync` deliberately refuses to overwrite linked private resources.
  The private packager emits `Lifestream.xcodeproj`; all-assets verification and a
  fresh build are still required before any installation.
- Keep the app's data container intact; never uninstall to resolve packaging issues.

Consolidation checks: packaging and Health entitlement/project tests pass (4/4).
A full unsigned iPhoneOS build of target/scheme Lifestream succeeded. The native
copy check includes 161 source/project/resource files. Earlier sandbox failure,
missing Swift resource declaration (corrected), and interrupted build logs were
preserved. No installation, signed build, deployment or human acceptance was
performed for this cleanup. Signed/device/all-assets release gates remain required.
