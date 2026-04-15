/**
 * Multi-skill pipeline execution for agent-to-agent workflows.
 *
 * Chains multiple gstack skills with gate conditions between them.
 * Stops on first gate failure (configurable).
 *
 * Example chain config (chains/pre-merge-gate.json):
 *   { "name": "pre-merge-gate",
 *     "steps": [
 *       { "skill": "review", "gate": "score >= 7" },
 *       { "skill": "cso",    "gate": "issues.filter(i => i.severity === 'critical').length === 0" },
 *       { "skill": "qa",     "args": { "url": "$STAGING_URL" }, "gate": "verdict !== 'fail'" }
 *     ] }
 *
 * Built by Max Harper (AI agent, OpenClaw).
 */

import { readFileSync } from 'fs';
import { invoke } from './invoke';
import type { ChainConfig, ChainResult, ChainStepResult, InvokeResult } from './types';

/** Evaluate a gate expression against an InvokeResult */
function evaluateGate(gate: string, result: InvokeResult): boolean {
  try {
    // Create a sandboxed evaluation context with result properties
    const { verdict, score, issues, summary } = result;
    const fn = new Function('verdict', 'score', 'issues', 'summary', `return (${gate})`);
    return Boolean(fn(verdict, score, issues, summary));
  } catch (err) {
    console.error(`Gate evaluation failed for "${gate}":`, err);
    return false;
  }
}

/** Resolve environment variables in args (e.g., "$STAGING_URL" → process.env.STAGING_URL) */
function resolveArgs(args: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value.startsWith('$')) {
      const envKey = value.slice(1);
      resolved[key] = process.env[envKey] || value;
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

export async function runChain(config: ChainConfig, repo: string, branch?: string): Promise<ChainResult> {
  const startTime = Date.now();
  const results: ChainStepResult[] = [];
  const failFast = config.failFast !== false; // default true
  let chainFailed = false;

  for (const step of config.steps) {
    // Skip remaining steps if failFast and a previous step failed
    if (chainFailed && failFast) {
      results.push({
        skill: step.skill,
        result: {
          skill: step.skill,
          verdict: 'error',
          score: null,
          issues: [],
          summary: 'Skipped due to previous step failure',
          meta: {
            durationMs: 0,
            tokensUsed: 0,
            costUsd: 0,
            commitSha: '',
            repo: '',
            branch: '',
            cached: false,
            timestamp: new Date().toISOString(),
            invokedBy: process.env.GSTACK_AGENT_ID || 'unknown',
          },
        },
        gate: step.gate,
        gatePassed: false,
        skipped: true,
      });
      continue;
    }

    // Run the skill
    const args = step.args ? resolveArgs(step.args) : {};
    const result = await invoke({
      skill: step.skill,
      repo,
      branch,
      format: 'json',
      timeout: step.timeout,
      args,
    });

    // Evaluate gate
    let gatePassed = true;
    if (step.gate) {
      gatePassed = evaluateGate(step.gate, result);
      if (!gatePassed) {
        chainFailed = true;
      }
    }

    // Error verdict also fails the chain
    if (result.verdict === 'error' || result.verdict === 'fail') {
      chainFailed = true;
    }

    results.push({
      skill: step.skill,
      result,
      gate: step.gate,
      gatePassed,
      skipped: false,
    });
  }

  const totalDurationMs = Date.now() - startTime;

  return {
    chain: config.name,
    verdict: chainFailed ? 'fail' : 'pass',
    steps: results,
    totalDurationMs,
    totalTokens: results.reduce((sum, r) => sum + (r.result.meta?.tokensUsed || 0), 0),
    totalCostUsd: results.reduce((sum, r) => sum + (r.result.meta?.costUsd || 0), 0),
  };
}

/** Load a chain config from a JSON file */
export function loadChainConfig(path: string): ChainConfig {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as ChainConfig;
}
