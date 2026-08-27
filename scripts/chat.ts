/**
 * ncl — chat with your NanoClaw agent from the terminal.
 *
 * Usage:
 *   pnpm run chat                 # interactive chat window (Claude Code-style)
 *   pnpm run chat <message...>    # one-shot: send a message, print replies, exit
 *
 * Both modes talk to the CLI channel over its Unix socket (`data/cli.sock`,
 * see src/channels/cli.ts). The wire protocol is a persistent duplex
 * stream — one JSON object per line each way — so interactive mode is just
 * the one-shot connection kept open, with replies printed as they arrive
 * instead of exiting after the first quiet gap.
 *
 * Preconditions: NanoClaw host service running, an agent group wired to
 * `cli/local` via `/init-first-agent` or `/manage-channels`.
 */
import net from 'net';
import path from 'path';
import readline from 'readline';

import kleur from 'kleur';

import { DATA_DIR } from '../src/config.js';

const SILENCE_MS = 2000; // one-shot mode: exit after this much quiet time following the first reply
const TOTAL_TIMEOUT_MS = 120_000; // one-shot mode: hard stop

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function reportConnectionError(err: NodeJS.ErrnoException): void {
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
    console.error(`NanoClaw daemon not reachable at ${socketPath()}.`);
    console.error('Start the service (launchctl/systemd) before running ncl.');
  } else {
    console.error('CLI socket error:', err);
  }
}

function runOneShot(text: string): void {
  const socket = net.connect(socketPath());

  socket.on('error', (err) => {
    reportConnectionError(err as NodeJS.ErrnoException);
    process.exit(2);
  });

  let firstReplySeen = false;
  let silenceTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;

  function scheduleExit(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      socket.end();
      process.exit(0);
    }, SILENCE_MS);
  }

  socket.on('connect', () => {
    socket.write(JSON.stringify({ text }) + '\n');
    hardTimer = setTimeout(() => {
      if (!firstReplySeen) {
        console.error(`timeout: no reply in ${TOTAL_TIMEOUT_MS}ms`);
        socket.end();
        process.exit(3);
      }
    }, TOTAL_TIMEOUT_MS);
  });

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.text === 'string') {
          process.stdout.write(msg.text + '\n');
          firstReplySeen = true;
          if (hardTimer) {
            clearTimeout(hardTimer);
            hardTimer = null;
          }
          scheduleExit();
        }
      } catch {
        // Ignore non-JSON lines — forward compatibility.
      }
    }
  });

  socket.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    process.exit(firstReplySeen ? 0 : 3);
  });
}

function runInteractive(): void {
  const socket = net.connect(socketPath());
  const youLabel = kleur.cyan().bold('you');
  const agentLabel = kleur.green().bold('agent');

  socket.on('error', (err) => {
    reportConnectionError(err as NodeJS.ErrnoException);
    process.exit(2);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${youLabel} > `,
  });

  socket.on('connect', () => {
    console.log(
      kleur.dim(`Connected to ${socketPath()}. Type a message and press Enter. /exit to quit, Ctrl+C also works.\n`),
    );
    rl.prompt();
  });

  rl.on('line', (line) => {
    const text = line.trim();
    if (text === '/exit' || text === '/quit') {
      rl.close();
      return;
    }
    if (text.length > 0) {
      socket.write(JSON.stringify({ text }) + '\n');
    }
    rl.prompt();
  });

  rl.on('close', () => {
    socket.end();
    process.exit(0);
  });

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.text === 'string') {
          // Clear the in-progress prompt line, print the reply above it, then
          // redraw the prompt — readline's internal line buffer (whatever the
          // user had half-typed) survives untouched, so this doesn't eat input.
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          console.log(`${agentLabel} > ${msg.text}\n`);
          rl.prompt(true);
        }
      } catch {
        // Ignore non-JSON lines — forward compatibility.
      }
    }
  });

  socket.on('close', () => {
    console.log(kleur.dim('\n[disconnected]'));
    process.exit(0);
  });
}

function main(): void {
  const words = process.argv.slice(2);
  if (words.length === 0) {
    runInteractive();
    return;
  }
  runOneShot(words.join(' '));
}

main();
