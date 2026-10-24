# AI Gateway Spec Delta

## Purpose

Provides an optional restricted streaming relay that makes supported AI endpoints usable without browser CORS support, with explicit routing consent and the same deployable application for official and self-hosted operation.

## ADDED Requirements

### Requirement: Users explicitly choose their connection route
The system SHALL offer Direct, Open 3D gateway, and Self-hosted gateway independently of provider protocol. Direct SHALL be the default. Self-hosted mode SHALL accept a gateway URL and optional separate access token. The actual route SHALL be visible before requests are sent.

#### Scenario: Direct request fails because of CORS
- **WHEN** a Direct request fails with a network or possible CORS error
- **THEN** Modra explains the available gateway choices but does not silently resend via either gateway

#### Scenario: Official deployment is not configured
- **WHEN** the application has no configured official gateway endpoint
- **THEN** Open 3D gateway is visibly unavailable and cannot silently resolve to Direct or an invented endpoint

#### Scenario: Switch away from a saved gateway
- **WHEN** a user explicitly selects Direct
- **THEN** later AI traffic does not contact the previous gateway or include its access token

### Requirement: Gateway privacy is disclosed accurately
The system SHALL disclose that gateway routing passes credentials, messages, images, and transmitted scene context through the selected intermediary. Official operation SHALL NOT persist, cache, analyze for content, or train on these payloads. Necessary transient forwarding and infrastructure metadata SHALL be distinguished from content retention.

#### Scenario: Select the Open 3D gateway
- **WHEN** the user selects official routing
- **THEN** a visible notice explains content transit and Open 3D's no-content-persistence/analysis policy without guaranteeing the AI provider's or infrastructure platform's retention practices

#### Scenario: Select a self-hosted gateway
- **WHEN** the user selects self-hosted routing
- **THEN** a visible notice states that the user must verify the gateway operator, configuration, and data security and that Open 3D cannot guarantee them

### Requirement: The gateway is independently deployable
The system SHALL provide a Cloudflare Workers application at apps/ai-gateway that can be deployed independently from the web application using the same source for official and clone-based deployments. Deployment SHALL not require placing an upstream AI API key in the repository or web build.

#### Scenario: Deploy from a clone
- **WHEN** a user follows the documented deployment procedure with their own Cloudflare account and configuration
- **THEN** they can deploy a compatible relay and configure its address in Modra without operating an Open 3D backend account

### Requirement: Supported native operations accept custom public providers
The gateway SHALL use ALLOWED_ORIGINS as its only configurable allowlist. Both modes SHALL permit compatible custom public HTTPS providers on port 443, while restricting native operations, path segment syntax, method and query. URL credentials, local names, IP literals, traversal, ambiguous encoding, unsupported operations and redirects SHALL be rejected before credential-bearing dispatch. Documentation SHALL not claim DNS-rebinding prevention from hostname text checks alone.

#### Scenario: Request a custom public provider
- **WHEN** an authorized request from an allowed origin targets a valid custom HTTPS native-operation endpoint
- **THEN** the gateway forwards it without requiring the operator to register that host

#### Scenario: Upstream redirects elsewhere
- **WHEN** a provider returns a redirect
- **THEN** the gateway does not follow it or forward credentials to its location

#### Scenario: Invalid native-operation URL
- **WHEN** a request contains traversal, ambiguous encoding or an unsupported operation
- **THEN** the gateway rejects it before dispatch

### Requirement: Interactive deployment supports both operator modes
The repository SHALL provide a root deployment command usable after cloning. It SHALL prompt for mode, Cloudflare account, allowed origins and endpoint, confirm before cloud mutation, and preserve required bindings/migrations. Official mode SHALL provision real Turnstile sitekey/secret values, upload private credentials through stdin and print public web-build variables. Self-hosted mode SHALL offer explicit no-token mode or manually entered/securely generated tokens and print Modra connection instructions. Config files SHALL contain no secrets. Failed enablement or verification SHALL attempt to disable forwarding and report a failed rollback explicitly.

#### Scenario: Explicit token-free self-hosting
- **WHEN** the operator disables token authentication
- **THEN** capabilities report auth none, clients omit gateway tokens, and origin/rate/concurrency safety remains enforced with a clear public-relay abuse warning

#### Scenario: Secret provisioning fails
- **WHEN** secret upload fails after disabled deployment
- **THEN** the CLI stops without enabling relay or reporting success

### Requirement: Relay operation preserves streaming and cancellation
The gateway SHALL forward supported protocol bodies and stream responses without waiting for the full payload, translating protocols, executing tools, or adding retry layers. It SHALL preserve actionable upstream statuses and bounded retry metadata, disable caching, and propagate client cancellation where supported.

#### Scenario: Stream a long multimodal response
- **WHEN** an authorized request within configured limits includes multiple images and produces SSE output
- **THEN** output reaches the browser incrementally without full-body JSON parsing, unnecessary payload copies, or response caching

#### Scenario: User cancels generation
- **WHEN** the downstream request is cancelled
- **THEN** the gateway cancels upstream work where supported and does not continue it as detached background work

### Requirement: Gateway access is protected independently of CORS
The gateway SHALL validate allowed browser origins and preflight headers and enforce access control and bounded rate/concurrency protections. Origin checks alone SHALL NOT authorize relay access. Official routing SHALL use short-lived validated access grants; self-hosted deployments SHALL support a separate deployment access token. Missing required protection SHALL fail closed.

#### Scenario: Non-browser caller spoofs Origin
- **WHEN** a relay request supplies an allowed Origin without a valid access grant or configured deployment credential
- **THEN** forwarding is denied

#### Scenario: Caller exceeds configured limits
- **WHEN** an authorized caller exceeds rate, concurrent-stream, size, or duration limits
- **THEN** the gateway rejects or terminates the request with a classified error without leaking credentials or logging payload content

