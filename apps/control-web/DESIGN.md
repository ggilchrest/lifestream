# Lifestream control room

The September 2026 redesign responds to Human review of steps 1–6: records lacked identifiers and field structure, actions and results were separated by long scrolling, and the administration plane had no navigation. It uses a restrained Neo Frutiger Aero direction: clear sky backgrounds, azure glass chrome, luminous blue controls, crisp navy text and warm violet focus rings. User records remain the visual priority.

## Tokens

| Role | Value |
|---|---|
| Body / heading | #18314c / #163351 |
| Secondary text | #506782 |
| Primary control | #2874bf → #1563bf; white label |
| Canvas | #e9f2fb with soft sky / cyan light |
| Surface | opaque white content; translucent chrome only |
| Border | #c9d9e9; inputs #9db4ca |
| Focus | 3px #794be2, 3px offset |
| Error | #aa283c on light surfaces |
| Spacing | 4, 8, 12, 16, 20, 24, 32px |
| Radius | 9px control, 12px grouped content, 16px page panel |
| Type | system UI; 15px body, 13px secondary, 32px page title |

## Component inventory

- `workspace.js`: grouped destination navigation, current page heading, accessible mobile menu, global action feedback and context clearing.
- `workflows.js`: existing control grouping, Settings workflow tabs, sequential preview / confirmation, cross-view links to explicitly selected drafts.
- Record explorer: category / lifecycle / content-or-ID filters, overview counts, table with full selectable IDs, labeled mobile rows, expandable evidence and lifecycle actions.
- Record operation dialog: selected record ID and revision, explicit input and consequences, review/apply, cancel and Escape with focus return. It preserves CAS and server authorization.
- Insight finding: named perspective, finding ID, status, uncertainty, support and counterevidence, labeled intervention/benefit/cost/risk/validation/reversal. Five perspective buttons show one finding at a time. Feedback is a separate disclosure after the selected finding.
- Workflow step: numbered purpose, inputs, action, observed result and explicit next decision.
- State label: always text plus color. Superseded rows use a muted violet background; superseded records remain inspectable.

## Layout and interaction

A destination is a real view: inactive areas are hidden, not scrolled past. URL hashes support deep links and browser history. Changing views never submits a request or activates configuration. The selected Assistant stays available in the rail. Account and session disclosure have their own destinations. All async owners keep their original authorization, revision guards and scope-change listeners.

Configuration editing, review/activation and reply inspection are separate tabs. A successful Save Draft takes the user to its review. Rollback stays in that review, followed by preview, observed changes and activation. Insight configuration links select the exact generated draft after refreshing server state. Privacy previews precede their confirmation control. Lab setup, execution and decisions are distinctly grouped.

Notification text is visible at the viewport and dismissible. It is cleared on identity change. Sensitive record confirmations use a modal with native focus containment. Error text is also shown inside that modal. No success is inferred from a click.

## Responsive and accessibility

At 760px the rail becomes an explicit navigation menu; tables become labeled record cards without dropping identifiers or actions. Content uses a single document scroll, wrapping long IDs and source references. Buttons are at least 42px tall. Inputs have visible labels. Navigation has `aria-current`; tab buttons have pressed state. Page navigation focuses the heading. Skip navigation, keyboard focus, Escape cancellation, live status messages and reduced motion are supported. Decorative light and gradients never encode lifecycle meaning.

Browser verification uses isolated synthetic storage and real local authentication. Older journey tests use a helper that clicks actual navigation, tabs, disclosures and record expansion controls; it never forces hidden controls or switches on a test-only page. These checks establish software behavior and layout, not Human acceptance or selected-provider qualification.

## Initiative and Discovery configuration review

Each extension has a distinct Context destination, with primary controls first and source/output scope plus limits in expandable groups. The editor is generated from the exact published Settings contract; unknown fields are never synthesized. Both use the existing sky, azure, navy and focus tokens. Numbered workflow cards keep saving, history selection and preview/activation in order. Revision tables use full selectable identifiers, labeled headers and bounded horizontal overflow on narrow screens. Previews emphasize changed fields, with full values available on demand. Shared-parent reply controls and the other extension are disclosed before confirmation.

