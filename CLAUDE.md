# CLAUDE.md — Mangonese Engineering Rules

Standing rules for Claude Code on any Mangonese app. Read fully before writing code. If a rule here conflicts with a request in chat, say so and ask — do not silently pick one.

Environment: Windows / PowerShell. Primary target device: Android phone. Give PowerShell commands, not bash.

---

## 0. How to work

1. **No code before the PRD is locked.** `/docs/prd.md` must exist and be signed off. If it doesn't exist, stop and say so.
2. **Plan before you build.** For anything larger than a one-file change, write the plan first: files touched, data shape, failure modes, and what you are explicitly *not* doing. Get a yes.
3. **Smallest correct change.** Don't refactor adjacent code, rename things, "clean up," or upgrade dependencies unless asked. Unrequested churn is how regressions get in.
4. **Never invent requirements.** If the PRD is silent on an edge case, ask. Do not guess and do not build the more impressive version.
5. **Read before you write.** Open the actual file. Never patch from memory of what it probably contains.
6. **Report honestly.** If something is untested, half-working, or a known compromise, say it in plain terms at the end of the response. Never claim a fix works when it hasn't been exercised.
7. **Bump the version on every change.** Every Mangonese app carries a visible version string (`APP_VERSION`), displayed in the UI footer or settings. Patch for fixes, minor for features. No exceptions.
8. **One concern per commit.** Semantic commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`.

---

## 1. Locked — the Mango schema

These are not open for improvement. Do not "modernize" them.

**Stack**
- Vanilla HTML/CSS/JS. No framework, no build step, no bundler unless complexity genuinely demands it — and that's a conversation, not a decision you make.
- No npm dependency in the client unless it is doing real work you cannot reasonably hand-write. Every dependency is a supply-chain liability and a permanent maintenance tax.
- Firebase: Firestore, Auth, Hosting, Cloud Functions.
- Firebase Auth from day one. Anonymous is fine for v1, but the `uid` exists from the first write.
- Hosted at `*.mangonese.dev` via Firebase Hosting.
- AI features use the Anthropic API, default `claude-haiku-4-5`, **always** proxied through a Cloud Function. An API key never touches client code, client config, or the repo.

**Design**
- Mobile-first at 390px. Design the phone layout first; desktop is a widened version of it, never the other way around.
- Dark mode default, with `prefers-color-scheme` detection and a manual toggle persisted in `localStorage`.
- DM Sans via Google Fonts.
- Brand tokens imported from `https://mangonese.dev/shared/mangonese.css`. Use the tokens. Never hardcode a hex that a token already covers, and never introduce a new brand color without asking.

| Token | Value |
|---|---|
| bg base | #0d1117 |
| bg raised | #0f1923 |
| bg overlay | #161f2e |
| text | #e8f0ea |
| mango | #f0a500 |
| mango-warm | #f8c820 |
| teal | #3dd6ac |
| error | #e85a5a |
| radius | 8 / 12 / 16 / 40px |

- Mango = primary action and brand. Teal = success, positive delta, confirmation. Error red = destructive and failure only. Never use error red for emphasis, and never use mango for a destructive action.

**Code & data**
- Section header comments `// ── NAME ──` to divide files. Inline comments sparse and only where the *why* isn't obvious.
- Every `async` wrapped in try/catch with a user-facing toast on failure. A silent catch is a bug.
- Hard delete, always behind a confirmation modal. No soft-delete tombstones, no trash bin, unless the PRD says so.
- Firestore rules are owner-only via `ownerUid`.
- AI calls log to `/ai_logs/{uid}/{callId}`.
- System prompts live in Firestore at `/prompts/{id}` — not hardcoded in the client, not hardcoded in the function.

**Workflow**
- Git initialized day one, standard `.gitignore`, private GitHub repo.
- `README.md` required and kept current.
- No `CHANGELOG.md` until there are real users.

---

## 2. Project structure

```
/
  index.html
  /assets/          images, icons, fonts fallback
  /css/
    app.css         app-specific styles only; tokens come from shared
  /js/
    app.js          bootstrap + routing
    auth.js         auth lifecycle
    db.js           ALL Firestore reads/writes
    ui.js           render helpers, toast, modal, focus management
    state.js        in-memory app state + subscribe/notify
    /features/      one file per feature domain
  /functions/       Cloud Functions
  /docs/
    prd.md
  firebase.json
  firestore.rules
  firestore.indexes.json
  CLAUDE.md
  README.md
```

