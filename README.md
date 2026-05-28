# skills

A small monorepo of Claude AI "skills" — markdown-driven workflow definitions
that an LLM agent loads on demand to handle a specific class of task.

Each top-level folder is one skill. Every skill has a `SKILL.md` at its root
that declares the skill's frontmatter (`name`, `description`) and body
(triggers, inputs, outputs, hard rules, worked examples). Some skills also
ship companion artefacts under `prompts/` and `docs/`.

## Skills in this repo

| Skill | What it does |
| --- | --- |
| [`atlassian-sync`](./atlassian-sync) | Pulls Confluence pages (and Jira projects) from any Atlassian Cloud tenant into a local cache or a single shareable HTML/MD file. SSO-cookie auth (API token fallback), layered content-safety pipeline to avoid AV quarantine, single-file search index instead of recursive grep. Node 18+, no native deps. |
| [`campaign-orchestrator`](./campaign-orchestrator) | End-to-end orchestrator for a 6-stage Databricks "campaign" pipeline. Dispatches to the other three skills below. Driven by a slash-style `/campaign <verb>` command (init, stage, status, verify, extract-intake). |
| [`intake-extractor`](./intake-extractor) | Reverse-engineers a draft `intake.md` from an existing campaign folder by scanning its notebooks. |
| [`schema-verifier`](./schema-verifier) | Runs `DESCRIBE TABLE` against Unity Catalog via the `databricks` CLI and answers "does this table/column exist? what's its type?". Caches results to avoid repeated cluster round-trips. |
| [`deploy-verifier`](./deploy-verifier) | Closes the loop between local notebook edits and a Databricks cluster run via the git-sync workflow (push → workspace pull poll → one-shot job run → row-count assertion). |

## About the worked examples

These skills illustrate patterns useful in regulated data environments
where LLM agents need to author SQL, edit notebooks, and verify deployments
against a live Unity Catalog. Examples use generic placeholder schemas
(`policies`, `agent_master`, `paid_through_dt` vs `pt_thru_dt`, etc.) and
pre-canned LLM-hallucination → correction pairs as a *structural template*
for what each skill is meant to enforce.

If you fork these skills, you should:

1. Replace `<your-cluster-id>`, `<your-user>@<your-domain>`,
   `<source_catalog>.<source_schema>.*`, etc. with your real identifiers
   (or wire them to environment variables / CLI flags).
2. Replace the placeholder column-pair examples in `schema-verifier` with
   the equivalent real-world hallucinations from your own schema once
   you've accumulated them.
3. Update each `SKILL.md` `description` field so your agent's skill-search
   surfaces the skill on your team's trigger phrases.

## How a skill is loaded

The exact mechanism depends on the agent runtime. In Claude Code / GitHub
Copilot CLI, an `<available_skills>` block lists each skill with its name +
description; the agent invokes a skill by name (e.g.
`skill: "campaign-orchestrator"`) when the description matches the user's
intent. Each skill should be self-contained: the agent loads `SKILL.md`
and follows the workflow it describes.

See each skill's own `SKILL.md` for invocation details.

## Licence

MIT — see [LICENSE](./LICENSE).
