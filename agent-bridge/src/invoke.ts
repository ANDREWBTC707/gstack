/**
 * Headless skill invocation for agent-to-agent workflows.
 *
 * Runs a gstack skill outside of an interactive Claude Code session,
 * returning structured JSON results that other agents can consume.
 *
 * Usage:
 *   gstack-invoke --skill review --repo . --format json
 *   gstack-invoke --skill cso --repo /path/to/repo --branch main
 *
 * Built by Max Harper (AI agent, OpenClaw).
 */

import { execSync, type ExecSyncOptions } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import type { InvokeOptions, InvokeResult, Issue, InvokeMeta } from './types';
import { getCached, setCache } from './cache';

const DEFAULT_TIMEOUT = 300; // seconds

/** Resolve the gstack skill directory */
function findSkillDir(skill: string): string | null {
  const candidates = [
    join(process.env.HOME || '~', '.claude', 'skills', 'gstack', skill),
    join(process.env.HOME || '~', '.openclaw', 'skills', 'gstack', skill),
    join(process.cwd(), skill),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

/** Get current git commit SHA */
function getCommitSha(repo: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Get current git branch */
function getCurrentBranch(repo: string): string {
  try {
    return execSync('git branch --show-current', { cwd: repo, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Parse structured results from skill output */
function parseSkillOutput(raw: string, skill: string): Pick<InvokeResult, 'verdict' | 'score' | 'issues' | 'summary'> {
  const issues: Issue[] = [];
  let score: number | null = null;
  let verdict: InvokeResult['verdict'] = 'pass';
  const lines = raw.split('\n');

  // Extract issues from common patterns
  for (const line of lines) {
    // Pattern: [CRITICAL] file.ts:42 — message
    const critMatch = line.match(/\[CRITICAL\]\s*([^:]+):(\d+)\s*[—-]\s*(.+)/i);
    if (critMatch) {
      issues.push({ severity: 'critical', file: critMatch[1], line: parseInt(critMatch[2]), message: critMatch[3].trim() });
      continue;
    }

    // Pattern: [WARNING] file.ts:42 — message
    const warnMatch = line.match(/\[WARNING\]\s*([^:]+):(\d+)\s*[—-]\s*(.+)/i);
    if (warnMatch) {
      issues.push({ severity: 'warning', file: warnMatch[1], line: parseInt(warnMatch[2]), message: warnMatch[3].trim() });
      continue;
    }

    // Pattern: Score: 8.5/10 or score: 8.5
    const scoreMatch = line.match(/score[:\s]+(\d+(?:\.\d+)?)\s*(?:\/\s*10)?/i);
    if (scoreMatch) {
      score = parseFloat(scoreMatch[1]);
    }

    // Pattern: Verdict: APPROVE / REJECT / WARN
    const verdictMatch = line.match(/verdict[:\s]+(approve|pass|reject|fail|warn)/i);
    if (verdictMatch) {
      const v = verdictMatch[1].toLowerCase();
      verdict = v === 'approve' ? 'pass' : v === 'reject' ? 'fail' : v as InvokeResult['verdict'];
    }
  }

  // Derive verdict from issues if not explicitly stated
  if (issues.some(i => i.severity === 'critical')) verdict = 'fail';
  else if (issues.some(i => i.severity === 'warning') && verdict === 'pass') verdict = 'warn';

  // Generate summary from first few lines or issues
  const summary = issues.length > 0
    ? `${issues.length} issue(s) found: ${issues.filter(i => i.severity === 'critical').length} critical, ${issues.filter(i => i.severity === 'warning').length} warnings`
    : raw.split('\n').filter(l => l.trim()).slice(0, 3).join(' ').slice(0, 200);

  return { verdict, score, issues, summary };
}

export async function invoke(options: InvokeOptions): Promise<InvokeResult> {
  const {
    skill,
    repo = process.cwd(),
    branch,
    format = 'json',
    timeout = DEFAULT_TIMEOUT,
    args = {},
    noCache = false,
  } = options;

  const startTime = Date.now();
  const commitSha = getCommitSha(repo);
  const currentBranch = branch || getCurrentBranch(repo);
  const repoName = basename(repo);

  // Check cache
  if (!noCache) {
    const cached = getCached(skill, repoName, commitSha);
    if (cached) {
      return {
        ...cached,
        meta: {
          ...cached.meta,
          cached: true,
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  // Find skill
  const skillDir = findSkillDir(skill);
  if (!skillDir) {
    return {
      skill,
      verdict: 'error',
      score: null,
      issues: [{ severity: 'critical', message: `Skill '${skill}' not found` }],
      summary: `Skill '${skill}' not found in any skill directory`,
      meta: {
        durationMs: Date.now() - startTime,
        tokensUsed: 0,
        costUsd: 0,
        commitSha,
        repo: repoName,
        branch: currentBranch,
        cached: false,
        timestamp: new Date().toISOString(),
        invokedBy: process.env.GSTACK_AGENT_ID || 'unknown',
      },
    };
  }

  // Build the claude command
  // Use `claude -p` for non-interactive (print mode) with the skill's SKILL.md as context
  const skillMd = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
  const prompt = [
    `You are running the /${skill} skill in headless agent-to-agent mode.`,
    `Repository: ${repo}`,
    `Branch: ${currentBranch}`,
    `Commit: ${commitSha}`,
    Object.keys(args).length > 0 ? `Additional args: ${JSON.stringify(args)}` : '',
    '',
    'Execute the skill and output your findings.',
    'At the end, output a structured summary line:',
    'VERDICT: pass|fail|warn',
    'SCORE: N/10',
    '',
    '--- SKILL.md ---',
    skillMd,
  ].filter(Boolean).join('\n');

  let raw = '';
  try {
    const execOptions: ExecSyncOptions = {
      cwd: repo,
      timeout: timeout * 1000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: {
        ...process.env,
        GSTACK_HEADLESS: '1',
        GSTACK_FORMAT: format,
      },
    };

    // Write prompt to temp file and pipe to claude
    const tmpFile = `/tmp/gstack-invoke-${process.pid}-${Date.now()}.txt`;
    const { writeFileSync: writeTmp, unlinkSync: rmTmp } = require('fs');
    writeTmp(tmpFile, prompt);

    try {
      raw = execSync(
        `claude -p --output-format text < "${tmpFile}"`,
        execOptions
      ) as string;
    } finally {
      try { rmTmp(tmpFile); } catch { /* ignore */ }
    }
  } catch (err: any) {
    return {
      skill,
      verdict: 'error',
      score: null,
      issues: [{ severity: 'critical', message: err.message?.slice(0, 500) || 'Execution failed' }],
      summary: `Skill '${skill}' execution failed: ${err.message?.slice(0, 200) || 'unknown error'}`,
      meta: {
        durationMs: Date.now() - startTime,
        tokensUsed: 0,
        costUsd: 0,
        commitSha,
        repo: repoName,
        branch: currentBranch,
        cached: false,
        timestamp: new Date().toISOString(),
        invokedBy: process.env.GSTACK_AGENT_ID || 'unknown',
      },
    };
  }

  const parsed = parseSkillOutput(raw, skill);
  const durationMs = Date.now() - startTime;

  const result: InvokeResult = {
    skill,
    ...parsed,
    meta: {
      durationMs,
      tokensUsed: 0, // TODO: parse from claude output when available
      costUsd: 0,
      commitSha,
      repo: repoName,
      branch: currentBranch,
      cached: false,
      timestamp: new Date().toISOString(),
      invokedBy: process.env.GSTACK_AGENT_ID || 'unknown',
    },
  };

  // Cache the result
  if (!noCache && result.verdict !== 'error') {
    setCache(skill, repoName, commitSha, result);
  }

  return result;
}
