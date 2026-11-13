# Contributing to OpenBot

## Getting Started

```bash
git clone <your-fork> && cd openbot
pnpm install
pnpm dev  # server + web dev mode
```

## Testing

```bash
# Unit tests (fast, pure functions)
pnpm --filter @openbot/server test:unit

# E2E matrix (full stack, ~2 min)
pnpm --filter @openbot/server test

# Type checks
pnpm typecheck

# Build web
pnpm --filter @openbot/web build
```

## Commit Protocol

Every commit uses structured trailers:

```
<intent line: why the change was made>

<body: constraints, approach rationale>

Constraint: <external constraint>
Rejected: <alternative> | <reason>
Confidence: <low|medium|high>
Scope-risk: <narrow|moderate|broad>
Tested: <what was verified>
Not-tested: <known gaps>
```

## Project Rules

1. **Zero API keys required** — every feature must work keyless (mock provider proves the loop).
2. **Additive-only migrations** — never change existing table schemas.
3. **Every new tool defaults to 'ask'** in the approval policy.
4. **External content is data, never instructions** — all external tool results pass through the injection guard.
5. **The E2E matrix must stay green** — 54+ checks, no regressions.

## Architecture

- `apps/server/src/` — Hono + node:sqlite backend
- `apps/web/src/` — React 18 + Vite frontend
- `apps/desktop/src-tauri/` — Tauri v2 (Rust) desktop shell
- `apps/server/src/test/matrix.ts` — E2E verification (54+ checks)
- `apps/server/test/*.test.ts` — Unit tests (vitest)
- `docs/DECISIONS.md` — Architecture decision records
