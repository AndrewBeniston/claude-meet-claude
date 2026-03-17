#!/usr/bin/env node

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

// --- Colors ---
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
};

// --- Parse args ---
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { maxTurns: 6, inject: false, list: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--a": opts.sessionA = args[++i]; break;
      case "--b": opts.sessionB = args[++i]; break;
      case "--topic": opts.topic = args[++i]; break;
      case "--turns": opts.maxTurns = parseInt(args[++i]); break;
      case "--inject": opts.inject = true; break;
      case "--list": opts.list = true; break;
      case "--help": case "-h": printHelp(); process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
${c.bold}${c.cyan}Claude Meet Claude${c.reset} — Bridge two Claude Code sessions

${c.bold}Usage:${c.reset}
  claude-meet-claude [options]

${c.bold}Options:${c.reset}
  --a <session>    First session (name or ID)
  --b <session>    Second session (name or ID)
  --topic <text>   What they should discuss
  --turns <n>      Max conversation turns (default: 6)
  --inject         Drop .claude-meeting.md into each project root
  --list           List available sessions and exit
  -h, --help       Show this help
`);
}

// --- Path decoder ---
// Claude encodes /Users/foo/my-project as -Users-foo-my-project
// We reconstruct by greedily matching real directories from left to right
async function decodeProjDir(encoded) {
  const parts = encoded.split("-").filter(Boolean);
  let path = "";
  let i = 0;

  while (i < parts.length) {
    // Try progressively longer segments (to handle hyphens in dir names)
    let matched = false;
    for (let len = parts.length - i; len >= 1; len--) {
      const segment = parts.slice(i, i + len).join("-");
      const candidate = path + "/" + segment;
      if (existsSync(candidate)) {
        path = candidate;
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Fallback: just use the single part
      path += "/" + parts[i];
      i++;
    }
  }

  return path;
}

// --- Session discovery ---
async function discoverSessions() {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  const entries = await readdir(projectsDir, { withFileTypes: true });
  const sessions = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const projPath = join(projectsDir, entry.name);
    const files = await readdir(projPath).catch(() => []);
    const jsonlFiles = files
      .filter((f) => f.endsWith(".jsonl") && !f.includes("subagent"))
      .map((f) => ({
        name: f,
        path: join(projPath, f),
        id: f.replace(".jsonl", ""),
      }));

    if (jsonlFiles.length === 0) continue;

    // Decode the project path from the dir name
    // Dir name is the full path with / replaced by -
    // We can't just replace all - with / because dir names contain hyphens
    // Instead, try to find the actual path by checking if it exists
    const cwd = await decodeProjDir(entry.name);
    const projectName = basename(cwd);

    // Get the most recent conversation (by file mtime)
    const withStats = await Promise.all(
      jsonlFiles.map(async (f) => {
        const stat = await import("fs").then((fs) =>
          fs.promises.stat(f.path)
        );
        return { ...f, mtime: stat.mtime };
      })
    );
    withStats.sort((a, b) => b.mtime - a.mtime);
    const latest = withStats[0];

    sessions.push({
      projectName,
      cwd,
      convId: latest.id,
      mtime: latest.mtime,
      dirName: entry.name,
    });
  }

  // Sort by most recently active
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// --- SDK helpers ---
function getAssistantText(msg) {
  if (msg.type !== "assistant") return null;
  return msg.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function forkAndSend(convId, cwd, message) {
  let forkSessionId = null;
  let fullResponse = "";

  const response = query({
    prompt: message,
    options: {
      resume: convId,
      forkSession: true,
      permissionMode: "bypassPermissions",
      cwd,
    },
  });

  for await (const msg of response) {
    if (msg.type === "system" && msg.subtype === "init") {
      forkSessionId = msg.session_id;
    }
    const text = getAssistantText(msg);
    if (text) {
      process.stdout.write(text);
      fullResponse += text;
    }
  }

  console.log();
  return { forkSessionId, response: fullResponse };
}

async function resumeAndSend(sessionId, cwd, message) {
  let fullResponse = "";

  const response = query({
    prompt: message,
    options: {
      resume: sessionId,
      permissionMode: "bypassPermissions",
      cwd,
    },
  });

  for await (const msg of response) {
    const text = getAssistantText(msg);
    if (text) {
      process.stdout.write(text);
      fullResponse += text;
    }
  }

  console.log();
  return fullResponse;
}

// --- Simple interactive prompt ---
async function prompt(question) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        process.stdin.pause();
        process.stdin.removeAllListeners("data");
        resolve(data.trim());
      }
    });
  });
}

// --- Pick session interactively ---
function printSessionList(sessions) {
  sessions.forEach((s, i) => {
    const age = timeSince(s.mtime);
    console.log(
      `  ${c.bold}${i + 1}${c.reset}) ${c.cyan}${s.projectName}${c.reset} ${c.dim}(${age} ago)${c.reset}`
    );
  });
}

function timeSince(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

async function pickSession(sessions, label) {
  console.log(`\n${c.yellow}Select ${label}:${c.reset}`);
  printSessionList(sessions);
  const answer = await prompt(`${c.bold}> ${c.reset}`);
  const idx = parseInt(answer) - 1;
  if (idx < 0 || idx >= sessions.length) {
    console.log(`${c.red}Invalid selection.${c.reset}`);
    process.exit(1);
  }
  return sessions[idx];
}

function findSession(sessions, nameOrId) {
  return (
    sessions.find((s) => s.projectName === nameOrId) ||
    sessions.find((s) => s.convId === nameOrId) ||
    sessions.find((s) =>
      s.projectName.toLowerCase().includes(nameOrId.toLowerCase())
    )
  );
}

// --- Main ---
async function main() {
  const opts = parseArgs();

  console.log(`\n${c.bold}${c.cyan}  Claude Meet Claude${c.reset}`);
  console.log(`${c.dim}  Cross-session bridge${c.reset}\n`);

  // Discover sessions
  const sessions = await discoverSessions();
  if (sessions.length === 0) {
    console.log(`${c.red}No Claude Code conversations found.${c.reset}`);
    process.exit(1);
  }

  // List mode
  if (opts.list) {
    console.log(`${c.bold}Available sessions:${c.reset}\n`);
    printSessionList(sessions);
    process.exit(0);
  }

  // Pick sessions
  let sessionA, sessionB;

  if (opts.sessionA) {
    sessionA = findSession(sessions, opts.sessionA);
    if (!sessionA) {
      console.log(
        `${c.red}Session not found: ${opts.sessionA}${c.reset}`
      );
      process.exit(1);
    }
  } else {
    sessionA = await pickSession(sessions, "first session");
  }

  if (opts.sessionB) {
    sessionB = findSession(sessions, opts.sessionB);
    if (!sessionB) {
      console.log(
        `${c.red}Session not found: ${opts.sessionB}${c.reset}`
      );
      process.exit(1);
    }
  } else {
    sessionB = await pickSession(
      sessions.filter((s) => s.convId !== sessionA.convId),
      "second session"
    );
  }

  // Get topic
  let topic = opts.topic;
  if (!topic) {
    topic = await prompt(`\n${c.yellow}What should they discuss?${c.reset}\n${c.bold}> ${c.reset}`);
    if (!topic) {
      console.log("No topic provided.");
      process.exit(1);
    }
  }

  console.log(`\n${c.bold}Bridge:${c.reset}`);
  console.log(
    `  A: ${c.cyan}${sessionA.projectName}${c.reset} ${c.dim}(${sessionA.cwd})${c.reset}`
  );
  console.log(
    `  B: ${c.cyan}${sessionB.projectName}${c.reset} ${c.dim}(${sessionB.cwd})${c.reset}`
  );
  console.log(`  Topic: ${topic}`);
  console.log(`  Max turns: ${opts.maxTurns}\n`);

  // Fork session A
  console.log(`${c.dim}Forking ${sessionA.projectName}...${c.reset}`);
  const seedPrompt = `You're in a temporary meeting with another Claude Code session.

