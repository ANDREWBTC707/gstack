# agent-bridge — Agent-to-Agent Orchestration Layer

> Built by Max Harper (AI agent, OpenClaw) for inter-agent skill invocation.
> Humans use gstack via `/slash-commands`. Agents use it via `agent-bridge`.

## The Problem

gstack skills are designed for interactive Claude Code sessions — a human types
`/review` and Claude runs it. But in a multi-agent fleet (OpenClaw, n8n, moltbots),
agents need to call skills programmatically:

- A CTO agent needs to run `/review` on a PR and get structured results
- A moltbot needs to run `/cso` security audit before deploying
- An orchestrator needs to chain `/review` → `/cso` → `/qa` as a pre-merge gate
- Results need to be machine-parseable, not Markdown prose

## What This Adds

### 1. `gstack-invoke` — Headless Skill Execution

```bash
# Run a skill without an interactive Claude session
gstack-invoke --skill review \
  --repo /path/to/repo \
  --branch feature-x \
  --format json \
  --timeout 120

# Output: structured JSON, not Markdown
{
  "skill": "review",
  "verdict": "approve",
  "score": 8.5,
  "issues": [...],
  "duration_ms": 34200,
  "tokens_used": 4200
}
```

### 2. `gstack-chain` — Multi-Skill Pipelines

```bash
# Run a pre-merge gate: review → security → QA
gstack-chain --config chains/pre-merge-gate.json \
  --repo /path/to/repo \
  --branch feature-x

# Stops on first gate failure, returns aggregate results
```

### 3. Webhook Endpoint for Fleet Integration

```bash
# Any agent POSTs to trigger a skill
curl -X POST http://localhost:34568/hooks/gstack \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"skill": "review", "repo": "maira-demo", "branch": "main"}'
```

### 4. Result Caching

Content-addressed cache at `~/.gstack/cache/`. Same skill + same commit SHA = cached result. Saves tokens and time for agent-to-agent workflows where multiple agents might query the same analysis.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  AI Agent Fleet (OpenClaw, n8n, moltbots)           │
│                                                     │
│  Agent A ──┐                                        │
│  Agent B ──┼── POST /hooks/gstack ──┐               │
│  Agent C ──┘    or gstack-invoke    │               │
│                                     ▼               │
│  ┌─────────────────────────────────────────────┐    │
│  │  agent-bridge                               │    │
│  │  ├── invoke.ts    (headless skill runner)   │    │
│  │  ├── chain.ts     (multi-skill pipeline)    │    │
│  │  ├── hooks.ts     (webhook endpoint)        │    │
│  │  ├── cache.ts     (content-addressed cache) │    │
│  │  └── types.ts     (shared interfaces)       │    │
│  └──────────────────────┬──────────────────────┘    │
│                         │                           │
│                         ▼                           │
│  ┌─────────────────────────────────────────────┐    │
│  │  gstack skills (existing, unchanged)        │    │
│  │  /review, /cso, /qa, /ship, etc.           │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## Usage with OpenClaw

```typescript
// An OpenClaw agent calling gstack skills
const result = await exec('gstack-invoke --skill review --repo . --format json');
const parsed = JSON.parse(result.stdout);

if (parsed.verdict === 'approve' && parsed.score >= 7) {
  await exec('gh pr review --approve');
} else {
  await exec(`gh pr review --request-changes --body "${parsed.issues.map(i => i.message).join('\n')}"`);
}
```

## Usage with n8n

The webhook endpoint integrates directly with n8n's HTTP Request node:
1. n8n workflow triggers on PR creation
2. HTTP Request node POSTs to `/hooks/gstack` with skill + repo + branch
3. Response contains structured results
4. n8n routes based on verdict (approve, request changes, alert)
