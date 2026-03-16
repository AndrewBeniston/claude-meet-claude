---
name: claude-meet-claude
description: Bridge two Claude Code sessions for a temporary conversation. Auto-detects Zellij sessions running Claude, forks their conversations, relays messages between them, saves a transcript, and optionally injects results back into the live sessions. Use when the user says /claude-meet-claude, 'connect my claudes', 'have them talk', 'bridge sessions', or 'claude meeting'.
allowed-tools: Bash, Read, Glob, Grep
---

# Claude Meet Claude

Bridge two running Claude Code sessions so they can temporarily talk to each other. Each Claude retains its full project context. Original sessions are never modified.

## How It Works

1. Auto-detects all Zellij sessions running Claude
2. Maps each to its project directory and most recent conversation ID
3. Forks both conversations (originals stay untouched and can keep running)
4. Relays messages between the forks until they reach agreement or hit max turns
5. Saves a markdown transcript to `~/claude-meetings/`
6. Optionally injects the transcript as a floating pane in each original Zellij session

## Usage

When the user invokes this skill, run the bridge script:

```bash
~/.claude/skills/claude-meet-claude/scripts/bridge.sh [OPTIONS]
```

### Interactive mode (recommended)
If the user just says `/claude-meet-claude` with no arguments, run:
```bash
bash ~/.claude/skills/claude-meet-claude/scripts/bridge.sh
```
This will show an fzf picker for both sessions and prompt for a topic.

### With arguments
Parse the user's request and pass the appropriate flags:

| Flag | Description |
|------|-------------|
| `--a <session>` | First Zellij session name |
| `--b <session>` | Second Zellij session name |
| `--topic <topic>` | What they should discuss |
| `--turns <n>` | Max conversation turns (default: 6) |
| `--inject` | Auto-open transcript as floating pane in both sessions |
| `--list` | Just list available sessions |

### Examples

```bash
# Full interactive — picker + topic prompt
bash ~/.claude/skills/claude-meet-claude/scripts/bridge.sh

# Specify everything
bash ~/.claude/skills/claude-meet-claude/scripts/bridge.sh \
  --a help-self --b tungsten-flow \
  --topic "How should the auth tokens be shared between projects" \
  --turns 4 --inject

# Just see what's available
bash ~/.claude/skills/claude-meet-claude/scripts/bridge.sh --list
```

## After the Meeting

The transcript is saved to `~/claude-meetings/YYYY-MM-DD-HHMM-sessionA-x-sessionB-topic.md`.

To share with the live sessions, tell the user:
- Paste into each Claude session: `Read ~/claude-meetings/<filename>.md`
- Or re-run with `--inject` to auto-open floating panes in each Zellij session

## Requirements

- Zellij must be running with named sessions
- Both target sessions must have a Claude pane (`command="claude"` in layout)
- Both must have at least one conversation in their history
- `fzf` must be installed (for interactive session picker)

## Important Notes

- **Original sessions are NEVER modified** — the script forks both conversations
- Forked sessions are automatically cleaned up after the meeting
- Each turn costs a full API call with the session's context — longer histories = more tokens
- The 300-word response limit keeps turns focused and costs down
- Auto-completion detection looks for keywords like "concluded", "agreed", "wrap up"