**Layering, strictly enforced:**
- `db.js` is the only place that talks to Firestore. Feature code calls `db.getThings()`, never `getDocs(...)` inline.
- Render functions read from state and produce DOM. They do not fetch, and they do not write.
- Event handlers orchestrate: validate → call db → update state → let state notify render.
- No file over ~400 lines. When one grows past that, split by domain, not by "utils."
- No global mutable variables outside `state.js`.

---

## 3. State and data flow

- One source of truth per piece of data. If a value lives in `state.js`, the DOM does not also own it. Never read application state back out of `textContent`, `dataset`, or an input's `.value` as if it were canonical.
- State changes go through a setter that notifies subscribers. No function reaches into another module's DOM.
- Render is a pure function of state: same state → same DOM. This is what makes bugs reproducible.
- Prefer full re-render of a small region over targeted DOM surgery. Surgical patches are where drift and ghost rows come from. Surgical only when profiling shows a real problem.
- Every `onSnapshot` listener must be unsubscribed on teardown, sign-out, and view change. Store the unsubscribe function; call it. Leaked listeners are the #1 cause of "why did that reappear."
- Async writes must be race-safe: capture the request identity before the await, and after it resolves, verify the user is still on the same record/view before touching the DOM. Late responses must be discarded, not applied.
- Never trust ordering of concurrent awaits. If order matters, sequence explicitly.

---

## 4. Security

Assume the client is fully hostile — the app is single-user today, but the rules stand regardless.

**Secrets**
- No API keys, tokens, service-account JSON, or webhook URLs in client code, `index.html`, or the repo. Ever.
- Cloud Function secrets live in Firebase Secret Manager / environment config, never in source.
- Firebase web config (apiKey, projectId, etc.) is public by design and belongs in the client — the security boundary is Firestore rules, not that key. Don't confuse the two.
- `.gitignore` must cover `.env*`, `serviceAccount*.json`, `*.pem`, `.firebase/`, `node_modules/`.

**Firestore rules**
- Deny by default. Every collection explicitly allowed.
- Owner-only: `allow read, write: if request.auth != null && request.auth.uid == resource.data.ownerUid;`
- On create, validate `request.resource.data.ownerUid == request.auth.uid` — otherwise a client can write documents owned by someone else.
- Validate types and required fields in rules, not only in JS. Rules are the real gate.
- Prevent field tampering: an update must not be able to change `ownerUid` or `createdAt`.
- Rules changes require a stated test: what should now succeed, what should now fail.

**Cloud Functions**
- Every callable verifies `context.auth`. Unauthenticated → throw `unauthenticated`.
- Validate and type-check every input at the function boundary. Reject unexpected fields rather than passing them through.
- Enforce a per-user rate limit and a max input size on any function that calls a paid API. An unbounded proxy is an unbounded bill.
- Cap `max_tokens` and set a timeout on outbound calls. Never let a hung upstream hold a function open.
- Return sanitized errors to the client. Stack traces, upstream error bodies, and internal IDs stay in the logs.
- Enable **Firebase App Check** on Functions and Firestore before anything is publicly reachable.

**Client-side injection**
- Never `innerHTML` with any value that originated from a user, Firestore, an API, or a URL parameter. Use `textContent`, or build nodes with `createElement`.
- `innerHTML` is acceptable only for developer-authored static template strings with zero interpolation of dynamic data. If you interpolate, you're wrong.
- Never `eval`, `new Function`, or `setTimeout("string")`.
- Sanitize and validate URL parameters before use; treat the query string as attacker-controlled.
- Set a Content-Security-Policy header in `firebase.json` restricting `script-src` to self and the specific CDNs actually used. No `unsafe-inline`, no `unsafe-eval`.
- External links: `rel="noopener noreferrer"`.

**Data handling**
- Never log PII, tokens, financial detail, or full AI prompt/response bodies to the browser console. Console logs in production ship to whoever opens devtools.
- `/ai_logs` stores metadata and content under the owner's uid with the same owner-only rules — it is not a debug dumping ground.
- No third-party analytics, trackers, or fonts beyond Google Fonts without asking.

---

## 5. AI feature rules

- All model calls proxy through a Cloud Function. No exceptions, no "just for local testing."
- System prompts are fetched from `/prompts/{id}` and cached in memory per session. Never inline a prompt in code as a fallback that can silently diverge.
- The model's output is untrusted input. Validate its shape before use. If you asked for JSON, parse defensively in a try/catch and handle the failure path with a real UI state — never let a parse error surface as a blank screen.
- Never render model output with `innerHTML`.
- Never let model output trigger a write, a delete, or a navigation without an explicit user confirmation step.
- Every AI surface needs: a loading state with a cancel affordance, a visible failure state with retry, and a token/timeout ceiling.
- Log to `/ai_logs/{uid}/{callId}`: timestamp, prompt id, model, token counts, latency, outcome. That's the only way to debug quality later.
- Label AI-generated content in the UI as a draft for review. It is never presented as authoritative.

