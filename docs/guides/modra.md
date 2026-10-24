# Modra

[简体中文](modra.zh-CN.md) · [Connections](modra-connection-routes.md) · [Privacy and troubleshooting](ai-privacy-and-troubleshooting.md)

Modra is Open 3D's modeling task workspace. Open it from the floating **Modra** launcher. It uses your configured AI provider; no model account is included.

## Plan, Build and Review

- **Plan** allows scene queries and structured planning only. Even **Auto-approve** cannot mutate or preview a scene in Plan mode.
- **Build** can propose a batch of modeling commands. **Request approval** previews the batch; inspect affected objects, ordered commands and tool details before accepting or rejecting the whole batch. Each accepted batch is undoable.
- **Build from plan** starts a new task against the current scene and current approval choice. Plan step completion is intent/progress, not proof a scene edit was applied.
- **Auto-approve** applies successful batches and continues, pausing after 20 batches. Failed partial batches still require **Keep changes** or **Discard changes**. Keep does not retry the failed request.

Manual edits, Undo/Redo, replacement projects and ownership loss invalidate stale previews. A recorded accepted decision does not prove that change exists in a newly loaded scene. Reopening history never restores a scene or replays a request.

## Deliberate Context

Use **Mention an object** or **Attach selection** to attach stable object references (up to 20). Names are labels, not identities; renamed objects resolve their current properties, but removed/replaced objects block dispatch. Remove or replace invalid references.

**Capture viewport** adds a previewable image without changing camera, selection or geometry. Nothing uploads until you send. Upload/capture share the five-image, 5 MB per-image limit (JPEG, PNG, WebP or GIF). Choose a model supporting images and tools.

## Follow-ups and Reading

New assistant replies show text, tool activity and proposed commands in response order, including when they alternate. Tool details remain expandable. Accept or reject still applies to the entire preview batch, not individual timeline entries. This order survives reopening the session; older sessions keep their original grouped display.

While Modra works, keep editing your draft and use **Queue prompt** to capture a follow-up. Inspect or remove unsent entries. Tasks run FIFO only after the whole active task and pending review finish. Stop, failure, project switch and reload pause queued work. Resolve retained proposals, then explicitly **Resume queue**; no automatic replay occurs. Changes to mode or approval apply to future tasks, not the running task.

All messages share one left-aligned reading column. The icon-only stop control sits to the right of request status. Scrolling more than 80 CSS pixels above the transcript bottom suspends auto-follow, including while tools/images/Markdown grow. Use **Return to bottom** to scroll smoothly to the latest content and resume following. Scrolling manually interrupts the animation; reduced-motion preferences make the return immediate. The compact, centered return button overlays the transcript without reserving bottom space. It shows a spinner while Modra responds; hovering or focusing it reveals the down arrow. Buttons, menus, reference selection, review and queue actions support keyboard focus and touch.

## Local Sessions and Limits

The title-bar session menu creates, opens, renames and deletes local sessions. New sessions and unsent drafts remain in memory until the first task is sent or the title is manually saved. New session is a no-op while the current session is still unsaved. Paste reference images directly into the composer, or use the image picker; both share the five-image, format and size limits. Titles are limited to 10 characters. The first request (or image filenames for image-only requests) provides an immediate provisional title. After the first reply completes, a separate text-only request uses the configured provider, protocol and connection route to summarize it. Only bounded first-round text is sent, without images, scene data or tool details. Failure keeps the provisional title; manual renames are never overwritten, and reopening history never repeats naming. Message headers show local time and a compact, right-aligned copy icon that copies text without replacing the current draft or its images. Once a session is saved, its drafts, images and queued tasks stay in a separate browser database, not native projects or glTF. History is scoped to the current project. Abandoning an unsaved project removes its temporary conversations and unreferenced images; successfully saved projects retain their history. Page exit cleanup is best-effort, with marked temporary history checked on later visits after writer leases expire. Legacy unrelated history is not migrated or scanned. A second tab is read-only while another owns the session. Storage denial/quota errors are visible; memory fallback is not durable.

Modra does not silently shorten history. Byte budgets are 1 MiB semantic history, 30 MiB historical image data, 4 MiB per provider response, 512 KiB assistant text per run and 256 KiB per tool input/result. These are safety limits, not token-window guarantees. If context is too large, start a new session or remove unsent attachments. If output is too large, received content and valid previews remain; resolve pending changes and request a smaller step. Provider token limits can be lower.

The floating launcher robot blinks while idle, moves while generating, nods on completion and shakes on errors. If Modra is open, completion returns to idle after three seconds. If minimized, completion stays visible until Modra is reopened. Starting another operation cancels the previous countdown. The title-bar minimize button hides Modra without interrupting work. Reduced-motion preferences disable animation while retaining distinct expressions and accessible status descriptions.

## Context window and automatic compaction

The ring in the composer opens a context-window breakdown. It estimates the history,
images, fresh scene observation, tool overhead and next output reserve, rather than
reporting cumulative billing usage. Tokenizers and image processing vary by provider,
so these numbers are approximate. In AI service settings, expand **Context settings**
to configure the model's input-plus-output capacity. The default is a conservative
32,768-token application budget, not an automatically detected model limit. Configure
no more than the limit documented by your provider. Modra reserves 4,096 tokens for
modeling output per tool round.

Before a new task, when estimated occupancy including the output reserve reaches 80%,
Modra summarizes earlier tasks using the configured AI service, protocol and connection
route. This is a separate, potentially billable, text-only request, without modeling
tools or original image data. Large histories are processed in bounded sequential
chunks. The current task, including its tool call/result pairs and continuations,
remains intact. Full messages and local images remain available in Sessions; only
future model requests use the summary. The checkpoint is saved with the local session.
Images from summarized turns are not sent again; reattach an image when its original
visual details are needed.

Summaries are historical context, not current scene authority. Current change-set
outcomes and the latest earlier task plan accompany them; fresh scene queries remain
necessary, and compaction never applies or replays commands. A failed or stopped
compaction does not replace the prior checkpoint or delete messages. It can be retried
by resending the task. Compaction is cancellable and has a two-minute time limit.
If the current task alone exceeds the configured budget, Modra reports a context-limit
error rather than silently truncating it. Each intermediate tool round also checks its
estimated size; if it becomes too large, start a smaller follow-up task or adjust the
capacity to your model's documented limit. Automatic compaction currently runs at task
boundaries, not inside an ongoing tool round.

Automatic temporary-history recovery also requires an exclusive Web Lock for the workspace. An open or frozen tab holds that lock independently of writer heartbeat expiry. Browsers without Web Locks skip automatic cross-tab recovery; explicit workspace abandonment still cleans its own history.