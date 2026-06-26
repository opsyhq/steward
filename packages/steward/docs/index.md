# Steward Documentation

Steward is a persistent, purposeful agent that runs in your terminal. It stays small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, and integrations.

## Mental model

A Steward agent is not a chat session. It is created *for* something — a purpose stated by its human at birth — and that purpose becomes the organizing principle for its life. An agent:

- **Has a purpose.** You give it one when you birth it; it distills and keeps it.
- **Persists.** It remembers across conversations and picks up where it left off, instead of starting from scratch each time.
- **Curates its own memory.** It maintains durable notes about its work (`MEMORY.md`), facts about its human (`USER.md`), and its own identity (`SOUL.md`).
- **Lives in its own home.** All of its state — sessions, memory, and customizations — lives under one per-agent directory, so deleting the agent cleans up everything attached to it.

```
$ steward new calories
agent: What is my purpose?
you:   Help me count calories and lose weight.
```

That answer becomes the agent's purpose. The rest of these docs are about birthing an agent, talking to it, and extending it.

## Lifecycle: forming → deployed

Every agent has two phases, and the transition between them is the one ordering constraint you must understand:

- **Forming.** A newly created agent is *not yet deployed*. Its only job is to understand its purpose and its human. It interviews you one question at a time, recording what it learns. It does **not** act unattended and does not start doing the job — first it becomes itself.
- **Deployed.** When you both agree it understands its purpose, it (or you, via `/deploy`) deploys it: it writes a final `SOUL.md` and begins working.

> **Deployment is the single human-held latch.** Until an agent is deployed it maintains its own files but may not act on its own. This is intentional — birth the agent, talk through its purpose, then deploy.

For the full lifecycle, sessions, system prompt, and agent home layout, see the [package README](../README.md).

## Quick start

Install Steward with npm:

```bash
npm install -g @opsyhq/steward
```

Then birth a new agent and start its birth conversation:

```bash
steward new <name>
```

The agent opens by asking what it is for. Answer conversationally — it interviews you, records what it learns, and distills its own purpose. When you both agree it understands its job, deploy it (it offers to, or type `/deploy`) and it begins working.

Reconnect to a deployed agent any time with `steward <name>`; it resumes its latest session. For a one-shot, non-interactive reply add `--print`:

```bash
steward <name> "log: two eggs and toast" --print
```

### Authentication

Authenticate with `/login` for subscription/OAuth providers (Claude and others). Setting an API key such as `ANTHROPIC_API_KEY` in the environment is the alternative. Either works with no extra setup. Credentials persist to the shared `~/.steward/agent/auth.json` and are reused by every agent.

### Where state lives

Each agent keeps everything in its own home under `~/.steward/agents/<name>/` — its identity, curated memory, append-only session tree, workspace, and per-agent customizations (`extensions/`, `skills/`, `prompts/`, `themes/`). Credentials are shared at `~/.steward/agent/`. Override the root with `STEWARD_HOME` (defaults to `~/.steward`).

For the package overview, CLI flags, sessions, system prompt, and the full agent-home layout, see the [package README](../README.md).

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Integrations](integrations.md) - connect external services and message channels to the agent.

## Programmatic usage

- [SDK](sdk.md) - embed steward in Node.js applications.
