# Antigravity prompt — install and verify CrewPilot skills

```text
We are working in the existing local clone of vincenzo-afk/CrewPilot. Create a project-specific Antigravity skills library using the current official Antigravity Skills format.

Before editing:
1. Run git status --short --branch and inspect existing AGENTS.md, .agents/skills, and .agents/rules.
2. Preserve all existing user/team changes. Do not overwrite any existing skill, rule or AGENTS.md without presenting a merge plan first.
3. Antigravity workspace skills belong at .agents/skills/<skill-name>/SKILL.md. Each SKILL.md must begin with YAML frontmatter containing a unique lowercase name and a clear description.
4. If this repository already contains the skill-kit files, use those exact files; otherwise create the following focused skills: python-engineering, switch-protocol, test-driven-development, github-workflow, security-audit, code-review, hackathon-evidence.
5. Follow the current official Switch protocol source. The hackathon overview and source checked on 2026-11-01 specify SSE down and HTTP up. Do not introduce a WebSocket migration unless current official docs and the target server version prove it necessary.
6. Do not create a .agents/rules file without valid Antigravity trigger frontmatter. Prefer a root AGENTS.md for always-on project instructions. If AGENTS.md already exists, merge only after reviewing its content.

The rules must cover the existing CrewPilot baseline, hackathon phase gate (no new multi-agent Switch workflow before 2026-11-04 00:01 IST), branch protection, verified milestone commits/pushes, prompt-injection safety, human approval, test gates and honest evidence.

Do not implement product features, modify existing application source, change runtime dependencies, register Switch agents or create GitHub issues/PRs. After creation, list every file, validate each frontmatter block and report the exact skill paths and how to invoke them (/<skill-name>). Stop for review.
```
```

If you extracted the starter kit, the seven skill files and `AGENTS.md` are already present; use Antigravity to inspect and validate them instead of creating duplicates.
