/**
 * agent-bridge type definitions
 *
 * Built by Max Harper (AI agent) for agent-to-agent gstack skill invocation.
 * These types define the contract between calling agents and gstack skills.
 */

// ─── Skill Invocation ───

export interface InvokeOptions {
  /** Skill name (e.g., "review", "cso", "qa") */
  skill: string;
  /** Repository path (defaults to cwd) */
  repo?: string;
  /** Git branch to analyze (defaults to current branch) */
  branch?: string;
  /** Output format */
  format?: 'json' | 'markdown';
  /** Timeout in seconds (default: 300) */
  timeout?: number;
  /** Additional skill-specific arguments */
  args?: Record<string, string>;
  /** Skip cache lookup */
  noCache?: boolean;
}

export interface InvokeResult {
  /** Skill that was invoked */
  skill: string;
  /** Overall verdict */
  verdict: 'pass' | 'fail' | 'warn' | 'error';
  /** Numeric score (0-10, skill-dependent) */
  score: number | null;
  /** Structured findings */
  issues: Issue[];
  /** Summary text (1-3 sentences) */
  summary: string;
  /** Execution metadata */
  meta: InvokeMeta;
}

export interface Issue {
  /** Severity level */
  severity: 'critical' | 'warning' | 'info';
  /** File path (if applicable) */
  file?: string;
  /** Line number (if applicable) */
  line?: number;
  /** Issue description */
  message: string;
  /** Skill-specific category (e.g., "security", "performance", "style") */
  category?: string;
  /** Suggested fix (if available) */
  suggestion?: string;
}

export interface InvokeMeta {
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Tokens consumed (input + output) */
  tokensUsed: number;
  /** Estimated cost in USD */
  costUsd: number;
  /** Git commit SHA analyzed */
  commitSha: string;
  /** Repository name */
  repo: string;
  /** Branch analyzed */
  branch: string;
  /** Whether result was served from cache */
  cached: boolean;
  /** ISO timestamp of execution */
  timestamp: string;
  /** Agent identity (who invoked this) */
  invokedBy: string;
}

// ─── Skill Chaining ───

export interface ChainConfig {
  /** Chain name (e.g., "pre-merge-gate") */
  name: string;
  /** Description */
  description?: string;
  /** Ordered list of skill steps */
  steps: ChainStep[];
  /** Stop on first failure (default: true) */
  failFast?: boolean;
}

export interface ChainStep {
  /** Skill to invoke */
  skill: string;
  /** Gate condition — JS expression evaluated against InvokeResult */
  gate?: string;
  /** Skill-specific arguments */
  args?: Record<string, string>;
  /** Override timeout for this step */
  timeout?: number;
}

export interface ChainResult {
  /** Chain name */
  chain: string;
  /** Overall chain verdict */
  verdict: 'pass' | 'fail' | 'error';
  /** Results per step */
  steps: ChainStepResult[];
  /** Total duration across all steps */
  totalDurationMs: number;
  /** Total tokens across all steps */
  totalTokens: number;
  /** Total cost across all steps */
  totalCostUsd: number;
}

export interface ChainStepResult {
  /** Skill name */
  skill: string;
  /** Invocation result */
  result: InvokeResult;
  /** Gate expression (if any) */
  gate?: string;
  /** Whether gate passed */
  gatePassed: boolean;
  /** Whether this step was skipped (due to earlier failure in failFast mode) */
  skipped: boolean;
}

// ─── Webhook ───

export interface WebhookRequest {
  /** Skill or chain to invoke */
  skill?: string;
  chain?: string;
  /** Repository (URL or path) */
  repo: string;
  /** Branch */
  branch?: string;
  /** Callback URL for async results */
  callback?: string;
  /** Additional arguments */
  args?: Record<string, string>;
  /** Requester identity */
  invokedBy?: string;
}

export interface WebhookResponse {
  /** Job ID for async tracking */
  jobId: string;
  /** Status */
  status: 'queued' | 'running' | 'completed' | 'failed';
  /** Result (populated when completed) */
  result?: InvokeResult | ChainResult;
}

// ─── Cache ───

export interface CacheEntry {
  /** Cache key: `{skill}-{repo}-{commitSha}` */
  key: string;
  /** Cached result */
  result: InvokeResult;
  /** When cached */
  cachedAt: string;
  /** TTL in seconds (default: 3600) */
  ttl: number;
}
