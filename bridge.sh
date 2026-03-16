#!/bin/bash
# claude-meet-claude bridge script
# Connects two Claude Code sessions for a temporary conversation
# Usage: bridge.sh --a <session> --b <session> --topic <topic> [--turns <max>] [--inject]

set -euo pipefail

# --- Config ---
MEETINGS_DIR="$HOME/claude-meetings"
CLAUDE_PROJECTS="$HOME/.claude/projects"
MAX_TURNS=6
INJECT=false
SESSION_A=""
SESSION_B=""
TOPIC=""

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case $1 in
        --a) SESSION_A="$2"; shift 2 ;;
        --b) SESSION_B="$2"; shift 2 ;;
        --topic) TOPIC="$2"; shift 2 ;;
        --turns) MAX_TURNS="$2"; shift 2 ;;
        --inject) INJECT=true; shift ;;
        --list) LIST_ONLY=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# --- Functions ---

discover_sessions() {
    # Find all Zellij sessions with Claude conversations, output: SESSION_NAME|CWD|CONV_ID
    local sessions
    sessions=$(zellij list-sessions -s 2>/dev/null) || { echo "Zellij not running" >&2; exit 1; }

    while IFS= read -r session; do
        local layout cwd
        layout=$(zellij --session "$session" action dump-layout 2>/dev/null) || continue

        # Extract top-level cwd from layout header
        local top_cwd
        top_cwd=$(echo "$layout" | head -3 | sed -n 's/.*cwd "\([^"]*\)".*/\1/p')

        # Strategy 1: Look for command="claude" panes and use their cwd
        local claude_pane_cwd
        claude_pane_cwd=$(echo "$layout" | sed -n 's/.*command="claude" cwd="\([^"]*\)".*/\1/p' | head -1)

        if [[ -n "$claude_pane_cwd" ]]; then
            # Claude pane found with its own cwd (may be relative)
            if [[ "$claude_pane_cwd" == /* ]]; then
                cwd="$claude_pane_cwd"
            elif [[ -n "$top_cwd" ]]; then
                cwd="${top_cwd}/${claude_pane_cwd}"
            fi
        elif echo "$layout" | grep -q 'command="claude"'; then
            # Claude pane found but no pane-level cwd — use top-level
            cwd="$top_cwd"
        else
            # Strategy 2: No command="claude" pane — try matching session name to project dir
            # This catches sessions where Claude was launched interactively
            local guess_cwd=""
            for base_dir in "$HOME/Documents/01-Projects/Git" "$HOME/Documents/01-Projects"; do
                if [[ -d "$base_dir/$session" ]]; then
                    guess_cwd="$base_dir/$session"
                    break
                fi
            done
            if [[ -z "$guess_cwd" ]]; then
                # Also try using top_cwd directly if it exists
                [[ -n "$top_cwd" ]] && guess_cwd="$top_cwd"
            fi
            [[ -z "$guess_cwd" ]] && continue
            cwd="$guess_cwd"
        fi

        [[ -z "$cwd" ]] && continue

        # Map cwd to Claude project dir and find latest conversation
        local encoded proj_dir latest conv_id
        encoded=$(echo "$cwd" | sed 's|/|-|g')
        proj_dir="$CLAUDE_PROJECTS/$encoded"

        if [[ -d "$proj_dir" ]]; then
            latest=$(ls -t "$proj_dir"/*.jsonl 2>/dev/null | grep -v subagents | head -1)
            conv_id=$(basename "$latest" .jsonl 2>/dev/null)
            [[ -z "$conv_id" ]] && continue
        else
            continue  # No conversation history — skip
        fi

        echo "${session}|${cwd}|${conv_id}"
    done <<< "$sessions"
}

show_picker() {
    local sessions_data="$1"
    local label="$2"

    # Format for fzf: "session_name (project_dir)"
    local display
    display=$(echo "$sessions_data" | while IFS='|' read -r name cwd conv; do
        local short_cwd
        short_cwd=$(basename "$cwd")
        echo "$name ($short_cwd)"
    done)

    local choice
    choice=$(echo "$display" | fzf --height=~15 --reverse --prompt="$label > " --header="Pick a Claude session")

    # Extract session name from choice
    echo "$choice" | sed 's/ (.*//'
}

get_session_info() {
    # Given session name and discovery data, return CWD|CONV_ID
    local session="$1"
    local data="$2"
    echo "$data" | grep "^${session}|" | head -1 | cut -d'|' -f2,3
}

fork_session() {
    local conv_id="$1"
    local cwd="$2"
    local label="$3"

    # List existing jsonl files before fork
    local encoded proj_dir before after forked fork_id
    encoded=$(echo "$cwd" | sed 's|/|-|g')
    proj_dir="$CLAUDE_PROJECTS/$encoded"

    before=$(ls "$proj_dir"/*.jsonl 2>/dev/null | sort)

    # Fork the session (suppress claude output — we only need the new session ID)
    cd "$cwd"
    claude --resume "$conv_id" --fork-session -p "You are about to enter a temporary meeting with another Claude Code session working on a different project. You will be labeled '${label}'. Acknowledge briefly." --dangerously-skip-permissions >/dev/null 2>&1

    after=$(ls "$proj_dir"/*.jsonl 2>/dev/null | sort)

    # Find the new file
    forked=$(diff <(echo "$before") <(echo "$after") | grep "^>" | sed 's/^> //' | head -1)
    fork_id=$(basename "$forked" .jsonl)

    echo "$fork_id"
}

relay_turn() {
    local conv_id="$1"
    local cwd="$2"
    local message="$3"

    cd "$cwd"
    claude --resume "$conv_id" -p "$message" --dangerously-skip-permissions 2>/dev/null
}

inject_transcript() {
    local session="$1"
    local transcript_file="$2"
    local topic="$3"
    local other_session="$4"
    local project_cwd="$5"

    # Write a meeting notes file into the project root
    local meeting_file="${project_cwd}/.claude-meeting.md"
    cat > "$meeting_file" << EOF
I just had a meeting with the Claude session working on '${other_session}' about: ${topic}.

Read the full transcript and absorb the key decisions: ${transcript_file}

(Delete this file after reading — it was auto-generated by /claude-meet-claude)
EOF
}

# --- Main ---

echo -e "${BOLD}${CYAN}"
echo "  ┌─────────────────────────────────────┐"
echo "  │       Claude Meet Claude             │"
echo "  │  Temporary cross-session bridge      │"
echo "  └─────────────────────────────────────┘"
echo -e "${NC}"

# Step 1: Discover sessions
echo -e "${DIM}Scanning Zellij sessions for Claude instances...${NC}"
SESSIONS_DATA=$(discover_sessions)

if [[ -z "$SESSIONS_DATA" ]]; then
    echo -e "${RED}No Zellij sessions with Claude found.${NC}"
    exit 1
fi

SESSION_COUNT=$(echo "$SESSIONS_DATA" | wc -l | tr -d ' ')
echo -e "${GREEN}Found $SESSION_COUNT session(s) with Claude running.${NC}"
echo ""

# List mode
if [[ "${LIST_ONLY:-false}" == "true" ]]; then
    echo -e "${BOLD}Available sessions:${NC}"
    echo "$SESSIONS_DATA" | while IFS='|' read -r name cwd conv; do
        echo -e "  ${CYAN}$name${NC} — $(basename "$cwd") ${DIM}($conv)${NC}"
    done
    exit 0
fi

# Step 2: Pick sessions if not provided
if [[ -z "$SESSION_A" ]]; then
    echo -e "${YELLOW}Select the FIRST Claude session:${NC}"
    SESSION_A=$(show_picker "$SESSIONS_DATA" "Session A")
    [[ -z "$SESSION_A" ]] && { echo "Cancelled."; exit 0; }
fi

if [[ -z "$SESSION_B" ]]; then
    echo -e "${YELLOW}Select the SECOND Claude session:${NC}"
    SESSION_B=$(show_picker "$SESSIONS_DATA" "Session B")
    [[ -z "$SESSION_B" ]] && { echo "Cancelled."; exit 0; }
fi

if [[ "$SESSION_A" == "$SESSION_B" ]]; then
    echo -e "${RED}Cannot bridge a session with itself.${NC}"
    exit 1
fi

# Step 3: Get session info
INFO_A=$(get_session_info "$SESSION_A" "$SESSIONS_DATA")
INFO_B=$(get_session_info "$SESSION_B" "$SESSIONS_DATA")

CWD_A=$(echo "$INFO_A" | cut -d'|' -f1)
CONV_A=$(echo "$INFO_A" | cut -d'|' -f2)
CWD_B=$(echo "$INFO_B" | cut -d'|' -f1)
CONV_B=$(echo "$INFO_B" | cut -d'|' -f2)

echo ""
echo -e "${BOLD}Bridge setup:${NC}"
echo -e "  A: ${CYAN}$SESSION_A${NC} — $CWD_A"
echo -e "  B: ${CYAN}$SESSION_B${NC} — $CWD_B"

if [[ "$CONV_A" == "NONE" || "$CONV_B" == "NONE" ]]; then
    echo -e "${RED}One or both sessions have no conversation history. Start a Claude session first.${NC}"
    exit 1
fi

# Step 4: Get topic if not provided
if [[ -z "$TOPIC" ]]; then
    echo ""
    echo -e "${YELLOW}What should they discuss?${NC}"
    read -r -p "> " TOPIC
    [[ -z "$TOPIC" ]] && { echo "No topic provided."; exit 1; }
fi

echo ""
echo -e "${BOLD}Topic:${NC} $TOPIC"
echo -e "${BOLD}Max turns:${NC} $MAX_TURNS"
echo ""

# Step 5: Fork both sessions
echo -e "${DIM}Forking session A ($SESSION_A)...${NC}"
FORK_A=$(fork_session "$CONV_A" "$CWD_A" "$SESSION_A")
echo -e "${GREEN}  Forked: $FORK_A${NC}"

echo -e "${DIM}Forking session B ($SESSION_B)...${NC}"
FORK_B=$(fork_session "$CONV_B" "$CWD_B" "$SESSION_B")
echo -e "${GREEN}  Forked: $FORK_B${NC}"

# Step 6: Set up transcript
mkdir -p "$MEETINGS_DIR"
TIMESTAMP=$(date +%Y-%m-%d-%H%M)
SAFE_TOPIC=$(echo "$TOPIC" | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g' | head -c 50)
TRANSCRIPT="$MEETINGS_DIR/${TIMESTAMP}-${SESSION_A}-x-${SESSION_B}-${SAFE_TOPIC}.md"

cat > "$TRANSCRIPT" << EOF
# Claude Meet Claude
**Date:** $(date '+%Y-%m-%d %H:%M')
**Session A:** $SESSION_A ($CWD_A)
**Session B:** $SESSION_B ($CWD_B)
**Topic:** $TOPIC

---

EOF

echo ""
echo -e "${BOLD}${GREEN}Meeting started.${NC}"
echo -e "${DIM}Transcript: $TRANSCRIPT${NC}"
echo ""

# Step 7: Relay loop
SEED_PROMPT="You're in a temporary meeting with another Claude Code session.

YOUR project: You are working in the '$SESSION_A' session.
THEIR project: They are working in the '$SESSION_B' session.

The user wants you both to discuss: $TOPIC

Go first. Introduce what you know from your project context that's relevant, then ask them a question or propose something. Keep responses focused and under 300 words."

MESSAGE="$SEED_PROMPT"

for turn in $(seq 1 "$MAX_TURNS"); do
    # --- Session A speaks ---
    echo -e "${BOLD}${BLUE}--- Turn $turn: $SESSION_A ---${NC}"
    RESPONSE_A=$(relay_turn "$FORK_A" "$CWD_A" "$MESSAGE")
    echo "$RESPONSE_A"
    echo ""

    # Log to transcript
    cat >> "$TRANSCRIPT" << EOF
## Turn $turn — $SESSION_A

$RESPONSE_A

EOF

    # Check if A thinks they're done
    if echo "$RESPONSE_A" | grep -qi "conclud\|agreed\|that covers\|nothing more\|wrap up\|summary of decisions"; then
        echo -e "${YELLOW}Session A signaled completion. Running one final turn for B...${NC}"

        MESSAGE="The other Claude ($SESSION_A session) said:

$RESPONSE_A

Please give your final summary of what was decided/discussed. This is the last turn."

        RESPONSE_B=$(relay_turn "$FORK_B" "$CWD_B" "$MESSAGE")
        echo -e "${BOLD}${GREEN}--- Final: $SESSION_B ---${NC}"
        echo "$RESPONSE_B"

        cat >> "$TRANSCRIPT" << EOF
## Final — $SESSION_B

$RESPONSE_B

EOF
        break
    fi

    # --- Prepare message for B ---
    MESSAGE="The other Claude ($SESSION_A session) said:

$RESPONSE_A

Respond to them. Share relevant context from your project. Keep responses focused and under 300 words."

    # --- Session B speaks ---
    echo -e "${BOLD}${GREEN}--- Turn $turn: $SESSION_B ---${NC}"
    RESPONSE_B=$(relay_turn "$FORK_B" "$CWD_B" "$MESSAGE")
    echo "$RESPONSE_B"
    echo ""

    cat >> "$TRANSCRIPT" << EOF
## Turn $turn — $SESSION_B

$RESPONSE_B

EOF

    # Check if B thinks they're done
    if echo "$RESPONSE_B" | grep -qi "conclud\|agreed\|that covers\|nothing more\|wrap up\|summary of decisions"; then
        echo -e "${YELLOW}Session B signaled completion.${NC}"
        break
    fi

    # --- Prepare message for A ---
    MESSAGE="The other Claude ($SESSION_B session) said:

$RESPONSE_B

Respond to them. Share relevant context from your project. Keep responses focused and under 300 words."
done

# Step 8: Finalize transcript
cat >> "$TRANSCRIPT" << EOF

---

*Meeting ended at $(date '+%H:%M'). Transcript saved to $TRANSCRIPT*
EOF

echo ""
echo -e "${BOLD}${CYAN}Meeting complete.${NC}"
echo -e "Transcript saved: ${TRANSCRIPT}"

# Step 9: Inject transcript into original sessions
if [[ "$INJECT" == "true" ]]; then
    echo ""
    echo -e "${DIM}Dropping meeting notes into project directories...${NC}"
    inject_transcript "$SESSION_A" "$TRANSCRIPT" "$TOPIC" "$SESSION_B" "$CWD_A"
    inject_transcript "$SESSION_B" "$TRANSCRIPT" "$TOPIC" "$SESSION_A" "$CWD_B"
    echo -e "${GREEN}Meeting notes written to:${NC}"
    echo -e "  ${CYAN}${CWD_A}/.claude-meeting.md${NC}"
    echo -e "  ${CYAN}${CWD_B}/.claude-meeting.md${NC}"
    echo ""
    echo -e "  Go to each session and say: ${BOLD}Read .claude-meeting.md${NC}"
fi

# Step 10: Clean up forked sessions
echo ""
echo -e "${DIM}Cleaning up forked sessions...${NC}"
ENCODED_A=$(echo "$CWD_A" | sed 's|/|-|g')
ENCODED_B=$(echo "$CWD_B" | sed 's|/|-|g')
rm -f "$CLAUDE_PROJECTS/$ENCODED_A/${FORK_A}.jsonl" 2>/dev/null
rm -f "$CLAUDE_PROJECTS/$ENCODED_B/${FORK_B}.jsonl" 2>/dev/null
# Clean up subagent dirs if they were created
rm -rf "$CLAUDE_PROJECTS/$ENCODED_A/${FORK_A}" 2>/dev/null
rm -rf "$CLAUDE_PROJECTS/$ENCODED_B/${FORK_B}" 2>/dev/null
echo -e "${GREEN}Forked sessions cleaned up.${NC}"

echo ""
echo -e "${BOLD}Done.${NC} To share with your live sessions:"
echo -e "  Paste into each Claude: ${CYAN}Read $TRANSCRIPT${NC}"
echo -e "  Or re-run with ${CYAN}--inject${NC} to auto-open floating panes."
