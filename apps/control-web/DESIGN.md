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
