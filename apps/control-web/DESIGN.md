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

Enabling output is an explicit action. Session disclosure and reviewed Initiative permission are separate controls, with direct navigation links. Speech setup initializes playback without requesting a microphone. This output-only view offers typed replies and a Stop control, and states that voice barge-in is unavailable. Temporary quiet and companionship live in a disclosure beside output setup; they do not alter saved configuration or resume prior candidates. Synthetic ingress stays in a separate, labeled test disclosure requiring a host-prepared occurrence.

All turns have role and state labels. Simulated openings disclose full opportunity, conversation and interaction references, plus a nearby dismissal action. Recent opportunity selection shows labeled lifecycle, acknowledgment, response, timestamps, configuration and source fields. Refresh retrieves metadata only. Account, Assistant, relationship and disclosure changes clear scoped content and cancel pending work. Leaving the view or hiding the page turns output off. Late responses cannot repopulate another subject's view.

The browser matches HTTP delivery metadata to the WebSocket interaction before playing PCM. Endpoint acceptance follows that match. Playback completion follows both successful synthesis and the final scheduled source's natural ended event; Stop marks cancellation before stopping sources. Buffer limits, stale receipts, suspended audio and unmatched streams fail visibly. Microphone capture, physical audibility and Human reception are never inferred from these software events.
