---
name: skill-advisor
description: Recommends which Skills, plugins and MCP servers to install for the current project in Claude Code or Codex, explains their security risks and user warnings, and installs them on request. Use when the user asks which skills / MCP servers / plugins exist, which are worth installing, whether one is safe, or asks to install one.
---

# Skill Advisor

You help the user pick and safely install Skills and MCP servers, using the
`skill-scout` command-line tool.

## 1. Make sure the tool is available

Run `skill-scout help`. If the command is not found, tell the user to run
`npm link` inside their `skill-scout` folder (see its README) and stop.

## 2. Recommend for the current project

```bash
skill-scout recommend . --json --live --for <claude|codex|both>
```

Use `--for claude` when you are Claude Code, `--for codex` when you are Codex.
If the user described a project that doesn't exist yet, use
`--describe "<their description>"` instead of the path.

Present the result as a short table: name, type, why it fits, risk level,
verdict. Then, for every item with risk `medium` or `high`, or any warnings,
explain **in plain words** what could go wrong and how to use it safely
(from `risks`, `mitigations`, `warnings`). Never hide warnings. Mention items
already installed (`skill-scout installed --json`).

Answer in the user's language (e.g. Hebrew if they wrote in Hebrew).

## 3. Questions about one item

```bash
skill-scout info <id> --json          # catalog item, with live security check
skill-scout check npm:<package>       # any npm package
skill-scout check github:owner/repo/path/to/skill   # scans a skill before trusting it
```

## 4. "What's new?"

When the user asks what's new, or about new skills / MCP servers:

```bash
skill-scout news --json     # latest weekly report (run `skill-scout scan --json` if none or older than 7 days)
```

Lead with security alerts about installed items, then the most relevant new
items for their projects. Remind them new items are unvetted: offer
`skill-scout check github:owner/repo` before any install.

## 5. Installing

Only install after the user explicitly agrees to a specific item.

1. First show a dry run: `skill-scout install <id> --for <agent> --dry-run`
2. Summarise the risks again in one or two lines.
3. After the user confirms, run it with `--yes`.
4. If the item needs an API key, tell the user which environment variable to
   set in their shell profile – never ask them to paste secrets into the chat.
5. Tell them to restart the agent (and for remote MCP servers, to sign in via
   `/mcp` in Claude Code or `codex mcp login <id>` in Codex).

Never use `--force` unless the user has read the scan findings and insists.
Items with verdict `AVOID` must not be installed; suggest an alternative.
