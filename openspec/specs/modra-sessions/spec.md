# Modra Sessions Specification

## Purpose

Lets users maintain durable browser-local modeling conversations and reference assets without mixing projects, exposing credentials, or automatically replaying work after interruption.

## Requirements

### Requirement: Users manage project-scoped sessions
The system SHALL let users create, list, reopen, rename, and delete Modra sessions scoped to a workspace project identity. Sessions SHALL remain separate from the native project format and interchange exports.

#### Scenario: Reopen conversations for a saved project
- **WHEN** a user reopens a saved local project after a page reload
- **THEN** its sessions appear with their saved titles and messages without exposing another project's history

#### Scenario: Save an unsaved project for the first time
- **WHEN** a workspace with temporary sessions is first saved locally
- **THEN** those sessions become associated with the saved project without duplication or message loss

#### Scenario: Duplicate or import a project
- **WHEN** a user duplicates a local project or imports a portable project, including one with a matching document identifier
- **THEN** the replacement workspace receives a distinct session scope and does not inherit the original project's sessions or pending changes

#### Scenario: Delete a local project
- **WHEN** a user confirms deletion of a saved local project
- **THEN** the deletion flow discloses removal of its associated Modra sessions, durably fences its scope before project removal, and cleans up those sessions and unreferenced assets without deleting other projects' data, reporting retryable failures

### Requirement: Deletion fences active work before reclaiming data
The system SHALL durably fence deleted project/session scopes against old execution and writes before removal and cleanup. Cross-database deletion SHALL be retryable. A kept-open scene SHALL receive a fresh temporary scope and host generation, retaining scene contents/history but not deleted conversations. Deletion SHALL fail before project removal if durable fencing is unavailable.

#### Scenario: Delete the active project during generation or review
- **WHEN** a user confirms deletion while Modra is streaming or awaiting approval
- **THEN** its task is stopped, unconfirmed preview and approval ownership are invalidated, queues stop dispatching, and the retained scene becomes unsaved under a fresh scope before accepting new Modra work

#### Scenario: A delayed flush targets a deleted scope
- **WHEN** an old callback or another tab attempts a transcript, draft, or asset-reference write after the scope is sealed
- **THEN** the repository rejects it transactionally without recreating deleted records or references, and a notified owner cancels its old execution

#### Scenario: Project removal fails after sealing
- **WHEN** removing the saved project record fails
- **THEN** associated content is retained sealed, the failure offers retry or explicit cancellation, and cancellation uses a new epoch without reviving old tasks or callbacks

#### Scenario: Cleanup fails after project removal
- **WHEN** the project has been removed but its Modra cleanup fails
- **THEN** the tombstone remains enforced, the failure is visible and retryable, and unrelated projects' data remains intact

#### Scenario: Save the retained scene after deletion
- **WHEN** a user saves the scene that stayed open after its old project was deleted
- **THEN** the new saved project adopts only its fresh temporary session scope and does not recover deleted history or pending changes

### Requirement: Sessions retain complete conversation and tool outcomes
The system SHALL persist ordered messages, attachment references, tool arguments and outcomes, task state, and change-set decisions locally. A later request SHALL preserve valid tool-call/result pairing and distinguish previewed, applied, rejected, interrupted, and obsolete work.

#### Scenario: Continue after an approved modeling batch
- **WHEN** the user sends a later independent prompt in the same session
- **THEN** its context includes bounded relevant tool history and explicit application outcomes rather than claiming a preview was committed

#### Scenario: Recover an incomplete tool call
- **WHEN** a stored transcript contains an interrupted call without a result
- **THEN** the transcript remains inspectable and later provider requests use a valid interrupted-outcome representation rather than an orphan tool call

### Requirement: Historical application is distinct from current scene effects
The system SHALL separate historical application decisions from current scene effects. Reopening SHALL begin with effects unknown and establish them only from matching loaded-scene evidence. Later provider context SHALL qualify unknown/obsolete outcomes and historical queries and obtain fresh bounded scene context. Recovery SHALL NOT replay commands or restore unsaved scenes.

#### Scenario: Applied changes were never saved with the scene
- **WHEN** Modra applies changes and persists their history, but the user reloads and reopens an earlier saved scene
- **THEN** history retains the historical application decision while its current effect is unknown/obsolete, and later model context does not claim those changes exist in the reopened scene

#### Scenario: A scene save and receipt flush complete in different orders
- **WHEN** a crash interrupts either ordering of scene persistence and Modra receipt persistence
- **THEN** recovery uses only verifiable loaded-scene evidence, leaves unsupported effects unknown, and performs no automatic application or scene restoration