Each request binds the current relationship; account or Assistant changes clear revisions and previews and discard late responses. Editable fields have explicit labels; status text announces results. Empty history explains the next action. Buttons require a current preview, while the server independently rechecks confirmation, scope and revision. Configuration review is available before runtime integration; the development notice must remain until the corresponding runtime operations are actually implemented and verified.

Discovery separates Settings, Prepare sources, Topic briefs and Job history into mutually exclusive views. Preparation moves directly to the observed job result. Briefs show selectable IDs, attribution, reliability, scope and freshness; source exclusion and topic forgetting require a nearby review and confirmation. Narrow tables become labeled cards. Scope changes clear source forms, records and pending retry identities. The development notice distinguishes the supplied-source workflow from unfinished hypothesis, candidate and comparison behavior.

Scoped feedback uses an explicit meaning selector, an exact approved evidence revision, a context field and optional expiry. It creates a pending declaration in the existing Records review flow. Timing, fatigue, capacity, satisfaction, purchase intent and uncertainty are never presented as automatic dislike. Expiry withholds future context use; the record remains inspectable until its normal lifecycle removes it. Legacy record responses omit the internal typed metadata.

Hypotheses have a separate Discovery view with a labeled revision table and one selected detail. Competing explanations, boundaries, evidence, unknown alternatives and uncertainty are distinct sections. Review explicitly means useful-but-tentative; rejection explicitly preserves supporting evidence. A nearby confirmation names the exact hypothesis and revision, then keeps the updated record in view with focus on its heading. Rejected records offer no approval control. The existing sky/azure/navy tokens, responsive cards, live status and scoped sign-out clearing apply.

Candidates have a separate Discovery view showing their kind, content, exact identity, status and expiry. Score dimensions remain individually labeled; null is displayed as Unknown. Grounding and limitations are disclosed separately. Suppression confirms the exact candidate revision, preserves sources and keeps its observed status in view. Prompt inclusion never claims actual model use or grants authority.

Discovery Input Lab uses a separate workflow panel. Choose a saved revision, run or refresh the bounded synthetic comparison, then inspect one scenario at a time. Baseline, enabled-reference and selected configuration have aligned desktop columns and stacked mobile cards. Failed expectations remain visible. Canonical input, estimate method and digest references are progressive disclosures; no model quality, activation or Human acceptance is implied.
The assembled-input inspector opens in a wide native dialog with an explicit close action; long prompt text does not stretch narrow comparison columns or push the next action down the page. Scope changes close and clear the inspector.

Discovery candidate interest strength may show 1 under method discovery-explicit-favorite:1 when an exact approved favorite declaration supports that topic. This is a provisional ordinal selection hint, not a calibrated probability. Evidence confidence and coverage remain separate and unknown unless independently established. The source evidence remains editable in Records; preparation finds eligible declarations without requiring manual reference copying.

Initiative review shows effective 0–11 controls, the corresponding existing warmth scale, and current delivery restrictions before activation. Provenance and policy limits use a collapsed details section within the same review step. Editing an advanced dimension marks the preset Custom without changing other dimensions, ceilings, consent or channels; selecting Custom preserves the edited values. Review remains distinct from output readiness.

## Conversation and session output

Conversation is a first-party navigation destination tied to the selected Assistant and relationship. The dialogue stays in one reading column; output setup sits beside it on wide screens and below it on narrow screens. It reuses clear-sky surfaces, azure actions, navy text, violet focus and the existing 16px radius. Short status labels distinguish output readiness, emission, endpoint acceptance and playback acknowledgment. The transcript never adds a fabricated user turn for an opening.

Enabling output is an explicit action. Session disclosure and reviewed Initiative permission are separate controls, with direct navigation links. Speech setup initializes playback without requesting a microphone. Microphone capture has a separate Start action, a visible state and a nearby Stop action. Starting speech output alone never requests capture. Explicit microphone capture uses the same connection, speech-probability gate and ordinary reply path; typed replies and Stop release capture. Temporary quiet and companionship live in a disclosure beside output setup; they do not alter saved configuration or resume prior candidates. Synthetic ingress stays in a separate, labeled test disclosure requiring a host-prepared occurrence.

