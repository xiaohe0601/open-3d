# Modeling Command API Specification

## Purpose

Defines a versioned, renderer-independent contract for inspecting and changing modeling documents so user-interface operations, AI tools, and future automation share the same behavior.

## Requirements

### Requirement: Every user-facing modeling operation has a structured command
The system SHALL expose every committed modeling mutation available in the MVP user interface as a machine-readable command with validated inputs and defined results.

#### Scenario: Discover a user-interface operation
- **WHEN** a caller requests the operation catalog
- **THEN** the catalog includes each enabled modeling mutation available in the user interface with its identifier, parameter schema, selection preconditions, and result shape

#### Scenario: Invoke an operation through the command contract
- **WHEN** a caller submits a supported operation with valid arguments and preconditions
- **THEN** the document-level result matches the equivalent committed user-interface operation

### Requirement: Callers can query current modeling state
The system SHALL expose read-only structured queries for scene hierarchy, object transforms, mesh summaries, active selection, editor mode, and operation eligibility.

#### Scenario: Query current state
- **WHEN** a caller requests supported scene or editor state
- **THEN** the system returns current serializable state without mutating the document

#### Scenario: Query a missing entity
- **WHEN** a caller queries an entity that is absent from the current document
- **THEN** the system returns a structured not-found result without changing the document

### Requirement: Commands validate requests and return stable outcomes
The system SHALL validate command identifiers, contract versions, arguments, and document preconditions before mutation.

#### Scenario: Reject an invalid request
- **WHEN** a caller submits an unknown operation, unsupported contract version, invalid parameter, or unmet precondition
- **THEN** the system returns a machine-readable error with a user-readable explanation and leaves the document unchanged

#### Scenario: Execute a valid request
- **WHEN** a caller submits a supported request that passes validation
- **THEN** the system returns a structured success result identifying affected entities and any resulting selection

### Requirement: Commands are atomic and undoable
The system SHALL apply each committed command or explicitly grouped command sequence atomically and expose it through undo and redo.

#### Scenario: Undo and redo a committed operation
- **WHEN** a caller undoes and redoes a committed command or group
- **THEN** the document returns to the exact prior state and then to the exact committed result

#### Scenario: Roll back a failed command group
- **WHEN** any command in an atomic group fails
- **THEN** the entire group is rolled back and neither document state nor history contains a partial result

### Requirement: The command contract is independent of presentation
The system SHALL allow commands and queries to run without importing or requiring a particular user interface or rendering backend.

#### Scenario: Use the contract without a viewport
- **WHEN** an automated caller invokes a supported command without a viewport
- **THEN** it receives the same document behavior and result shape as an equivalent user-interface action

### Requirement: The operation catalog is versioned
The system SHALL expose a contract version and machine-readable schemas for supported commands and queries.

#### Scenario: Read the catalog version
- **WHEN** a caller requests the catalog
- **THEN** the response identifies the contract version and schemas needed to form valid requests

#### Scenario: Reject an incompatible version before execution
- **WHEN** a request declares an unsupported contract version
- **THEN** the system rejects it before any document mutation
