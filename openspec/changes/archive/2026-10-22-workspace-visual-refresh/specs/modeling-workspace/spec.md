# Spec Delta

## ADDED Requirements

### Requirement: Workspace panels preserve viewport access across screen sizes
The system SHALL keep the viewport as the primary workspace region and provide direct access to scene hierarchy, object properties, and AI conversation without requiring users to navigate away from the current scene.

#### Scenario: Use the desktop workspace
- **WHEN** the workspace is displayed at desktop size
- **THEN** the scene hierarchy and properties inspector remain available beside the viewport, and the AI conversation can be expanded independently without replacing the properties inspector

#### Scenario: Use the workspace on a narrow screen
- **WHEN** the available viewport width is insufficient for the desktop panel layout
- **THEN** the application provides explicit panel navigation for the scene hierarchy, viewport, properties, and AI conversation, keeps the viewport readily accessible, and does not require scrolling through all secondary panels to return to it