All turns have role and state labels. Simulated openings disclose full opportunity, conversation and interaction references, plus a nearby dismissal action. Recent opportunity selection shows labeled lifecycle, acknowledgment, response, timestamps, configuration and source fields. Refresh retrieves metadata only. Account, Assistant, relationship and disclosure changes clear scoped content and cancel pending work. Leaving the view or hiding the page turns output off. Late responses cannot repopulate another subject's view.

The browser matches HTTP delivery metadata to the WebSocket interaction before playing PCM. Endpoint acceptance follows that match. Playback completion follows both successful synthesis and the final scheduled source's natural ended event; Stop marks cancellation before stopping sources. Buffer limits, stale receipts, suspended audio and unmatched streams fail visibly. Microphone capture, physical audibility and Human reception are never inferred from these software events.

Microphone sensitivity sits in a collapsed Speech detection section below its start/stop controls. Qualified speech cancels the current output before transmitting bounded PCM, and the recognized user turn appears alongside the opening it answers. Pending microphone permission cannot revive capture after Stop, account/scope changes or navigation. Voice response completion describes local scheduled playback, never Human reception.

Recent conversation context is now owned by the authenticated server session and shared by text and voice. The page does not resubmit its transcript. The same conversation can continue through microphone reconnects and changes between text and audio when the audience, endpoint and subject stay the same. This is bounded volatile context, not saved memory: 20 entries and 64 KiB per scope, a 30-minute ceiling further limited by authentication expiry, and runtime-wide caps. A timer removes expired payloads even when idle. Sign-out, forgetting and changes to the relevant subject/privacy/data boundary remove stale context. The visible page transcript remains separate and bounded to 100 turns.

Synthetic event selection uses the existing clear-sky form and disclosure patterns. When a test host supplies a prepared catalog, a labeled picker shows the event kind, text/speech output and expiry; source identifiers move into read-only details. Selection fills the existing simulation request and adjusts the proposed output modality without enabling output. Adjacent output-readiness and refresh buttons, matching output status and explicit empty/unavailable messages keep inspection local to the workflow. Resolve-only hosts retain manual prepared-source entry. Catalog reads do not create events or request output; expired or consumed cases are removed on refresh and every submission is revalidated by the host.

Opening outcomes keep status and reason first, with labeled expression observations in a separate disclosure: requested wording warmth, observed wording/speech stage, provider disposition, applied delivery controls, degraded dimensions and mapping reference. The inspector explicitly distinguishes provider reports from audible verification and Human warmth judgments. Missing historical observations stay unobserved; current prosodic warmth and renderer limitations remain visible. The response metadata budget bounds complete opportunity/observation pairs instead of silently dropping a returned opportunity’s expression report.

The Initiative comparison Lab follows revision preview as a distinct fourth workflow section. Run/check controls and results share that section. Reference levels and selected settings use labeled rows with simulated opening counts, distinct topics and suppression counts; per-event reasons and record IDs live in separate disclosures. The summary table scrolls within its region on narrow screens instead of squeezing headings or widening the page. Comparison never activates settings or labels a synthetic sink acknowledgment as physical delivery.

## Canonical permissions workflow

This design extends the existing clear-sky / Neo Frutiger Aero system. It is implemented with separate browser verification; Human acceptance is not implied. The operator explicitly superseded the September 11 planning-only restriction on September 15. The startup capability backend at local commit `5432121` is already implemented and verified separately.

### Layout and components

The security page has four navigable views: **Capabilities & actions**, **People & access**, **Skills**, and **Proposed changes**. Keep one named Assistant selector visible in the navigation context. Reuse the existing navy text, white content surfaces, azure controls, violet focus ring, spacing scale and radii from the Tokens section. The navigation collapses above the content on phones. Show one view at a time, preserving a visible page heading and current destination.

The capability view has three ordered areas. First, choose a capability from the actual canonical catalog and enter its arguments using labeled schema-backed fields. Second, inspect the prepared request and approve its exact terms. Third, explicitly dispatch and read the result. Place each result and next action immediately below the action that produced it. Move focus to the newly opened detail heading, not to a distant panel higher on the page.

