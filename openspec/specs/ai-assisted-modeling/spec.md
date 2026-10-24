# AI-Assisted Modeling Specification

## Purpose

Provides an in-product natural-language modeling conversation while keeping service configuration, transmitted scene context, and document mutations under user control.

## Requirements

### Requirement: Users configure a supported AI service
The system SHALL let users configure a supported protocol, endpoint URL, model, and API credential without requiring a first-party AI account or service.

#### Scenario: Save a valid configuration
- **WHEN** a user enters a complete supported configuration and saves or tests it
- **THEN** the system validates required fields and makes the configuration available for subsequent requests

#### Scenario: Reject an incomplete configuration
- **WHEN** a required setting is missing or malformed
- **THEN** the system identifies the invalid setting and sends no modeling request

### Requirement: Users can converse with AI in the modeling workspace
The system SHALL provide Modra as the built-in modeling assistant for submitting natural-language tasks and viewing responses, tool activity, proposals, and request status in English and Simplified Chinese. Closing its floating window SHALL NOT discard session state or resize the modeling canvas.

#### Scenario: Submit a modeling request
- **WHEN** a user submits a request with a usable provider configuration
- **THEN** Modra displays the user request, assistant response, and proposed modeling actions in order

#### Scenario: Recover from an unavailable configuration
- **WHEN** a user submits a request without a usable provider configuration
- **THEN** Modra directs the user to provider settings and does not send a request

#### Scenario: Identify the assistant in either language
- **WHEN** the user opens the launcher, assistant window, or session controls in English or Simplified Chinese
- **THEN** the assistant's product name is Modra and accessible labels identify its actions without depending on a particular provider

### Requirement: AI tools are limited to the modeling command and query catalog
The system SHALL expose only registered, schema-defined modeling commands, bounded scene queries, and bounded task-plan metadata tools. Planning metadata SHALL NOT mutate the scene, and all modeling writes SHALL pass through the shared command contract and approval policy.

#### Scenario: AI inspects scene context
- **WHEN** the assistant requests scene or selection information
- **THEN** the system returns only bounded data allowed by registered queries and the requested context scope

#### Scenario: AI proposes an unregistered operation
- **WHEN** an assistant response requests an operation absent from the active command catalog
- **THEN** the system rejects the operation and leaves the project unchanged

#### Scenario: AI updates a task plan
- **WHEN** the assistant invokes a registered plan-metadata tool with valid structured steps
- **THEN** task progress changes without modifying the modeling document or its undo history

### Requirement: Users review proposed modeling changes
The system SHALL validate ordered command change sets against their originating project, workspace generation, and document mutation version. Request approval SHALL be the default; explicit Auto-approve SHALL apply only completed valid batches. Every commit SHALL be atomic, undoable, and applied at most once; previews SHALL NOT count as commits.

#### Scenario: Complete a multi-step modeling request
- **WHEN** a task requires multiple queries or commands in Request approval mode
- **THEN** tools operate against the evolving preview and no proposed changes enter history until the user accepts the completed batch

#### Scenario: Review a valid proposal
- **WHEN** a change set contains registered commands with valid arguments and current preconditions
- **THEN** Modra shows affected objects and understandable ordered effects alongside inspectable command details and lets the user accept or reject the whole batch

#### Scenario: Reject an invalid proposal
- **WHEN** any proposed command has invalid arguments or unmet preconditions
- **THEN** the invalid command is rejected without partial mutation of the live scene and the blocking condition is explained

#### Scenario: Accept a proposal
- **WHEN** the user confirms a valid current-version change set
- **THEN** the shared command contract applies it as one atomic undoable group and records its application outcome

#### Scenario: Undo an accepted proposal
- **WHEN** the user undoes an accepted change set
- **THEN** all changes from that batch revert as one history action and the transcript no longer implies that its effects remain applied

#### Scenario: A proposal becomes stale
- **WHEN** manual editing, undo/redo, or project replacement changes the expected version before application
- **THEN** manual and automatic application both refuse the stale batch, clear its active preview, and require regeneration against the current scene

#### Scenario: Repeat an application action
- **WHEN** a click, callback, or recovered event tries to apply an already committed change set again
- **THEN** no second mutation or history entry occurs

#### Scenario: Automatically approve completed work
- **WHEN** the user explicitly chooses Auto-approve and a Build task completes a valid batch
- **THEN** the batch is committed once, its successor uses the resulting scene, and automatic continuation pauses after at most 20 applied batches

