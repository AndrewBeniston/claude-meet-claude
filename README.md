# Claude Meet Claude

Bridge two running Claude Code sessions so they can temporarily talk to each other. Each Claude retains its full project context. Original sessions are never modified.

## How It Works

1. Auto-detects all Zellij sessions with Claude Code conversations
2. Maps each to its project directory and most recent conversation ID
3. Forks both conversations (originals stay untouched and can keep running)
4. Relays messages between the forks until they reach agreement or hit max turns
5. Saves a markdown transcript to `~/claude-meetings/`
6. Optionally drops a `.claude-meeting.md` into each project root so each Claude can absorb the results

### The key insight

`claude --resume SESSION_ID --fork-session -p "message"` lets you:
- Resume an existing conversation with full project context
- Fork it so the original is never modified
- Send a one-shot message and capture the response
- Continue the forked conversation across multiple turns

This means two Claudes working on completely different projects can have a conversation where each one knows everything about its own project.

## Requirements

- **Zellij** (terminal multiplexer) with named sessions
- **Claude Code** CLI installed
- **fzf** for interactive session picker
- At least two Zellij sessions with Claude Code conversation history

## Installation

### As a Claude Code Skill (recommended)

```bash
# Clone the repo
git clone https://github.com/AndrewBeniston/claude-meet-claude.git

# Create the skill directory
mkdir -p ~/.claude/skills/claude-meet-claude/scripts

# Copy files
cp claude-meet-claude/bridge.sh ~/.claude/skills/claude-meet-claude/scripts/bridge.sh
cp claude-meet-claude/SKILL.md ~/.claude/skills/claude-meet-claude/SKILL.md
chmod +x ~/.claude/skills/claude-meet-claude/scripts/bridge.sh
```

Then use it in any Claude Code session:
```
/claude-meet-claude
```

### Standalone (no Claude Code skill)

```bash
# Clone and make executable
git clone https://github.com/AndrewBeniston/claude-meet-claude.git
chmod +x claude-meet-claude/bridge.sh

# Run directly
./claude-meet-claude/bridge.sh --list
./claude-meet-claude/bridge.sh --a my-project --b other-project --topic "How should we integrate?"
```

## Usage

### Interactive mode (fzf picker)

```bash
./bridge.sh
```

Shows an fzf picker to select two sessions and prompts for a topic.

### With arguments

```bash
./bridge.sh \
  --a help-self \
  --b tungsten-flow \
  --topic "How should the auth tokens be shared between projects" \
  --turns 4 \
  --inject
```

### List available sessions

```bash
./bridge.sh --list
```

### Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--a <session>` | First Zellij session name | (interactive picker) |
| `--b <session>` | Second Zellij session name | (interactive picker) |
| `--topic <topic>` | What they should discuss | (interactive prompt) |
| `--turns <n>` | Max conversation turns | 6 |
| `--inject` | Drop `.claude-meeting.md` into each project root | off |
| `--list` | List available sessions and exit | - |

## What `--inject` does

After the meeting, writes a `.claude-meeting.md` file into each project's root directory containing:
- What the meeting was about
- Who the other Claude was
- Path to the full transcript

Then you just go to each Claude session and say: **`Read .claude-meeting.md`**

## Session Discovery

The script finds sessions in three ways:

1. **Zellij layout inspection** — looks for `command="claude"` panes and extracts their cwd
2. **Relative cwd resolution** — handles panes with relative cwds (e.g., `cwd="Git/my-project"`)
3. **Session name fallback** — if no Claude pane is found, tries matching the Zellij session name to a project directory in `~/Documents/01-Projects/Git/`

## Transcripts

All meeting transcripts are saved to `~/claude-meetings/` with filenames like:
```
2026-03-16-2315-help-self-x-audio-diarizer-auth-integration.md
```

Each transcript includes:
- Date, session names, project paths
- The discussion topic
- Full conversation with turn labels

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

## Auto-completion detection

The relay loop watches for keywords like "concluded", "agreed", "wrap up", "nothing more" to detect when the Claudes have reached agreement and end the meeting early.

## Limitations

- Each turn is a full Claude API call with the session's context — longer histories = more tokens/cost
- Sessions must have at least one prior conversation in their history
- The 300-word response limit per turn keeps costs manageable
- Cross-session Zellij floating pane injection doesn't work reliably when no client is viewing the target session (hence the `.claude-meeting.md` file approach)

## License

MIT
