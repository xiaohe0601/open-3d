# Modra Task Context Spec Delta

## Purpose

Makes modeling intent and task progress explicit through inspectable scene references, deliberate visual context, read-only plans, and follow-up messages delivered at safe execution boundaries.

## ADDED Requirements

### Requirement: Users attach explicit scene references
The system SHALL let users reference objects by stable identifier through object selection or an object mention picker and inspect the referenced names before sending. References SHALL resolve to bounded current scene data at dispatch, not arbitrary application state.

#### Scenario: Send a selected-object reference
- **WHEN** the user attaches selected objects and submits a prompt
- **THEN** the outgoing context identifies those objects and their bounded relevant scene data, while the transcript records the names and version used

#### Scenario: Referenced object was removed
- **WHEN** an object reference cannot be resolved at dispatch
- **THEN** the request is blocked with a prompt to remove or replace the reference rather than binding to a different object with the same name

### Requirement: Viewport snapshots require explicit user action
The system SHALL let users capture a viewport image, preview or remove it before sending, and treat it as a normal bounded image attachment. It SHALL NOT continuously capture the viewport or transmit a screenshot merely because Modra opens.

#### Scenario: Attach a viewport snapshot
- **WHEN** the user chooses to capture the viewport
- **THEN** a preview is added within the existing attachment count and size limits and is sent only with a submitted message

#### Scenario: Snapshot cannot be captured
- **WHEN** viewport capture is unavailable, tainted, or exceeds supported limits
- **THEN** the application explains the failure without altering the scene or submitting a request

### Requirement: Planning mode cannot mutate or preview the scene
The system SHALL offer Plan and Build task modes independently of approval policy. Plan mode SHALL allow bounded read-only queries and structured planning but SHALL NOT expose mutation tools, generate scene previews, or commit modeling commands.

#### Scenario: Plan a model with Auto-approve selected
- **WHEN** a user submits a task in Plan mode while the approval preference is Auto-approve
- **THEN** only read-only tools are available and the document remains unchanged

#### Scenario: Start building from a plan
- **WHEN** the user explicitly chooses to build an existing plan
- **THEN** a new Build run uses the current scene version and current approval policy instead of treating plan text as preapproved commands

### Requirement: Task progress distinguishes intent from applied outcomes
The system SHALL display an ordered structured plan with pending, active, completed, blocked, or cancelled steps when a plan is produced. Step completion SHALL NOT imply modeling changes were committed; associated change-set decisions SHALL remain visible separately.

#### Scenario: Preview exists but approval is pending
- **WHEN** a plan step has produced a valid proposed batch awaiting review
- **THEN** progress shows the review boundary and does not label the scene change as applied

#### Scenario: No structured plan is supplied
- **WHEN** a provider responds without plan updates
- **THEN** normal replies and tool activity remain usable without fabricated percentages or hidden reasoning

### Requirement: Follow-ups enter a visible queue at safe boundaries
The system SHALL allow users to compose and queue follow-ups during execution, inspect or remove unsent entries, and dispatch them in order only after the active run reaches a safe terminal boundary and all pending proposals are resolved. Queueing SHALL NOT inject content into an in-flight HTTP request.

#### Scenario: Queue a correction during streaming
- **WHEN** a user queues a correction while tools are running
- **THEN** the current request remains intact and the correction is visibly pending until the active task completes or the user explicitly stops it

#### Scenario: A task fails with retained proposals
- **WHEN** a request fails while follow-ups are queued and a partial proposal awaits Keep or Discard
- **THEN** no queued request is sent until the proposal is resolved and the user explicitly resumes the queue

#### Scenario: Dispatch a queued object reference
- **WHEN** a queued entry becomes eligible to send
- **THEN** its scene references are revalidated against the current project and its captured images remain the originally attached images

#### Scenario: Cancel or reload with queued work
- **WHEN** a task is cancelled, the project changes, or the application reloads
- **THEN** unsent entries are retained in their originating session as paused drafts and are not automatically sent

### Requirement: Context size failures remain visible and recoverable
The system SHALL bound scene data and tool history sent to providers and explain when a request cannot fit supported context limits. It SHALL NOT silently discard user instructions, images, application outcomes, or tool-call/result pairing to force a request through.

#### Scenario: A session exceeds the usable context budget
- **WHEN** the next request exceeds the configured context budget or the provider rejects its size
- **THEN** Modra preserves the local transcript and offers removal of explicit attachments or creation of a new session without automatic destructive truncation