---

## 6. UX/UI

**Layout and hierarchy**
- Every screen answers one question or supports one job. If it's doing two, it's two screens.
- One primary action per screen, styled in mango. Everything else is secondary or tertiary. Two competing primary buttons means neither is primary.
- 4px spacing scale. Group by proximity; do not lean on borders to create structure that spacing should create.
- Content-first: the thing the user came for is above the fold at 390px. Chrome, filters, and settings come after.
- Respect safe areas on Android: `viewport-fit=cover` plus `env(safe-area-inset-*)` padding. Nothing important within 16px of a screen edge.
- Bottom-anchor the primary action on mobile — thumb reach matters more than visual convention.

**Touch and input**
- Minimum touch target 44×44px, with at least 8px between adjacent targets. Small icon buttons get an expanded hit area via padding.
- Correct `inputmode` and `type` on every input so Android shows the right keyboard: `type="email"`, `inputmode="decimal"`, `inputmode="numeric"`, etc.
- `autocomplete` attributes on anything the browser can fill.
- Font-size ≥16px on inputs to prevent iOS zoom-on-focus.
- No hover-only affordances. If it only appears on hover, it does not exist on a phone.

**Feedback and latency**
- Every action gets acknowledgment within 100ms. If the result takes longer, show progress.
- Under ~300ms: no spinner, just apply the result. 300ms–1s: inline spinner on the control. Over 1s: skeleton or progress with what's happening.
- Optimistic UI for low-risk, high-frequency writes (toggles, reorders, check-offs): apply immediately, roll back visibly with a toast on failure.
- Never optimistic for money, deletes, or anything with real-world consequence. Those wait for confirmation.
- Disable the submit control while a write is in flight, and re-enable on both success and failure. Double-submit is a bug, and it's on you to prevent it.

**The four states — every view implements all four**
1. **Loading** — skeleton matching the real layout's shape. Not a centered spinner on a blank page, and never a layout that jumps when data lands.
2. **Empty** — explains what goes here and offers the action that fills it. An empty screen is an invitation, not an error.
3. **Error** — says what failed, in user terms, and gives a retry. Never a dead end, never a raw error code, never blank.
4. **Populated** — the normal case.

Partial and stale states count too: offline banner, "last synced" indicator where freshness matters.

**Forms**
- Validate on blur, not on every keystroke. Re-validate on submit.
- Error messages sit adjacent to the offending field and state how to fix it: "Enter an amount greater than 0," not "Invalid input."
- Never clear a user's input on a validation failure. Never lose typed data on a failed save — hold it and let them retry.
- Preserve in-progress form state across accidental navigation where the form is longer than a couple of fields.
- Label every input with a real `<label>`. Placeholder is not a label.

**Destructive actions**
- Confirmation modal, always. The modal names the specific object: "Delete 'March Reconciliation'?" — not "Are you sure?"
- The destructive button is red, is not the default-focused element, and is labeled with the verb: "Delete." The escape is "Cancel."
- Modal closes on Escape and on backdrop click; focus is trapped inside while open and returned to the trigger on close.
- Bulk destructive actions state the count and are not recoverable — say so.

**Navigation**
- Current location is always visible. Back always works and goes somewhere sensible; Android hardware back must not exit the app from a modal or a sub-view.
- Deep-linkable views use the URL hash so refresh and share preserve position.
- Never trap the user in a flow with no exit.

**Motion**
- Purposeful only: state transitions, spatial orientation, drawing attention to a change. Not decoration.
- 150–250ms, ease-out for entrances, ease-in for exits. Anything over 300ms feels broken on mobile.
- `@media (prefers-reduced-motion: reduce)` — collapse to instant. Non-negotiable.
- No animation on scroll-into-view for content the user is trying to read.

**Accessibility floor**
- Semantic HTML first. A `<div>` with a click handler is a bug; use `<button>`.
- Visible `:focus-visible` ring on every interactive element, in mango, with sufficient contrast on all three backgrounds.
- Full keyboard operability: tab order follows visual order, Escape closes overlays, Enter submits.
- Toasts and async status changes announce via `aria-live="polite"` (`assertive` for errors).
- Body text contrast ≥4.5:1, large text ≥3:1. Check `#e8f0ea` on the raised and overlay backgrounds when reducing opacity for secondary text — dimmed text is where this usually fails.
- Color never carries meaning alone: pair with an icon, a label, or a sign.
- `alt` on meaningful images, `alt=""` on decorative ones.
- Test one full flow with keyboard only before calling a feature done.

