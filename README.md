# Claude Meet Claude

Bridge two Claude Code sessions so they can temporarily talk to each other. Each Claude retains its full project context. Original sessions are never modified.

## How It Works

1. Scans `~/.claude/projects/` to discover all Claude Code conversations
2. Forks both conversations using the Claude Agent SDK (originals stay untouched)
3. Relays messages between the forks with **real-time streaming** output
4. Saves a markdown transcript to `~/claude-meetings/`
5. Prints ready-to-paste prompts so you can share results with your live sessions

### The key insight

The Claude Agent SDK's `resume` + `forkSession` options let you:
- Resume an existing conversation with full project context
- Fork it so the original is never modified
- Stream responses in real-time as each Claude types
- Continue the forked conversation across multiple turns

This means two Claudes working on completely different projects can have a conversation where each one knows everything about its own project.

## Requirements

- **Node.js** 18+
- **Claude Code** CLI installed and authenticated
- At least two projects with Claude Code conversation history

## Installation

```bash
git clone https://github.com/AndrewBeniston/claude-meet-claude.git
cd claude-meet-claude
npm install
```

## Usage

### Interactive mode

```bash
node cli.mjs
```

Shows a numbered list of sessions to pick from, then prompts for a topic.

### With arguments

```bash
node cli.mjs \
  --a help-self \
  --b tungsten-flow \
  --topic "How should the auth tokens be shared between projects" \
  --turns 4 \
  --inject
```

### List available sessions

```bash
node cli.mjs --list
```

### Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--a <name>` | First session (project name or ID) | (interactive picker) |
| `--b <name>` | Second session (project name or ID) | (interactive picker) |
| `--topic <text>` | What they should discuss | (interactive prompt) |
| `--turns <n>` | Max conversation turns | 6 |
| `--inject` | Drop `.claude-meeting.md` into each project root | off |
| `--list` | List available sessions and exit | - |
| `-h, --help` | Show help | - |

## Sharing results with your live sessions

After the meeting, the CLI prints ready-to-paste messages:

```
Copy to help-self:
  Read ~/claude-meetings/2026-03-16-help-self-x-tungsten-flow-auth.md — meeting with tungsten-flow about auth integration

Copy to tungsten-flow:
  Read ~/claude-meetings/2026-03-16-help-self-x-tungsten-flow-auth.md — meeting with help-self about auth integration
```

With `--inject`, it also drops a `.claude-meeting.md` into each project root so you can just say: **`Read .claude-meeting.md`**

## Session Discovery

The CLI scans `~/.claude/projects/` and:
- Finds all conversation JSONL files
- Sorts by most recently active
- Reconstructs the original project path using a greedy directory matcher
- Displays project names with relative timestamps

No Zellij, tmux, or any terminal multiplexer required.

## How the fork mechanism works

```
Original Session A (untouched)          Original Session B (untouched)
        |                                        |
        v                                        v
   Fork of A -----> message -----> Fork of B
   Fork of A <----- response <---- Fork of B
   Fork of A -----> message -----> Fork of B
        |                                        |
        v                                        v
   (deleted after meeting)              (deleted after meeting)
```

- Forks inherit the full conversation history and project context
- Original sessions are never modified and can keep running
- Forked sessions are automatically cleaned up after the meeting
- Uses your Claude Code subscription — no separate API key needed

## Transcripts

Saved to `~/claude-meetings/` with filenames like:
```
2026-03-16-2315-help-self-x-audio-diarizer-auth-integration.md
```

## Auto-completion detection

The relay loop watches for keywords like "concluded", "agreed", "wrap up" to detect when the Claudes have reached agreement and end the meeting early.

## Bash version

A standalone bash script (`bridge.sh`) is also included for Zellij users. It uses the Claude CLI directly instead of the SDK and includes Zellij-specific session discovery. See the script for usage.

## Limitations

- Each turn is a full API call with the session's full context — longer histories = more tokens
- Sessions must have at least one prior conversation in their history
- The 300-word response limit per turn keeps turns focused
- Live interactive sessions can't automatically receive the transcript — you need to paste the `Read` command

## License

MIT