### Requirement: Concurrent-stream admission is coordinated across Worker instances
The gateway SHALL use a bound Durable Object namespace to atomically reserve per-derived-caller stream leases before upstream dispatch, separately from approximate edge rate limiting. Grant renewal within an identity epoch SHALL retain the admission bucket. Missing or unavailable coordination SHALL fail closed. Deployment documentation SHALL disclose metadata retention, costs, and protection limits rather than promise a global spending cap or unlimited free hosting.

#### Scenario: Concurrent requests arrive at different Worker instances
- **WHEN** requests for the same derived caller arrive concurrently through separate Worker instances
- **THEN** they share atomic admission state and only requests within the caller's configured lease limit reach the upstream

#### Scenario: Renew an official access grant
- **WHEN** a caller obtains another grant within the same identity epoch
- **THEN** its existing leases still count toward admission instead of being bypassed by the new token

#### Scenario: A stream terminates or a Worker disappears
- **WHEN** a request completes, errors, disconnects, or its Worker fails before release
- **THEN** its lease is released idempotently or expires after the bounded relay duration plus documented cleanup grace, with restart-safe expiration and no indefinitely occupied slot

#### Scenario: Admission infrastructure is unavailable
- **WHEN** required bindings are absent or the admission coordinator cannot be reached
- **THEN** relay dispatch is denied with a classified error and does not fall back to unbounded isolate-local admission

#### Scenario: Inspect admission metadata and deployment costs
- **WHEN** an operator configures or audits admission protection
- **THEN** documentation identifies the Durable Object binding/migration, minimized expiring security metadata, NAT and identity-epoch limitations, and quota/request/storage costs without promising unlimited free operation or persisting AI content

### Requirement: Admission identity is server-derived and credential-independent
The gateway SHALL derive caller identity from trusted platform client-IP metadata and application origin using a deployment-secret HMAC and documented identity epoch. It SHALL NOT use provider credentials, client-chosen identity headers, or random grant IDs. Official grants SHALL bind this identity and be revalidated on relay use; self-hosted token auth SHALL use the same derivation. Identity SHALL NOT be presented as a stable person or account.

#### Scenario: Spoof an admission identity
- **WHEN** a caller supplies a custom identity header or changes its grant ID
- **THEN** only the server-derived caller bucket governs admission, not the supplied value

#### Scenario: Rotate identity or share a network
- **WHEN** callers change IP/identity epoch or share a NAT address for the same origin
- **THEN** documentation explains that rotation can create a new bucket and shared addresses share limits, without treating this abuse control as reliable person identification

### Requirement: Relay deadlines distinguish progressing uploads from model latency
Generated Worker configuration SHALL enable incoming request cancellation signals. Relay watchdogs SHALL distinguish upload inactivity, response start, stream inactivity and total duration. Only nonempty bytes SHALL refresh progress deadlines. Response headers SHALL NOT count as model output or repeatedly extend the response-start deadline. Total duration SHALL bound every phase.

#### Scenario: A large upload continues making progress
- **WHEN** upload bytes continue within the configured upload idle threshold for longer than the response-start threshold
- **THEN** forwarding continues within the total bound and the response-start deadline begins only at upload EOF or early upstream headers

#### Scenario: A client cancels before response headers
- **WHEN** the incoming request abort signal fires before upstream response headers
- **THEN** the upstream operation is aborted, admission is released and no retry or detached generation is started

### Requirement: Generated deployments include aggregate forwarding guards
Generated configuration SHALL enable deployment-wide concurrent leases and a UTC-day admitted-relay counter coordinated independently of caller identity. Older configurations without both settings MAY retain caller-only behavior; partial or invalid configuration SHALL fail closed. Daily quota errors SHALL NOT trigger automatic connection retries. These guards SHALL NOT be advertised as monetary or total platform-request caps.

#### Scenario: A caller rotates its IP or origin
- **WHEN** a deployment concurrency or daily-forwarding limit has been reached
- **THEN** further callers remain subject to that same deployment budget before upstream dispatch

#### Scenario: A task completes or the deployment restarts
- **WHEN** a relay completes, is cancelled, fails or its Worker restarts
- **THEN** concurrent leases release or expire while admitted attempts remain counted until the UTC-day boundary, without storing AI payloads

#### Scenario: A UTC boundary occurs during a stream
- **WHEN** the day counter resets while a stream is still active
- **THEN** the live lease remains enforced and new requests use the new day's counter

### Requirement: Sensitive headers and errors are bounded
The gateway SHALL forward only required provider headers and SHALL NOT forward gateway credentials, browser cookies, or internal control headers upstream. Responses SHALL expose required streaming and retry headers through CORS but SHALL NOT expose cookies, credentials, or internal stack traces.

#### Scenario: Relay an Anthropic or Gemini request
- **WHEN** a request needs provider-specific authentication or version headers
- **THEN** those allowed headers reach the correct target while the gateway's own authorization material does not

### Requirement: Gateway compatibility and operation are inspectable without content logging
The gateway SHALL expose a versioned compatibility/health response and document deployment limits, privacy-related platform configuration, secret management, and failure behavior. The web application SHALL reject incompatible gateways before sending AI credentials or payloads. Diagnostics SHALL exclude credentials, bodies, model output, and secret-bearing URLs.

#### Scenario: Configure an incompatible self-hosted service
- **WHEN** a capability check reports an unsupported gateway contract
- **THEN** Modra reports incompatibility and does not submit AI requests to it

#### Scenario: Review production diagnostics
- **WHEN** an operator inspects configured application logs or error reporting
- **THEN** no request content or credentials are recorded and any retained operational metadata is documented separately
