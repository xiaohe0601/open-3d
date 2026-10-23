# Spec Delta

## Purpose

Provides an in-product natural-language modeling conversation while keeping service configuration, transmitted scene context, and document mutations under user control.

## ADDED Requirements

### Requirement: Users configure a supported AI service
The system SHALL let users configure a supported protocol, endpoint URL, model, and API credential without requiring a first-party AI account or service.

#### Scenario: Save a valid configuration
- **WHEN** a user enters a complete supported configuration and saves or tests it
- **THEN** the system validates required fields and makes the configuration available for subsequent requests

#### Scenario: Reject an incomplete configuration
- **WHEN** a required setting is missing or malformed
- **THEN** the system identifies the invalid setting and sends no modeling request

### Requirement: Users can converse with AI in the modeling workspace
The system SHALL provide a built-in conversation interface for submitting natural-language modeling requests and viewing assistant responses and request status.

#### Scenario: Submit a modeling request
- **WHEN** a user submits a request with a usable provider configuration
- **THEN** the conversation displays the user request, assistant response, and any proposed modeling actions in their request order

#### Scenario: Recover from an unavailable configuration
- **WHEN** a user submits a request without a usable provider configuration
- **THEN** the system directs the user to provider settings and does not send a request

### Requirement: AI tools are limited to the modeling command and query catalog
The system SHALL expose only registered, schema-defined commands and bounded queries to the AI service.

#### Scenario: AI inspects scene context
- **WHEN** the assistant requests scene or selection information
- **THEN** the system returns only data allowed by the registered queries and requested context scope

#### Scenario: AI proposes an unregistered operation
- **WHEN** an assistant response requests an operation absent from the active command catalog
- **THEN** the system rejects the operation and leaves the project unchanged

### Requirement: Users review proposed modeling changes
The system SHALL validate AI-proposed commands and present their ordered effects before applying any document mutation.

#### Scenario: Complete a multi-step modeling request
- **WHEN** a modeling request requires multiple queries or commands
- **THEN** the assistant continues tool calls against the evolving proposal state, the viewport displays the in-progress proposed scene, and no changes enter the project history until the user explicitly accepts the completed proposal

#### Scenario: Review a valid proposal
- **WHEN** the assistant proposes registered commands with valid arguments and current preconditions
- **THEN** the system presents an understandable summary and allows the user to accept or reject it

#### Scenario: Reject an invalid proposal
- **WHEN** any proposed command has invalid arguments or unmet preconditions
- **THEN** the system rejects the proposal without partial mutation and explains the blocking condition

#### Scenario: Accept a proposal
- **WHEN** the user explicitly confirms a valid proposal
- **THEN** the system executes it through the shared command contract as one atomic undoable group

#### Scenario: Undo an accepted proposal
- **WHEN** the user undoes an accepted proposal
- **THEN** all document changes from that proposal are reverted as one history action

### Requirement: Users control request lifecycle
The system SHALL show request progress and allow cancellation before proposed commands are accepted.

#### Scenario: Cancel a pending request
- **WHEN** the user cancels an in-flight request
- **THEN** the system stops processing where supported, marks the request cancelled, and applies no unconfirmed changes

### Requirement: Users are informed about external data transmission
The system SHALL identify the configured endpoint and disclose that prompts and any scene context used for a request are sent to that endpoint.

#### Scenario: Send scene context to the configured service
- **WHEN** a request includes scene or selection context
- **THEN** the system sends only the context required by registered queries to the user-configured endpoint and exposes the destination in settings

### Requirement: AI failures do not corrupt projects
The system SHALL report network, CORS, authentication, provider, protocol, and tool-validation errors without mutating the project.

#### Scenario: Provider or network failure
- **WHEN** a request fails or returns an incompatible response
- **THEN** the system presents an actionable error, preserves the conversation context where possible, and leaves the document unchanged

### Requirement: Users can remove locally stored credentials
The system SHALL disclose that browser-stored credentials are not protected from page execution and SHALL let users remove them.

#### Scenario: Remove a credential
- **WHEN** a user removes a saved credential
- **THEN** the system deletes the local value and does not include it in later requests
