## Context

OpenBot already has a general web-search tool, a purpose-driven `리서처 봇` template, a SQLite FTS5 knowledge layer, workspace/file viewing, tool approval/audit/checkpoint infrastructure, and a deterministic E2E matrix. What it lacks is a research-specific evidence path: the researcher cannot query scholarly sources directly, cannot consistently use a hypothesis→experiment→conclusion workflow, and cannot turn a completed investigation into a reusable Markdown research artifact.

This change adds those capabilities without adding API-key or embedding dependencies: arXiv and PubMed use public APIs, reports remain local workspace artifacts, and scholarly abstracts are treated as untrusted external data before reaching the model.

## Recommended implementation

### 1. Add a typed scholarly-research adapter
**New:** `apps/server/src/tools/research.ts`

Define narrow internal types rather than passing raw Atom/XML around:
- `ResearchPaper`: source (`arxiv`/`pubmed`), canonical ID, title, authors, abstract, published date, canonical URL, optional PDF URL/categories/journal/DOI.
- Bounded search input: query and `maxResults` (validate 1–20).
- Structured report input: research question, literature evidence, hypothesis, experiment design, findings, conclusion, and references.

Implement:
- `arxiv.search` backed by the public arXiv Atom API, with `OPENBOT_ARXIV_API_BASE` as a test override.
- `pubmed.search` backed by NCBI E-utilities search/fetch endpoints, with `OPENBOT_PUBMED_API_BASE` as a test override.
- Atom/XML parsing with local, bounded extractors (no new XML dependency), normalized text, 15-second network timeouts, explicit result caps, and canonical source URLs.
- `research.report`, which writes a predictable Markdown research artifact under the assigned bot’s workspace (`research/<timestamp>-<slug>.md`), returns the path and artifact metadata, and indexes the text through the existing `indexDocument` knowledge utility so later questions can recall it.

The report Markdown will use stable sections: Research Question, Literature Review, Hypothesis, Experiment Design, Findings, Conclusion, and References. It will not invent citations; sources must be passed explicitly by the agent.

### 2. Register the tools and preserve the existing safety model
**Modify:** `apps/server/src/agent/loop.ts`, `apps/server/src/injection.ts`, `apps/server/src/db.ts`

- Import the research tool module with the other static tool registrations.
- Extend the external-content boundary list to include `arxiv.` and `pubmed.` so papers/abstracts receive the existing `_contentBoundary` and injection-flagging behavior before being returned to a model.
- Register `arxiv.search` and `pubmed.search` as read-only `allow` tools.
- Register `research.report` as `ask`, because it writes an artifact; it will therefore use the existing approval queue, audit trail, and workspace confinement automatically.
- Reuse `safeWorkspacePath`, `workspaceFor`, `ensureWorkspace`, and existing knowledge indexing rather than adding a parallel artifact store.

### 3. Upgrade the Researcher template into an explicit research workflow
**Modify:** `apps/server/src/bot-templates.ts`

Replace the generic researcher persona with an OpenResearch-inspired five-stage procedure:
1. Search current literature using `arxiv.search`, `pubmed.search`, and `search.web` when appropriate.
2. Separate established evidence from unknowns and formulate a falsifiable hypothesis.
3. Propose an experiment or analysis plan; use `fs`/`terminal` only when data or code exists.
4. Interpret results with limitations, not overstated claims.
5. Generate `research.report` with traceable references.

Update the template’s first prompt to demonstrate scholarly research rather than generic web search. Keep its safe policy preset.

### 4. Make research artifacts discoverable through existing surfaces
**Modify:** representative frontend/API wiring only if the existing Files view needs metadata support; otherwise reuse current workspace browsing.

- Ensure a completed `research.report` can be opened in the existing Files workspace view without a new separate viewer.
- Make indexed report content appear through the existing knowledge context and global search path.
- Do not add a new research page in this increment: the user’s immediate value comes from the Researcher template plus Files and knowledge search, keeping the initial surface small.

### 5. Add deterministic fixtures and matrix coverage
**Modify:** `apps/server/src/test/fixtures.ts`, `apps/server/src/test/matrix.ts`, and mock-provider trigger rules only as needed.

Extend the fixture host with deterministic stand-ins for:
- arXiv Atom feed responses,
- PubMed ESearch/EFetch responses,
- fixture-model tool-call triggers for arXiv/PubMed/research-report requests.

Add behavior-focused checks:
- arXiv search returns normalized paper metadata and canonical arXiv/PDF links.
- PubMed search performs the two-step search/fetch flow and returns PMID/title/abstract/authors metadata.
- Scholarly results receive the existing external-content boundary / injection protection.
- Researcher template exposes the five-stage workflow text.
- `research.report` is approval-gated, writes a Markdown file inside the bot workspace, contains all required sections, and becomes searchable knowledge.

Public APIs will be validated separately from fixtures; fixture tests remain reliable if arXiv or PubMed rate-limit the host.

### 6. Verify with actual user-visible paths
Run:
- Server TypeScript typecheck and web build.
- Entire E2E matrix, preserving the current baseline and reporting any external-web flake separately.
- Live public arXiv and PubMed requests using a stable query (for example `large language model agents`), checking paper titles, abstracts, authors, and source links.
- Live Researcher-template run against the local Ollama model: create the template, issue a research question, approve `research.report` if requested, then open the generated report from the existing Files workspace view and confirm its sections and indexed recall.

### 7. Document the contract
**Modify:** `README.md`, `docs/API.md`, and `docs/DECISIONS.md`

Document the keyless public APIs, research workflow stages, report artifact location, approval behavior, FTS knowledge indexing, public-API rate-limit caveat, and why scholarly content is treated as untrusted external data.

## Critical files

- New: `apps/server/src/tools/research.ts`
- Core integration: `apps/server/src/agent/loop.ts`, `apps/server/src/injection.ts`, `apps/server/src/db.ts`, `apps/server/src/bot-templates.ts`
- Reused infrastructure: `apps/server/src/knowledge.ts`, `apps/server/src/tools/gateway.ts`, `apps/server/src/computers/index.ts`, `apps/server/src/tools/core.ts`
- Verification: `apps/server/src/test/fixtures.ts`, `apps/server/src/test/matrix.ts`
- Documentation: `README.md`, `docs/API.md`, `docs/DECISIONS.md`

## Success criteria

1. A user can create the Researcher template and ask for latest literature with no API key.
2. The bot can query arXiv and PubMed, return usable metadata, formulate an evidence-grounded hypothesis/experiment sequence, and create a local Markdown report after approval.
3. The report is visible through existing Files/knowledge surfaces and searchable later.
4. External paper content cannot act as instructions.
5. Full matrix and actual public API paths demonstrate the behavior.