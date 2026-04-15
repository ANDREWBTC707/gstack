#!/usr/bin/env bun
/**
 * CLI entry points for agent-bridge.
 *
 * gstack-invoke  — Run a single skill headlessly
 * gstack-chain   — Run a multi-skill pipeline
 * gstack-hooks   — Start the webhook server
 *
 * Built by Max Harper (AI agent, OpenClaw).
 */

import { invoke } from './invoke';
import { runChain, loadChainConfig } from './chain';
import { startHooksServer } from './hooks';
import { clearCache } from './cache';

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      flags[key] = value;
    }
  }
  return flags;
}

async function main() {
  if (!command || command === '--help') {
    console.log(`
agent-bridge — Agent-to-agent orchestration for gstack

Commands:
  invoke   Run a single skill headlessly
  chain    Run a multi-skill pipeline
  hooks    Start the webhook server
  cache    Cache management (clear)

Examples:
  gstack-invoke --skill review --repo . --format json
  gstack-chain  --config chains/pre-merge-gate.json --repo .
  gstack-hooks  --port 34568 --token mysecret
  gstack-cache  --clear

Built by Max Harper (AI agent, OpenClaw).
    `.trim());
    process.exit(0);
  }

  const flags = parseFlags(args.slice(1));

  switch (command) {
    case 'invoke': {
      if (!flags.skill) {
        console.error('Error: --skill is required');
        process.exit(1);
      }
      const result = await invoke({
        skill: flags.skill,
        repo: flags.repo || process.cwd(),
        branch: flags.branch,
        format: (flags.format as 'json' | 'markdown') || 'json',
        timeout: flags.timeout ? parseInt(flags.timeout) : undefined,
        noCache: flags['no-cache'] === 'true',
      });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.verdict === 'fail' || result.verdict === 'error' ? 1 : 0);
    }

    case 'chain': {
      if (!flags.config) {
        console.error('Error: --config is required (path to chain JSON)');
        process.exit(1);
      }
      const config = loadChainConfig(flags.config);
      const result = await runChain(config, flags.repo || process.cwd(), flags.branch);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.verdict === 'fail' ? 1 : 0);
    }

    case 'hooks': {
      const port = flags.port ? parseInt(flags.port) : 34568;
      const token = flags.token || process.env.GSTACK_HOOK_TOKEN;
      if (!token) {
        console.error('Error: --token or GSTACK_HOOK_TOKEN is required');
        process.exit(1);
      }
      startHooksServer(port, token);
      break;
    }

    case 'cache': {
      if (flags.clear === 'true') {
        const count = clearCache();
        console.log(`Cleared ${count} cached results`);
      } else {
        console.log('Usage: gstack-cache --clear');
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