**Microcopy**
- Sentence case. Plain verbs. Name things by what the user controls, not how the system works.
- Buttons state what happens: "Save changes," not "Submit." The verb carries through the flow — a "Publish" button produces a "Published" toast.
- Errors don't apologize and are never vague. Say what happened and what to do.
- Consistency over cleverness. One name per concept across the whole app.

---

## 7. Reliability and bug reduction

- **Fail loudly in dev, gracefully in prod.** No empty catch blocks. If a catch can't handle it, rethrow with context.
- Toast on error is the floor, not the ceiling: the UI must also return to a usable state — spinner cleared, button re-enabled, state rolled back.
- Guard every assumption at boundaries: Firestore documents may be missing fields, may be missing entirely, and may have the wrong type after a schema change. Read defensively; never chain into a possibly-undefined document.
- Write dates as Firestore `Timestamp`, never strings. Convert at the render boundary only. Store money as integer minor units — never floats.
- Every write includes `ownerUid`, `createdAt`, `updatedAt`. Every read path tolerates documents written before the current schema.
- Idempotency: a retried write must not create a duplicate. Generate the doc id client-side for creates that may be retried.
- Debounce user-driven queries and autosaves (250–400ms). Throttle scroll and resize handlers.
- Clean up on teardown: listeners, timers, intervals, observers, object URLs, abort controllers.
- Handle offline explicitly — Android connectivity drops. Firestore's offline cache means writes queue silently; the UI must show pending vs. synced where it matters.
- Feature-detect, don't user-agent sniff.
- When fixing a bug: reproduce it first, state the root cause in one sentence, fix the cause, then say what else touches that code path. A fix you can't explain is a coincidence.

---

## 8. Testing

Session-based, in a real browser, via Playwright. This is how QA is done here.

- A test session is a **user** doing a sequence of actions over a timeline — not a script calling functions.
- **Forbidden:** calling app functions directly, mocking Firestore/Auth/the AI proxy, asserting on internal variables or implementation details. If the test can pass while the app is visibly broken, the test is worthless.
- Assert on what the user sees: rendered text, visible state, enabled/disabled controls, toast contents, URL.
- Every session includes disruption: reload mid-flow, navigate away and back, go offline and come back, background the tab, double-tap the submit button, submit an empty form, hit Escape mid-modal.
- Every session includes persistence checks across the three layers — DOM, `localStorage`, Firestore — and they must agree.
- **Chain sessions.** Session 2 starts from the state Session 1 left behind. Most real bugs live in the seams between sessions, not inside one.
- Run at 390px viewport by default; desktop viewport is the secondary pass.
- Include an auth-boundary session: signed out, signed in as owner, and (where relevant) a second uid attempting to read the first uid's data — which must fail.

**Definition of done for any feature**
- [ ] Works at 390px and at desktop width
- [ ] All four states implemented (loading / empty / error / populated)
- [ ] Keyboard-only pass completed
- [ ] Failure path exercised — network off, permission denied, malformed data
- [ ] Listeners and timers cleaned up
- [ ] Firestore rules updated and tested if the data model changed
- [ ] No console errors or warnings
- [ ] Version bumped
- [ ] README updated if setup or behavior changed

---

## 9. Performance budgets

- First meaningful paint under 1.5s on a mid-tier Android over 4G.
- Total JS under 150KB uncompressed for a v1 app. If you're approaching that with no framework, something is wrong.
- Fonts: preconnect to Google Fonts, `font-display: swap`, load only the weights actually used.
- Images: explicit `width`/`height` to prevent layout shift, `loading="lazy"` below the fold, sized for a 390px viewport.
- Never fetch a whole collection to display ten items. Query with `limit()` and paginate. Add the composite index rather than filtering client-side.
- Cache reference data that rarely changes for the session; don't re-read `/prompts` on every call.
- No layout thrash: batch reads then writes when touching the DOM in a loop.

---

## 10. Anti-patterns — do not do these

- Adding a framework, build step, or dependency without asking.
- `innerHTML` with interpolated data.
- Silent catch blocks, or catches that only `console.log`.
- Business logic living in an event handler.
- Duplicated Firestore query logic outside `db.js`.
- Hardcoded hex values that duplicate a brand token.
- New brand colors, fonts, or radii.
- API keys anywhere near the client.
- `setTimeout` used to paper over a race condition.
- Deleting or rewriting code you weren't asked to touch.
- Marking work complete without exercising the failure path.
- Claiming something is tested when it isn't.
