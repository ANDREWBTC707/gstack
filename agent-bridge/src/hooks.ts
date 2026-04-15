/**
 * Webhook endpoint for fleet integration.
 *
 * Any agent in the fleet can POST to /hooks/gstack to trigger a skill.
 * Supports async execution with callback URLs.
 *
 * Start: gstack-hooks --port 34568 --token $GSTACK_HOOK_TOKEN
 *
 * Built by Max Harper (AI agent, OpenClaw).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { invoke } from './invoke';
import { runChain, loadChainConfig } from './chain';
import type { WebhookRequest, WebhookResponse, InvokeResult, ChainResult } from './types';

interface Job {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  request: WebhookRequest;
  result?: InvokeResult | ChainResult;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

const jobs = new Map<string, Job>();
const MAX_JOBS = 1000;

/** Parse JSON body from request */
async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Validate bearer token */
function validateAuth(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const parts = auth.split(' ');
  return parts[0] === 'Bearer' && parts[1] === token;
}

/** Send JSON response */
function respond(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Execute a job and optionally POST results to callback */
async function executeJob(job: Job): Promise<void> {
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  try {
    if (job.request.chain) {
      const config = loadChainConfig(job.request.chain);
      job.result = await runChain(config, job.request.repo, job.request.branch);
    } else if (job.request.skill) {
      job.result = await invoke({
        skill: job.request.skill,
        repo: job.request.repo,
        branch: job.request.branch,
        format: 'json',
        args: job.request.args,
      });
    } else {
      throw new Error('Either skill or chain must be specified');
    }

    job.status = 'completed';
  } catch (err: any) {
    job.status = 'failed';
    job.error = err.message;
  }

  job.completedAt = new Date().toISOString();

  // POST to callback if provided
  if (job.request.callback) {
    try {
      await fetch(job.request.callback, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.id,
          status: job.status,
          result: job.result,
          error: job.error,
        }),
      });
    } catch (err) {
      console.error(`Callback POST failed for job ${job.id}:`, err);
    }
  }
}

/** Evict oldest jobs if at capacity */
function evictOldJobs(): void {
  if (jobs.size < MAX_JOBS) return;
  const sorted = [...jobs.entries()].sort(
    (a, b) => (a[1].completedAt || a[1].startedAt || '') > (b[1].completedAt || b[1].startedAt || '') ? 1 : -1
  );
  const toRemove = Math.ceil(jobs.size * 0.2);
  for (let i = 0; i < toRemove; i++) {
    jobs.delete(sorted[i][0]);
  }
}

export function startHooksServer(port: number, token: string): void {
  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      respond(res, 200, { status: 'ok', jobs: jobs.size });
      return;
    }

    // Trigger skill/chain
    if (req.method === 'POST' && req.url === '/hooks/gstack') {
      if (!validateAuth(req, token)) {
        respond(res, 401, { error: 'Unauthorized' });
        return;
      }

      let body: WebhookRequest;
      try {
        body = (await parseBody(req)) as WebhookRequest;
      } catch {
        respond(res, 400, { error: 'Invalid JSON' });
        return;
      }

      if (!body.repo) {
        respond(res, 400, { error: 'repo is required' });
        return;
      }
      if (!body.skill && !body.chain) {
        respond(res, 400, { error: 'skill or chain is required' });
        return;
      }

      evictOldJobs();

      const job: Job = {
        id: randomUUID(),
        status: 'queued',
        request: body,
      };
      jobs.set(job.id, job);

      // Execute async
      executeJob(job).catch(err => {
        console.error(`Job ${job.id} failed:`, err);
      });

      const response: WebhookResponse = {
        jobId: job.id,
        status: 'queued',
      };
      respond(res, 202, response);
      return;
    }

    // Get job status
    if (req.method === 'GET' && req.url?.startsWith('/hooks/gstack/')) {
      const jobId = req.url.split('/').pop();
      if (!jobId || !jobs.has(jobId)) {
        respond(res, 404, { error: 'Job not found' });
        return;
      }

      const job = jobs.get(jobId)!;
      const response: WebhookResponse = {
        jobId: job.id,
        status: job.status,
        result: job.result,
      };
      respond(res, 200, response);
      return;
    }

    respond(res, 404, { error: 'Not found' });
  });

  server.listen(port, () => {
    console.log(`gstack agent-bridge hooks server listening on port ${port}`);
  });
}