### Requirement: Users control request lifecycle
The system SHALL show task progress and allow cancellation of active requests and retry waits. Only one mutating task SHALL own a workspace at a time. Project replacement or detaching a deleted saved-project scope SHALL invalidate task ownership so late events cannot preview, commit, or continue work in a different workspace or scope. Durable-session work SHALL also require unexpired writer ownership.

#### Scenario: Cancel a pending request
- **WHEN** a user cancels an in-flight request
- **THEN** the system stops processing where supported, marks it cancelled, clears unconfirmed proposals, and retains streamed text and previously applied undoable batches

#### Scenario: Cancel while reconnecting
- **WHEN** the user cancels during retry backoff
- **THEN** the wait ends and no further retry or tool continuation starts

#### Scenario: Change projects during execution
- **WHEN** the workspace replaces its active project
- **THEN** its old request is aborted, its preview is cleared, and callbacks from the old generation cannot affect the new project

#### Scenario: Delete the active saved project without closing its scene
- **WHEN** the saved-project scope is deleted while its scene stays mounted
- **THEN** old tasks and approvals lose ownership, the scene retains its contents/history under a new temporary scope, and late callbacks cannot apply or continue old work

#### Scenario: Change approval policy after work was proposed
- **WHEN** a user changes approval mode while idle with an unresolved proposal
- **THEN** the new preference does not retroactively approve that proposal

### Requirement: Users are informed about external data transmission
The system SHALL disclose the configured provider and actual Direct, Open 3D gateway, or Self-hosted gateway route in settings. Prompts, images, selected context, and bounded tool results SHALL be sent only through the user-selected route; neither route changes nor viewport capture SHALL happen silently.

#### Scenario: Send scene context to the configured service
- **WHEN** a request includes scene or selection context
- **THEN** the system sends only bounded registered-query or explicit-attachment context through the selected route to the configured endpoint and exposes both destinations in settings

#### Scenario: Gateway routing is selected
- **WHEN** a user chooses an intermediary
- **THEN** settings explain that credentials and request content transit it and distinguish official policy from user-managed gateway responsibility

### Requirement: AI failures do not corrupt projects
The system SHALL classify request and tool failures without applying incomplete or invalid work. Valid partial proposals SHALL remain reviewable after non-cancellation failures, including in Auto-approve mode. Previously approved batches SHALL remain intact and undoable. Empty failed assistant replies SHALL be omitted unless they contain meaningful tool or proposal records.

#### Scenario: Provider or network failure
- **WHEN** a request fails or returns an incompatible response
- **THEN** Modra reports an actionable error, preserves available conversation context and valid partial proposals, and commits no additional unapproved changes

#### Scenario: Keep or discard interrupted proposals
- **WHEN** a user chooses Keep or Discard after a failed request with a valid current-version partial batch
- **THEN** Keep commits the batch once as an undoable group, Discard only clears its preview, and neither action sends another AI request

#### Scenario: Restore inputs only before a meaningful response
- **WHEN** an initial request fails without nonblank text, a valid proposal, or successful tool output
- **THEN** its text and images return to the composer without overwriting a newer user draft

#### Scenario: Preserve the draft after a meaningful response
- **WHEN** a request fails after nonblank text, a valid proposal, or successful tool output, or a later continuation fails
- **THEN** the original text and images remain in history and are not restored over the composer draft

#### Scenario: A later request begins
- **WHEN** the user starts another run after resolving an earlier failure
- **THEN** loading indicators belong only to active work and earlier failed tools or replies remain terminal

### Requirement: Users can remove locally stored credentials
The system SHALL disclose the limitations of browser-stored credentials and let users remove saved provider API keys and self-hosted gateway tokens independently. Credentials SHALL NOT be embedded in transcripts, project exports, copied diagnostics, or URLs.

#### Scenario: Remove a credential
- **WHEN** a user removes a saved credential
- **THEN** the local value is deleted, subsequent requests cannot recover it from a retained configuration snapshot, and the UI explains that removal does not revoke it at the provider or gateway

### Requirement: Tool activity has explicit terminal states
The system SHALL display inspectable tool names, parameters, and results with preparing, running, completed, failed, or cancelled states. Tool completion SHALL be distinct from command application, and failures SHALL stop further tool rounds for that run.

#### Scenario: A tool errors during streaming
- **WHEN** a tool fails or the run terminates while a tool is preparing or running
- **THEN** tool activity ends with an appropriate failed/cancelled state and no permanent loading indicator remains
