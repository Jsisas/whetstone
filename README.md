# Whetstone

Whetstone is an [omp](https://github.com/can1357/oh-my-pi) plugin that keeps you in control of AI-assisted coding and keeps your own skills sharp. Start a task with `/whet task <description>` and the session becomes a guided workflow: the agent must submit a step plan before touching code; every step has an owner (ME = you, AI = the agent); AI steps are confined to the files they declared and a line budget; during your steps the agent can only pair with you and its code is rationed through a hint ladder; a failing test or build makes you name the cause before anything is fixed; advancing needs staging plus a short quiz on the diff. Every step is logged locally, so `/whet stats` shows where your skills are rusting. While a task is active the agent explains its reasoning and adds `★ Insight` notes.

Nothing is project-specific: defaults cover JS/TS, Python, Rust, Go, JVM, C/C++ and .NET.

## Workflow

```text
1. /whet task <description>   The agent reads the code and submits a step plan. It cannot edit yet.
2. Approve the plan            Flip any step between ME (you write it) and AI (the agent writes it).
3. AI step                     The agent edits only the files the step declared, within the line budget.
                               Test files stay locked until you write the cases: /whet cases.
4. ME step                     You write the code; the agent pairs with you but cannot edit.
                               Its code blocks are withheld: /whet hint for generic examples, /whet show for your code.
5. A test or build fails       Debug mode: the agent asks for your hypothesis. /whet found <cause> unlocks the fix.
6. Review                      Stage what you accept (git add), then /whet next and answer a short quiz on the diff.
7. Repeat until the plan is done; you commit.
```

| Command | What it does |
| --- | --- |
| `/whet task <desc>` | start a task (planning mode) |
| `/whet cases` | write test cases; unlocks test files in an AI step |
| `/whet hint` | ME step: allow generic code examples |
| `/whet show` | ME step: allow code about your own codebase |
| `/whet debug` | enter debug mode manually |
| `/whet found <cause>` | name the cause of a failure; leaves debug mode |
| `/whet done` | ME step: you are finished; the agent reviews your diff |
| `/whet next` | staging check + quiz, then the next step |
| `/whet skip` | skip the quiz (logged) |
| `/whet status` | current task, step, owner, hint level |
| `/whet stats [all]` | your ME/AI share, debugging, quizzes, skill-rust warnings (this repo or all) |
| `/whet off` / `/whet on` | disable/enable Whetstone for this session (off cancels the task) |
| `/whet init [user]` | write a commented config: `.omp/whetstone.yml`, or with `user` `~/.omp/agent/whetstone/config.yml` |
| `/whet help` | the workflow and command list |

Inside a task the agent never runs git writes; staging and committing are yours. Outside a task Whetstone does nothing unless `alwaysOn: true`, in which case protected paths and the no-agent-git-writes rule apply in every session.

## Install

- From GitHub: `omp plugin install github:jsisas/whetstone`
- From its marketplace: `omp plugin marketplace add jsisas/whetstone`, then `omp plugin install whetstone@jsisas`
- From npm (once published): `omp plugin install omp-whetstone`
- For development: `omp plugin link /path/to/whetstone`

## Configuration

Files, lowest to highest precedence: built-in defaults, `~/.omp/agent/whetstone/config.yml` (user), `<repo>/.omp/whetstone.yml` (project). Mappings merge, lists and scalars replace. `/whet init` writes a commented template. The project file lives under `.omp/`, which the agent may never write.

| Key | Default | Meaning |
| --- | --- | --- |
| `alwaysOn` | `false` | apply protected paths and the git-write ban in every session, not only inside a task |
| `explanatory` | `true` | explanatory output style (reasons, `★ Insight` notes) while a task is active |
| `corePaths` | `[]` | globs for code you must own; plan steps touching them become ME steps |
| `testPatterns` | common test globs for each language | test files; locked in AI steps until `/whet cases` |
| `protectedPaths` | `[]` | extra globs the agent may never write; CI config, `.omp/`, `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, lockfiles, migrations and the plugin's own directory are always protected |
| `budget.lines` | `150` | maximum changed lines per step |
| `budget.files` | `3` | maximum files per step |
| `quiz.length` | `3` | questions per quiz; `0` disables quizzes |
| `quiz.passRatio` | `0.67` | you pass with at least `ceil(length × passRatio)` right answers (3 of 3 at the defaults; `0.66` makes it 2 of 3) |
| `allowedCommands` | common read-only, build and test tools | commands the agent may run without asking; anything else, any `>` redirection, `tee`, `sudo`, or `--fix`/`--write` flags need your confirmation |
| `testCommands` | common build and test tools | commands whose failure starts debug mode |
| `extraReadOnlyTools` | `[]` | extra omp tools allowed in every phase (they must not write files) |
| `extraShellTools` | `[]` | extra tools whose `command` argument is checked for git writes like `bash` |
| `targetMeRatio` | `0.4` | the share of steps you want to own, compared in `/whet stats` |
| `rustWeeks` | `4` | `/whet stats` warns when an area had no ME step for this many weeks |

Globs are matched against repo-relative paths: `**/` matches any depth, `*` stays within one directory, and patterns are anchored at the repository root (`AGENTS.md` is only the root file; `**/AGENTS.md` is any).

## Data

Every event is appended to `~/.omp/agent/whetstone/log.jsonl` (directory mode `0700`). Nothing is written inside your repositories, except the config file `/whet init` creates when you ask. Task state is stored in the omp session, so `omp --resume` continues at the same step.

## Limits

- One task per omp process.
- Enforcement covers omp's own tools only. Your shell, editor and other programs are not restricted, and commands you approve run as you.
- Allowed commands are trusted as written: a test runner or build script can still change files.
- While you own a step, the agent's code blocks are withheld from what you see and from the session history. To withhold them while they stream, Whetstone turns on omp's `extensionRenderers.assistantText` setting for the step, as a runtime-only override that is never saved.
- Quizzes and grading use omp side turns; on hosts without them you get fixed questions and grade yourself.

## Development

```bash
bun install
bun test
bun run check
```

## License

MIT