#### Scenario: Reopen a verifiably matching scene
- **WHEN** the loaded scene matches persisted application evidence
- **THEN** only effects supported by that evidence are marked present, without interpreting document identity or a saved transcript alone as proof

### Requirement: Durable sessions have one writer across tabs
The system SHALL enforce one session writer through transactional leases, fencing epochs, and revisions. Every durable mutation SHALL check ownership and scope lifecycle atomically. Other tabs SHALL remain read-only or create distinct sessions. Ownership loss SHALL stop execution; recovery SHALL acquire a new epoch before interrupting abandoned work. Notifications SHALL NOT substitute for ownership checks.

#### Scenario: Open a session owned by another live tab
- **WHEN** a second tab opens a session with an unexpired writer lease
- **THEN** it may inspect history but cannot interrupt the live task, write drafts, dispatch requests, approve changes, or reclaim the session's assets

#### Scenario: Recover an abandoned owner
- **WHEN** an owner lease expires and another tab acquires its next epoch
- **THEN** abandoned work is marked interrupted without replay, and writes from the old epoch are rejected even if its original tab resumes

#### Scenario: Ownership expires during a suspended tab
- **WHEN** a tab resumes with an expired lease or detects ownership loss
- **THEN** it cancels old execution and clears unconfirmed preview before any further tool, approval, retry, or queue dispatch, and must reacquire ownership before new work

#### Scenario: Concurrent record or asset updates conflict
- **WHEN** a mutation has a stale revision or asset cleanup races with a live reference
- **THEN** the transaction rejects the stale mutation or retains the referenced asset rather than silently using last-write-wins or leaving dangling references

### Requirement: Reference assets have a local lifecycle
The system SHALL persist image assets as browser-local data referenced by sessions, enforce five images per new message and 5 MB per image across uploads and viewport captures, and let users remove stored session data. Previously stored images SHALL NOT be silently discarded. Credentials SHALL NOT be included in session records, attachment metadata, or project exports.

#### Scenario: Reload a session with reference images
- **WHEN** a user reopens a saved session containing supported images
- **THEN** its image previews and follow-up request attachments are available without uploading them merely to reopen the session

#### Scenario: Delete a session
- **WHEN** a user confirms session deletion
- **THEN** its messages are removed and assets no longer referenced by another session or draft are reclaimed

### Requirement: Persistence failures do not lose active work
The system SHALL report unavailable, malformed, incompatible, or exhausted session storage without blocking manual modeling or silently deleting an active in-memory transcript. Unsaved sessions SHALL be visibly distinguished from durable sessions.

#### Scenario: Image storage exceeds quota
- **WHEN** persisting a message and its images fails
- **THEN** the active message and images remain available in memory, no durable message points to missing new assets, and the user receives a storage warning with deletion/retry guidance

#### Scenario: Open an unsupported storage version
- **WHEN** stored session data uses a newer unsupported version
- **THEN** the application does not overwrite it and offers a separate usable in-memory session

### Requirement: Reload recovery never resumes execution implicitly
The system SHALL mark abandoned previously active tasks as interrupted after reload only after acquiring session ownership, and SHALL NOT resume requests or apply recovered proposals automatically. Another tab's live task SHALL remain owned by that tab. Recovered proposals SHALL be non-applicable until explicitly rebuilt and reviewed against the current workspace version.

#### Scenario: Reload while auto-approval is running
- **WHEN** the page reloads during a modeling task
- **THEN** the session shows its saved progress as interrupted, defaults to Request approval, and sends no request until the user acts

#### Scenario: Recover a saved pending proposal
- **WHEN** a stored session contains an unapplied change set from an earlier workspace generation
- **THEN** it is shown as obsolete review history and cannot be applied directly to the reopened scene

### Requirement: Message presentation supports safe copying
The system SHALL render assistant Markdown without executing HTML or scripts and provide accessible icon-only copy-text actions. It SHALL NOT expose a message reuse action that replaces the composer.

#### Scenario: Copy a historical prompt
- **WHEN** the user copies a prior message
- **THEN** its text is copied without changing the current draft, images, scene or sending a request

#### Scenario: Render untrusted assistant content
- **WHEN** a reply contains raw HTML, an unsafe link, or an external Markdown image
- **THEN** no code executes, unsafe navigation is disabled, and remote images do not load automatically