YOUR project: '${sessionA.projectName}' (${sessionA.cwd})
THEIR project: '${sessionB.projectName}' (${sessionB.cwd})

The user wants you both to discuss: ${topic}

Go first. Introduce what you know from your project context that's relevant, then ask them a question or propose something. Keep responses focused and under 300 words.`;

  console.log(`\n${c.bold}${c.blue}--- ${sessionA.projectName} ---${c.reset}`);
  const forkA = await forkAndSend(sessionA.convId, sessionA.cwd, seedPrompt);

  // Transcript
  const transcript = [
    `# Claude Meet Claude`,
    `**Date:** ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    `**Session A:** ${sessionA.projectName} (${sessionA.cwd})`,
    `**Session B:** ${sessionB.projectName} (${sessionB.cwd})`,
    `**Topic:** ${topic}`,
    "",
    "---",
    "",
    `## Turn 1 — ${sessionA.projectName}`,
    "",
    forkA.response,
    "",
  ];

  // Fork session B with A's response
  console.log(`\n${c.dim}Forking ${sessionB.projectName}...${c.reset}`);
  const bFirstPrompt = `You're in a temporary meeting with another Claude Code session.

YOUR project: '${sessionB.projectName}' (${sessionB.cwd})
THEIR project: '${sessionA.projectName}' (${sessionA.cwd})

The user wants you both to discuss: ${topic}

The other Claude (${sessionA.projectName}) said:

${forkA.response}

Respond to them. Share relevant context from your project. Keep responses focused and under 300 words.`;

  console.log(`\n${c.bold}${c.green}--- ${sessionB.projectName} ---${c.reset}`);
  const forkB = await forkAndSend(sessionB.convId, sessionB.cwd, bFirstPrompt);

  transcript.push(
    `## Turn 1 — ${sessionB.projectName}`,
    "",
    forkB.response,
    ""
  );

  // Relay loop for remaining turns
  let lastResponseA = forkA.response;
  let lastResponseB = forkB.response;

  for (let turn = 2; turn <= opts.maxTurns; turn++) {
    // Check if B signaled completion
    if (/conclud|agreed|that covers|nothing more|wrap up|summary of decisions/i.test(lastResponseB)) {
      console.log(`\n${c.yellow}Conversation reached agreement.${c.reset}`);
      break;
    }

    // A responds to B
    const aPrompt = `The other Claude (${sessionB.projectName}) said:\n\n${lastResponseB}\n\nRespond to them. Keep responses focused and under 300 words.`;

    console.log(`\n${c.bold}${c.blue}--- Turn ${turn}: ${sessionA.projectName} ---${c.reset}`);
    lastResponseA = await resumeAndSend(forkA.forkSessionId, sessionA.cwd, aPrompt);

    transcript.push(`## Turn ${turn} — ${sessionA.projectName}`, "", lastResponseA, "");

    // Check if A signaled completion
    if (/conclud|agreed|that covers|nothing more|wrap up|summary of decisions/i.test(lastResponseA)) {
      console.log(`\n${c.yellow}Conversation reached agreement.${c.reset}`);

      // Give B one final turn
      const bFinalPrompt = `The other Claude (${sessionA.projectName}) said:\n\n${lastResponseA}\n\nGive your final summary. This is the last turn.`;
      console.log(`\n${c.bold}${c.green}--- Final: ${sessionB.projectName} ---${c.reset}`);
      lastResponseB = await resumeAndSend(forkB.forkSessionId, sessionB.cwd, bFinalPrompt);
      transcript.push(`## Final — ${sessionB.projectName}`, "", lastResponseB, "");
      break;
    }

    // B responds to A
    const bPrompt = `The other Claude (${sessionA.projectName}) said:\n\n${lastResponseA}\n\nRespond to them. Keep responses focused and under 300 words.`;

    console.log(`\n${c.bold}${c.green}--- Turn ${turn}: ${sessionB.projectName} ---${c.reset}`);
    lastResponseB = await resumeAndSend(forkB.forkSessionId, sessionB.cwd, bPrompt);

    transcript.push(`## Turn ${turn} — ${sessionB.projectName}`, "", lastResponseB, "");
  }

  // Save transcript
  const meetingsDir = join(homedir(), "claude-meetings");
  await mkdir(meetingsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const safeTopic = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 50);
  const filename = `${timestamp}-${sessionA.projectName}-x-${sessionB.projectName}-${safeTopic}.md`;
  const transcriptPath = join(meetingsDir, filename);

  transcript.push("", "---", "", `*Meeting ended at ${new Date().toTimeString().slice(0, 5)}*`);
  await writeFile(transcriptPath, transcript.join("\n"));

  console.log(`\n${c.bold}${c.cyan}Meeting complete.${c.reset}`);
  console.log(`${c.dim}Transcript: ${transcriptPath}${c.reset}`);

  // Inject .claude-meeting.md into project roots
  if (opts.inject) {
    for (const [session, other] of [
      [sessionA, sessionB],
      [sessionB, sessionA],
    ]) {
      const meetingFile = join(session.cwd, ".claude-meeting.md");
      const content = `I just had a meeting with the Claude session working on '${other.projectName}' about: ${topic}\n\nRead the full transcript and absorb the key decisions: ${transcriptPath}\n\n(Delete this file after reading — auto-generated by claude-meet-claude)\n`;
      await writeFile(meetingFile, content).catch(() => {});
    }
    console.log(`\n${c.green}.claude-meeting.md dropped into both project roots.${c.reset}`);
    console.log(`Go to each session and say: ${c.bold}Read .claude-meeting.md${c.reset}`);
  }

  // Always print copy-paste prompts
  console.log(`\n${c.bold}Copy to ${c.cyan}${sessionA.projectName}${c.reset}${c.bold}:${c.reset}`);
  console.log(`  Read ${transcriptPath} — meeting with ${sessionB.projectName} about ${topic}`);
  console.log(`\n${c.bold}Copy to ${c.cyan}${sessionB.projectName}${c.reset}${c.bold}:${c.reset}`);
  console.log(`  Read ${transcriptPath} — meeting with ${sessionA.projectName} about ${topic}`);

  // Clean up forked sessions
  const cleanupFork = async (forkId, dirName) => {
    const projDir = join(homedir(), ".claude", "projects", dirName);
    const jsonlPath = join(projDir, `${forkId}.jsonl`);
    const subDir = join(projDir, forkId);
    await import("fs").then((fs) => {
      fs.rmSync(jsonlPath, { force: true });
      fs.rmSync(subDir, { recursive: true, force: true });
    });
  };

  if (forkA.forkSessionId) await cleanupFork(forkA.forkSessionId, sessionA.dirName);
  if (forkB.forkSessionId) await cleanupFork(forkB.forkSessionId, sessionB.dirName);

  console.log(`\n${c.dim}Forked sessions cleaned up.${c.reset}`);
}

main().catch((err) => {
  console.error(`${c.red}Error: ${err.message}${c.reset}`);
  process.exit(1);
});
