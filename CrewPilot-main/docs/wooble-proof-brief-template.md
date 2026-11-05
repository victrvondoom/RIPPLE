# Wooble Proof Brief — CrewPilot submission template

Use this as a drafting worksheet for the five-step Wooble submission. Replace every bracketed field with verified project information. Do not claim planned or unverified functionality as implemented.

## 1. Start — Project identity

- **Project name:** CrewPilot — Evidence-Driven Bug Investigation Squad
- **Project type:** Software (app, API, tool or bot)
- **Challenge:** Flip the Switch Hackathon
- **Track:** Best Business Workflow

## 2. Show it — Visual proof

- **Walkthrough:** Upload a real screen recording, maximum 5 minutes; accepted formats shown in the portal are MP4, MOV or WebM, up to 500 MB.
- **Cover image:** 16:9 project cover.
- **Gallery:** Up to five genuine screenshots. Suggested screenshots: (1) shared Switch room and human participant, (2) three distinct agent identities, (3) reproduction evidence, (4) review and approval, (5) actual Draft PR. Include only screens that exist.

### Five-minute demo structure

- **0:00–0:30 — Problem:** Show a real bug report and why reproduction/evidence/review are important.
- **0:30–1:00 — Switch:** Show the chat room, human and distinct agents. Explain that Switch carries the collaboration and handoffs.
- **1:00–2:00 — Triage and reproduction:** Show the issue brief, human scope approval, exact reproduction command and actual failure output.
- **2:00–3:30 — Fix and review:** Show the isolated code change, test results, Reviewer findings and any real revision.
- **3:30–4:30 — Human-controlled delivery:** Show final authorization and the real Draft PR if implemented and verified.
- **4:30–5:00 — Reproducibility and impact:** Show README setup, quality checks and a concise summary.

## 3. Explain it — Project story

### The problem (Problem Understanding)

Software teams often receive bug reports that describe symptoms without enough evidence to reproduce the failure. Developers must manually investigate the repository, identify a reliable reproduction, implement a fix, run regression tests and review the patch. When these activities happen across disconnected tools or isolated AI chats, context and accountability are easily lost.

### The approach (Execution Quality, Originality, Depth)

CrewPilot brings the developer and independent AI engineering agents into a shared team-chat workflow connected by Switch. The Triager converts an issue into a task brief and requests human approval. The Reproducer/Builder then attempts to reproduce the failure in an isolated workspace, records exact evidence, and implements the approved fix. An independent read-only Reviewer inspects the actual diff and test evidence. Agents exchange task-specific handoffs through Switch, while SQLite records durable task state and approvals. A separate human approval is required before the publisher creates a GitHub Draft PR.

Edit this section to match the actual implementation. Remove any feature that is not working in the submitted version.

### The result (Execution Quality)

Report only measured results from a genuine run. Fill in the following after the end-to-end workflow has been verified:

- **Completed workflow:** [issue URL/number and task ID]
- **Reproduction evidence:** [exact command and observed failure]
- **Fix evidence:** [branch, commit SHA and files changed]
- **Testing:** [exact test command, passed/failed count and exit code]
- **Independent review:** [PASS or CHANGES_REQUESTED and reviewed commit SHA]
- **Delivery:** [real Draft PR number and URL, if created]

### Reflection (Depth, Communication)

Explain what worked, what failed, what you changed after testing, how Switch shaped the collaboration, what limitations remain, and what you would improve next. Distinguish live integration evidence from mocked tests.

## 4. Your part & links

### Your role (maximum 60 characters)

Suggested draft to confirm: `Backend & AI Workflow Engineer`

### Team

Enter each teammate's real contribution in one line. Each teammate must confirm their own role in the portal. Do not assign unconfirmed responsibilities.

- Team captain: [confirmed contribution]
- Kamalesh Kumar: [confirmed contribution]

### One-liner (maximum 160 characters)

Suggested draft: `CrewPilot turns GitHub bug reports into reproducible, tested and independently reviewed fixes through human-led AI collaboration in Switch.`

### Key outcomes (up to three)

Use only evidence-backed statistics. Examples of possible measures (do not invent values):

- Reproduction success rate: [x/y issues]
- Regression test pass rate: [x/y tests]
- End-to-end task completion time: [measured duration]

If you have no defensible metrics, leave these blank rather than estimating.

### Technologies & tools

Select only those actually used: Python, Switch, Discord or Mattermost, SQLite, GitHub API, pytest, Ruff, and the actual LLM provider(s). Add Antigravity and other AI coding tools in the AI tools field when applicable.

### AI tools used / what they were used for

List the real tools and explain their contribution (for example: Antigravity for code implementation and tests; ChatGPT for planning/review; Groq/OpenAI/Anthropic for runtime agent reasoning). Do not list a tool that was not used.

### Links

- GitHub repository: [public URL]
- Demo video: [accessible video URL, if separately requested]
- Live site: [URL, only if deployed]

### Notes for reviewers (private field in portal)

Provide clean setup steps, environment variable names (never secret values), any test accounts/data, the exact demo task, and limitations reviewers should know.

## 5. Review before final submission

- [ ] Project name and Software category are correct.
- [ ] Walkthrough video is uploaded and under five minutes.
- [ ] Cover image is 16:9; screenshots are genuine and readable.
- [ ] Project story contains all four sections and exceeds 150 characters.
- [ ] Role is within 60 characters; one-liner is within 160 characters.
- [ ] Team roles are accurate and teammates have confirmed them.
- [ ] Outcomes contain real measurements only.
- [ ] Technologies, links and AI tools reflect actual usage.
- [ ] Public GitHub repository, README and reproducible setup are available.
- [ ] No credentials, private data, fabricated evidence or unsupported claims appear.
- [ ] Final preview is checked and the correct project is submitted before the deadline.
- [ ] Save the actual submission confirmation/receipt.
