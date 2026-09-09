# Code index: semantic retrieval over a project's source

Design for a code ingestion pipeline backed by a vector store, giving the agent
semantic retrieval ("where is the retry budget decided?") alongside the exact
and structural retrieval it already has (ripgrep, `code_map`, supi's LSP tools).

Prompted by [How Cursor Actually Indexes Your Codebase][article]. That article
is Cursor's own published account of its pipeline, not independent
reverse-engineering; what is taken from it here is the *shape* — AST chunking,
content-hash caching, a Merkle tree for freshness, and the split that keeps
plaintext source out of the store — not its vendor choices.

[article]: https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase/

---

## 1. What this is not

Semla already resolves code three ways, and the index must not quietly become a
fourth answer to a question one of them answers better:

- **`code_map`** resolves a real call graph with the TypeScript checker. Every
  edge is a call traced to a declaration. When the question is "what calls
  this", that is the correct tool and this one is strictly worse.
- **supi code-intelligence** answers symbol-level queries over an LSP workspace.
- **ripgrep** answers exact-string questions, and `read-router` already
  compresses its output when it runs long.

The gap none of them fill is the query whose wording does not appear in the
code: *"where do we decide whether a background run is still alive?"* matches
`turn-background-state.ts` and `bg-continuation-registry.ts` on meaning, not on
any shared token. That is the whole remit. The tool description must say so, or
the model will reach for it where grep is faster and exact.

## 2. Pipeline

Six stages, in `src/lib/code-index/`. Each is a separate module with its own
test, per the file-size rule in AGENTS.md.

### 2.1 Enumerate — `enumerate.ts`

Reuse `src/lib/pi/file-walk.ts` (`walkFiles`, `IGNORED_DIRECTORIES`) rather than
walking again. Filter to extensions with a tree-sitter grammar, plus Markdown.
Skip files over a size ceiling and vendored trees; report both counts rather
than dropping them silently — see §5.

### 2.2 Fingerprint — `merkle.ts`

sha256 per file, folded into a directory tree hash bottom-up. The root hash is
the index's identity: equal roots means nothing to do, and a differing root
walks down to exactly the changed subtrees. This is the article's freshness
mechanism and it is the part most worth taking — it applies just as well to the
wiki as to embeddings.

Cheaper than it sounds and the reason re-indexing can be eager: hashing this
repository's 716 indexable files is one pass over 4.3 MB.

### 2.3 Chunk — `chunk.ts`

tree-sitter → AST → walk the nodes, grouping adjacent ones until a token budget
is reached, splitting between declarations rather than inside them. A chunk
carries `path`, `startLine`, `endLine`, the enclosing symbol name where the
grammar gives one, and the sha256 of its exact text.

`@mrclrchtr/supi-tree-sitter` 6.0.0 is already on disk with 15 language
grammars as wasm — currently *nested* under `supi-code-intelligence`. Per the
extension-dependency decision in AGENTS.md it must be declared at the root and
pinned exactly before anything imports it; a nested resolution is precisely the
accident that decision exists to prevent. It is also the package whose
`import.meta.url` grammar loading is the documented reason path-loaded
extensions exist, so it must not be bundled.

Languages without a grammar fall back to a line-window chunker with overlap.
Fallback is recorded per file, not assumed.

### 2.4 Embed — `embed.ts`

**OpenRouter, over its OpenAI-compatible `/api/v1/embeddings`.** Verified
working against the live endpoint on 2026-09-09; it is undocumented in the
`/api/v1/models` listing, which returns 430 chat models and no embedding
models, so the available set was established by probing:

| model | dims |
|---|---|
| `openai/text-embedding-3-small` | 1536 |
| `openai/text-embedding-3-large` | 3072 |
| `google/gemini-embedding-001` | 3072 |
| `qwen/qwen3-embedding-8b` | 4096 |
| `qwen/qwen3-embedding-4b` | 2560 |
| `baai/bge-m3` | 1024 |

No Voyage, so the code-specialised option is not on the table here.

**Default `openai/text-embedding-3-small`.** It is the only strong candidate
that fits under pgvector's HNSW ceiling (§3.2) without a truncation step, and
the cost argument for a larger model is weak at this scale: the whole of this
repository is ~1.2M tokens, so a full index costs **about two and a half
cents**. Model and dimension are overridable.

The credential is the one already in `~/.semla/agent/auth.json` — OpenRouter is
the only provider configured there, and it is what every chat model in the
harness already resolves through. No new vendor, no second key.

Reuse the `Embedder` shape from `@zosmaai/pi-llm-wiki`'s `embeddings.ts`:
an injected `{ model, embed }` so tests mock embedding with no network, and
unit-normalized vectors so a dot product *is* cosine similarity. That package's
`resolveEmbedder` already accepts `openai-compatible` with a `baseUrl`
override, which means the same credential can switch the wiki's own page
embeddings on. Do not invent a second embedding config.

Batched, with a content-hash cache: a chunk whose sha256 is unchanged is never
re-embedded, so an edit to one file costs one file's worth of tokens.

### 2.5 Store — `store/`

A `VectorStore` port with two backends, as agreed:

```ts
export interface VectorStore {
  readonly id: "local" | "pgvector";
  head(project: ProjectKey): Promise<IndexHead | null>;
  upsert(project: ProjectKey, chunks: EmbeddedChunk[]): Promise<void>;
  deleteByPath(project: ProjectKey, paths: string[]): Promise<void>;
  query(project: ProjectKey, vector: Float32Array, k: number): Promise<ScoredChunk[]>;
  drop(project: ProjectKey): Promise<void>;
}
```

One conformance suite runs against both, so the backends cannot drift into
disagreeing about ranking or deletion. The local backend ships first and is
what the tests run against; pgvector is opt-in.

- **`store/local.ts`** — `~/.semla/index/<project-key>/` (the same
  `workflowProjectKey()` slug+hash scheme `workflow-paths.ts` already uses, and
  under a `SEMLA_INDEX_HOME` override for the same reason `PI_WORKFLOW_HOME`
  exists: a test that writes into the operator's real state is a bug this
  repository has already paid for twice). `vectors.bin` as a flat
  `Float32Array`, `chunks.jsonl` as the parallel metadata, `head.json` for the
  Merkle root and model identity. Brute-force dot product over ~2,000 chunks is
  ~3M multiply-adds — sub-millisecond, and no dependency.
- **`store/pgvector.ts`** — a Supabase migration adding `code_chunks`. See §3.2
  for the dimension constraint, which is not optional.

### 2.6 Query — `search.ts` and the `code_search` tool

Embed the query, take top-k, then **read the chunk text off disk at query
time** from `path` + line range. Merge with a ripgrep pass over the same query
terms (`@vscode/ripgrep` is already a dependency, and `review-grep.ts` already
owns the binary path) so exact hits are never lost to a similarity score.

## 3. Decisions

### 3.1 Source text is never stored in the vector store

**Decision.** Rows hold `path`, `startLine`, `endLine`, `symbol`, `hash`, and
the vector. Never the code.

**Why.** Cursor does this for privacy, and that reason mostly does not apply
here — Semla is single-user, loopback-bound, and runs on the host with the real
tree in front of it. The reason that does apply is correctness. A stored copy
of a chunk is a second source of truth that drifts, and a retrieval layer that
confidently returns code which no longer exists in the file it names is exactly
the silent-wrongness this harness is built to refuse. Reading at query time
means a hash mismatch is *detectable*, and detected staleness is reportable.

It also collapses the privacy question rather than answering it. Chunk text
still leaves the machine at embed time — that is unavoidable with a hosted
model, and it is what Cursor does too — but nothing durable accumulates
off-host. Path obfuscation, the article's §3, is therefore not implemented:
it buys nothing once the store is local or in the operator's own Supabase
project, and it would cost the readable `file:line` citations that are the
point of the result format.

### 3.2 Dimension is part of the index identity, and pgvector caps it

**Decision.** `head.json` / the row set records `model` and `dim`. A query whose
embedder disagrees with the stored head **rebuilds**; it must never compare
vectors from two models.

**Why.** Cosine similarity between vectors from different models is not a weak
signal, it is a meaningless one — and it returns confidently ranked garbage with
no error anywhere. That is a silent-degradation failure of exactly the kind the
extension manifest's docblock describes.

**The pgvector constraint.** HNSW indexes `vector` only up to **2000
dimensions**. Of the six models above, only `bge-m3` (1024) and
`text-embedding-3-small` (1536) fit. The others need `halfvec` (HNSW to 4000
dims, `pgvector` ≥ 0.7) or Matryoshka truncation. This is why the default is
1536 — and why the migration must assert the dimension rather than accept
whatever arrives.

### 3.3 Staleness is reported, never silent

**Decision.** Every `code_search` result states the index's age, its Merkle root
agreement with the tree on disk, how many files were skipped and why, and — when
the tree has moved — which of the returned chunks failed their hash check.

**Why.** This is the same contract `code_map` already keeps when it says where
depth or the node cap stopped it. A retrieval tool that cannot be wrong out loud
is one whose answers cannot be trusted quietly.

### 3.4 The tool is always registered, even when the project is not indexed

**Decision.** `code_search` registers unconditionally; when the anchored project
has no index it returns an explanation and the one-line way to build one.

**Why.** `extension-manifest.ts` exists because an extension that fails to load
used to degrade into a session that silently had no tools. A tool that vanishes
based on runtime state reintroduces that failure through a different door: the
model cannot ask for a capability it cannot see, and cannot report its absence.

### 3.5 Opt-in per project

**Decision.** Nothing is indexed until asked. Settings grows an **Index** panel
listing workspace projects with their state (`indexed · 8,412 chunks · 2h ago` /
`not indexed [Index]`), backed by `/api/code-index`.

**Why.** Chosen by the operator. It also matches the gate already on
code-intelligence (`requiresProjectAnchor`), which exists because scanning the
whole workspace root costs 75 seconds against 519 ms for one project — and the
same ratio governs embedding cost and egress.

## 3.6 When ingestion runs, and when it must not

**Decision.** A full ingest runs only from an explicit opt-in, out of band of
any turn. A *freshness check* runs at session start. A *top-up* of the diff runs
at the turn boundary. Nothing embeds on the critical path of a prompt.

**Why.** `extension-manifest.ts` already records the cost of the alternative:
supi's code-intelligence stands up its workspace from a `session_start` handler
at 519 ms for a project and 75 seconds for the workspace root — "paid on every
turn, before the model sees the prompt, and not avoidable by deselecting tools,
because tool selection happens after binding." A full ingest is twenty embedding
round-trips, an order of magnitude worse. Cursor's "index on workspace open"
model is not available to an architecture that binds extensions per turn.

**The four moments.**

| when | what runs | cost |
|---|---|---|
| server boot (`instrumentation.ts`) | reports which projects have an index; walks nothing | none |
| operator opt-in (settings, or a `code_search` on an unindexed project) | **full ingest**, dispatched like `wiki-ingest-bridge` does — background workflow, agent notified on completion | ~20 requests, tens of seconds, ~2.4¢ for this repository |
| session start on an indexed project | enumerate + fingerprint + tree root, compared to `head.merkleRoot`; embeds only the diff if it moved | 36 ms and no network when the root matches |
| `code_search` | embeds the query only; local dot product; chunk text read from disk | ~50 ms |

The session-start check is affordable *because* it is only hashing: 751 files in
36 ms, measured. That is the whole reason `fingerprint.ts` exists as its own
layer rather than as a step inside the ingest.

**The unresolved case: the agent edits the code it is searching.** Semla's agent
writes files, so the index goes stale inside the session that is using it — an
edit at turn 3 invalidates a citation returned at turn 7. Two mechanisms are
needed and they are not alternatives:

- **The hash check is the safety net.** Every hit is verified against the file
  on disk at query time and stale ones are marked, per §3.1 and §3.3. This is
  what makes a mid-turn edit safe rather than silently wrong.
- **The turn-boundary top-up is the convergence.** A `session_shutdown`-style
  hook — `read-router.ts` and `workflow.ts` both already use one — runs the 36 ms
  fingerprint and embeds the diff. A turn that touched three files costs one
  request.

Hooking the `edit`/`write` tools directly would be more current still, and is
rejected for now: it puts embedding latency inside the tool call, which is the
critical path this section exists to keep clear.

## 4. What ships, in order

1. `chunk.ts` + `fingerprint.ts` + `enumerate.ts` with tests — no network, no store.
   Declaring `@mrclrchtr/supi-tree-sitter` at the root is a prerequisite and
   needs an install, which `install-guard` blocks by design.
2. `VectorStore` port, `store/local.ts`, and the shared conformance suite.
3. `embed.ts` against OpenRouter, with a recorded-fixture test and no live call
   in CI.
4. `code_search` + the extension, registered in `EXTENSION_MANIFEST` with
   `requiresProjectAnchor: true`.
5. `/api/code-index` + the settings panel.
6. `store/pgvector.ts` + migration, against the same conformance suite.

Stages 1–3 are decision-complete and independently testable. Stage 6 is the one
that can be deferred without leaving anything half-built.

## 5. Open questions

- **Chunk budget.** 600 tokens is a starting guess, not a measured one. Worth an
  eval once stage 4 lands: the retrieval quality question is whether a chunk
  should be one function or one function plus its imports.
- **Does the wiki's page-level embedding become redundant?** Both would embed
  the same repository through different lenses. They should probably share the
  `Embedder` and the credential, and stay separate stores.
- **Merkle granularity.** Per-file hashing is enough to find changes; the tree
  fold only pays off when the comparison is against a remote. With a local
  store, a flat map of path → hash may be all that is warranted, and the tree is
  ceremony. Decide with a measurement, not from the article.
