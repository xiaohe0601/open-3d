# AI Provider Protocols Specification

## Purpose

Allows Modra to use multiple native AI protocols with consistent local task control while preserving protocol-specific authentication, multimodal inputs, tool continuity, and actionable errors.

## Requirements

### Requirement: Users select one of four supported protocols
The system SHALL support OpenAI-compatible Chat Completions, OpenAI Responses, Anthropic Messages, and Gemini native generation as explicit protocol choices with validated endpoint, model, and credential configuration. Protocol choice SHALL be independent of connection route.

#### Scenario: Save each supported protocol
- **WHEN** a user supplies a valid configuration for a supported protocol
- **THEN** subsequent requests use that protocol's native request shape, authentication, streaming response, and tool conventions

#### Scenario: Reject an unknown protocol
- **WHEN** settings contain an unsupported protocol identifier
- **THEN** Modra identifies invalid settings and makes no modeling request

### Requirement: Existing settings remain usable
The system SHALL migrate valid existing OpenAI-compatible settings to the new schema without losing endpoint, model, or saved credential and SHALL default their connection route to Direct. Migration SHALL NOT opt users into a gateway or Auto-approve.

#### Scenario: Open an existing configured browser
- **WHEN** the browser contains valid version-one provider settings
- **THEN** the existing Chat Completions configuration remains usable with Direct routing and no additional credential entry

#### Scenario: Migration cannot be persisted
- **WHEN** storage rejects the migrated configuration
- **THEN** the original record remains intact and the user receives an actionable warning without an implicit network request

### Requirement: Streaming tasks have protocol-independent observable behavior
The system SHALL expose consistent text, tool activity, retry, completion, cancellation, usage-when-available, and error outcomes for all supported protocols. Hidden model reasoning SHALL NOT be presented as task progress or required for the user to approve changes.

#### Scenario: Perform the same modeling task across protocols
- **WHEN** a capable model on each protocol queries the scene and proposes a command
- **THEN** Modra displays equivalent query/proposal outcomes and applies the same validation and approval rules

#### Scenario: Provider omits usage statistics
- **WHEN** a completed response has no token usage information
- **THEN** Modra treats usage as unavailable rather than zero and still completes the task

### Requirement: Tool continuations remain valid for their protocol
The system SHALL preserve tool identifiers, arguments, results, and required protocol-specific continuation metadata while constructing follow-up requests. Switching protocols SHALL NOT replay applied commands or submit incompatible tool envelopes.

#### Scenario: Continue a Gemini tool round
- **WHEN** the protocol requires opaque continuation metadata from a completed response
- **THEN** Modra preserves that metadata for the matching continuation without displaying it as assistant prose

#### Scenario: Change the provider between runs
- **WHEN** a user changes protocol or model before the next run
- **THEN** Modra rebuilds compatible history from durable semantic messages and application outcomes, excluding incompatible provider-only envelopes and retaining the original local transcript

### Requirement: Capability limitations are explicit
The system SHALL check declared model/protocol capabilities before using images or tools and report unsupported operations without pretending success. Choosing a protocol SHALL NOT imply that every model or compatible endpoint supports all its capabilities.

#### Scenario: An image is attached to a known text-only model
- **WHEN** declared capabilities exclude image input
- **THEN** submission is blocked with guidance to remove the attachment or select an image-capable model

#### Scenario: Compatible service rejects function calling
- **WHEN** a service rejects required tool support despite an otherwise valid configuration
- **THEN** Modra reports a capability/protocol error, preserves inputs and valid partial work according to task recovery rules, and does not retry as a transient connection error

### Requirement: Retries do not duplicate protocol work
The system SHALL preserve the existing maximum of five connection retries after the initial attempt for network failures and HTTP 408, 429, 500, 502, 503, and 504. Retries SHALL use cancellable backoff, honor bounded Retry-After, and SHALL NOT replay a consumed response stream or completed local tools.

#### Scenario: A transient failure precedes a response
- **WHEN** an eligible request fails before its response stream is consumed
- **THEN** Modra shows attempts 1/5 through 5/5 with waits of 1, 2, 4, 8, and 8 seconds unless Retry-After extends a wait up to 60 seconds

#### Scenario: A response stream fails after tool execution
- **WHEN** an established stream fails partway through
- **THEN** Modra preserves text and valid proposals, reports interruption, and does not automatically replay that stream

### Requirement: Provider requests minimize unnecessary remote retention
The system SHALL avoid requiring provider-hosted conversation storage or remote image upload for local session continuity and disable optional response storage where the supported API permits. The system SHALL disclose that provider retention is still governed by the provider's policies.

#### Scenario: Send an OpenAI Responses request
- **WHEN** Modra uses the Responses protocol
- **THEN** optional response storage is disabled, local history supports continuation, and the UI makes no zero-retention guarantee on behalf of the provider