### Requirement: Transcript following respects the reader's scroll position
The system SHALL follow output within 80 CSS pixels of the bottom and suspend following when the reader scrolls farther away, preserving reading position through streaming and layout changes. An accessible localized floating button SHALL appear beyond the threshold, during and after generation, without resizing content or obscuring the composer. Button activation or user scrolling within the threshold SHALL resume following.

#### Scenario: Output grows while the reader follows
- **WHEN** the reader is following within 80 pixels before new text, tool output, or asynchronous content growth
- **THEN** the transcript stays at its latest bottom without repeated smooth animations, even when a single update grows by more than 80 pixels

#### Scenario: Reader scrolls upward during generation
- **WHEN** wheel, touch, or keyboard scrolling moves the reader more than 80 pixels from the bottom
- **THEN** following stops, further output does not pull the reader down, and a return-to-bottom button becomes available

#### Scenario: Cross the threshold boundary
- **WHEN** user scrolling leaves the bottom distance at exactly 80 pixels or greater than 80 pixels
- **THEN** following is enabled at exactly 80 and suspended above 80, using a nonnegative distance for short transcripts

#### Scenario: Return explicitly to the latest output
- **WHEN** the reader activates the floating button by pointer, touch, or keyboard
- **THEN** the transcript scrolls smoothly toward the live latest bottom, following resumes, and focus remains predictable without stealing composer focus; manual scrolling can interrupt the animation, and reduced-motion preferences make the return immediate

#### Scenario: Scroll manually back near the bottom
- **WHEN** a suspended reader explicitly scrolls within 80 pixels of the bottom
- **THEN** following resumes and subsequent output stays visible without requiring the floating button

#### Scenario: Reading continues through layout and lifecycle changes
- **WHEN** the reader is away from the bottom and a tool detail expands, an image or Markdown layout changes, the window resizes, or a request completes, fails, retries, or receives a queued follow-up
- **THEN** no automatic jump or following reactivation occurs, the reading anchor is preserved where geometry permits, and button visibility reflects the actual remaining distance

#### Scenario: Reopen the same floating session
- **WHEN** the user closes and reopens the mounted Modra window while reading earlier messages
- **THEN** the same session retains its reading state and anchor instead of forcibly scrolling to the latest output

#### Scenario: Short transcript or reduced motion
- **WHEN** the transcript does not overflow or the reader prefers reduced motion
- **THEN** no unnecessary return button appears on a short transcript and returning to the bottom requires no scrolling animation

### Requirement: Switching sessions respects active-task ownership
The system SHALL prevent session changes from transferring an active task, draft, or preview to a different session. Switching with active execution or unresolved proposals SHALL require explicit stop/discard confirmation; declining SHALL leave the session unchanged.

#### Scenario: Switch during an active stream
- **WHEN** the user confirms stopping work and opening another session
- **THEN** the old task is cancelled, its unconfirmed preview is cleared, completed applied batches remain, and late events cannot update the new session


### Requirement: Sessions receive short automatic titles
The system SHALL immediately derive a provisional title of at most 10 Unicode grapheme clusters from the first user request, using image filenames for image-only requests. After the first assistant round completes successfully, it SHALL make one independent, bounded text-only title summarization request through the configured provider protocol and connection route. It SHALL NOT resend images, scene data or tool details for naming. It SHALL persist the title and preserve explicit manual renames; a failed or cancelled naming request SHALL leave the provisional title intact. Opening existing history SHALL NOT trigger naming. Manual titles SHALL also respect the 10-character limit. Routine saved/saving hints SHALL NOT appear in the transcript; actionable storage and ownership warnings SHALL remain visible.

#### Scenario: Reopen an automatically named session
- **WHEN** the first request has been saved and the session is reopened
- **THEN** its generated title is available in the title-bar session menu without a provider request

#### Scenario: Manually rename a session
- **WHEN** the user renames a session and sends subsequent requests
- **THEN** the manual title remains unchanged


#### Scenario: Summarize the first reply
- **WHEN** a fresh first assistant round completes successfully
- **THEN** a separate title request may replace the provisional title without affecting the scene, task outcome or current draft
- **AND** a manual rename made while naming is in flight wins over the generated result

#### Scenario: Timestamped message headers and launcher status
- **WHEN** a new message is created
- **THEN** its header shows the speaker, local time and a compact right-aligned icon-only copy action
- **AND** the message time survives reopening; legacy messages without times do not display fabricated timestamps
- **WHEN** the task is idle, generating, completed or failed
- **THEN** the launcher robot displays a distinct expression and animation even when chat is closed, with static expressions under reduced motion