Use record tables with full selectable request/grant/invocation identifiers, named capability, state, revision and expiry. A selected record opens one detail panel below its table. Label fields individually: target, operation, effect summary, exact input, grant duration, review boundary, endpoint, session, environment and input digest. Keep technical proof references in a disclosure section. On phones, show labeled stacked rows; identifiers must wrap and remain readable. Never replace structured fields with an undifferentiated JSON dump.

### Actual data and action flow

- Read the actual canonical catalog from the authenticated Assistant tools resource. An unavailable provider stays unavailable. PWCE discovery exposes `actionAdministration: providerReview`: labeled site, target and brightness inputs lead to an exact review. Show one active workflow step, with a back control and a collapsed table of retained invocation references. Keep producer approval separate from local confirmation: request approval, check the original result, review approved proof, then explicitly run. A lost execution reply offers only original-status recovery. The UI cannot replace external governance with a fixture or coarse local grant.
- A missing or unknown session audience links directly to the existing Session disclosure control. Do not silently select an audience for the user.
- Prepare with a stable request key, then create the pending canonical authority request. Show the server-derived target, effect and expiry. Preparation and pending-request creation do not dispatch anything.
- The existing GrantRequest does not contain the original arguments or preparation key. Add a scoped, read-only prepared-invocation inspection resource before implementing reload/resume in the UI. It must return the original input/key only to the owning authenticated session, recheck current Assistant/endpoint/provider/schema access, and grant or dispatch nothing. This resource is implemented and scoped to the original authenticated session.
- Require an explicit checkbox confirming the displayed exact request before approval. Send the returned confirmation digest, expected revision and unchanged grant terms. Approval returns a durable grant but does not invoke the capability.
- Offer **Run approved action** beside that confirmed grant. Use the original invocation and preparation key. Show the actual result, receipt identity and whether the response was replayed. A transport error keeps the original command available for safe retry; it must not generate a fresh key automatically.
- For an uncertain admitted outcome, offer **Check original result** through the existing reconciliation resource. Do not retry the effect, refund a grant, invent success or rediscover a replacement provider.
- List requests and grants with bounded pagination. Display grant eligibility separately from stored lifecycle state. A revoked, consumed, expired or review-due grant must not look runnable. Grant detail shows the actual admitted invocation identifiers and lifecycle events.
- Denial, cancellation and revocation act on the selected record and expected revision. Keep the updated record and action feedback in view. A reusable grant can support a newly prepared matching invocation; it must not turn a repeat of the original invocation into a new effect.

### Interaction and accessibility rules

Use labeled controls, native form validation, visible focus rings, 44px touch targets and status text next to the affected workflow. Preserve exact idempotency envelopes across ambiguous network failures. Clear form proposals, selected records, confirmations and late replies when the authenticated session, selected Assistant or audience changes. Render all provider/model/user text as text, never as markup. Show loading, unavailable, empty and error states distinctly; do not leave a spinner with no recovery action. Respect reduced motion and keep focus order aligned with the displayed workflow.

### Verification required before completion

Exercise the real control page against disposable authenticated server startup: catalog selection; invalid arguments; complete exact review; checkbox and keyboard approval; one dispatch; original-result replay; browser reload before dispatch; durable result after server restart; denial/revocation; expired and stale revisions; session/Assistant/audience withdrawal; interrupted replies with stable keys; bounded pagination; provider failure without fallback; and text rendered safely. Check desktop, 390px and 320px layouts for readable identifiers, nearby next actions, no page overflow and keyboard reachability. Capture and inspect the actual UI. These are agent checks; separate Human acceptance remains required. PWCE composition and physical effects are not established by a synthetic browser run.

Selected request/grant detail replaces its list until Back to list is chosen. This keeps phone review independent of the number of older records. Dates use local date, time and time zone with the exact ISO value in the title; identifiers remain complete. Empty target/data lists read None. Persistent grant reuse requires a newly prepared action and explicit permission selection; server-side final authorization remains decisive.

PWCE permissions use a separate summary card with site and capability tables, **Refresh permissions**, and a nearby evidence disclosure. Hide local grant state and duration controls. Distinguish the completed read deadline from the original catalog lifetime so a Human can inspect the observation; announce expiry and withhold stale proof reads. Never present a producer summary as locally issued grants or an action approval.
