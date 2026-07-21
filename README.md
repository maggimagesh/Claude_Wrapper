# claudecode-wrapper

A terminal middleman for Claude Code. You type a prompt the way you'd say it to
a colleague; the wrapper rewrites it into compressed "caveman" notation, hands
that to your local `claude` CLI, and prints the answer back.

It never asks for an API key. It shells out to the `claude` binary already on
your PATH and uses whatever session you already authenticated.

```
$ cw "Hey! I was wondering if you could please help me fix the login bug in
      src/auth.js, it keeps throwing a null token error. Don't change the
      public API though. Thanks so much!"
```

becomes

```
DO FIX
RE auth.js
CTX fix login bug src/auth.js, keeps throw null token err
REQ NO change public api
WANT patch + reason
```

## Install

```bash
npm i @magesh1211/claudecode-wrapper
```

Requires Node 18+ and a working [Claude Code](https://claude.com/claude-code)
install (`npm install -g @anthropic-ai/claude-code`).

## Usage

```bash
cw                        # open the interactive session (default)
cw "your prompt"          # compress and send one prompt
cw -d "your prompt"       # dry run: show the compressed prompt, send nothing
cw -s "your prompt"       # send, but print what was sent first
echo "prompt" | cw        # read from stdin (for scripts/pipes)
```

Both `claudecode-wrapper` and the shorter `cw` are installed.

Run `cw --help` for the full flag list.

## Interactive mode

Running `cw` opens a Claude-Code-style CLI:

```
╭─────────────────────────────────────────────────────────────╮
│ ✻ claudecode-wrapper · cut tokens for Claude Code           │
│                                                             │
│   Type naturally. Your prompt is compressed, sent to        │
│   the claude CLI, and the reply comes back.                 │
│                                                             │
│   model default   reply terse   lean auto   compress on     │
│   /help for commands  ·  Ctrl+C to exit                     │
╰─────────────────────────────────────────────────────────────╯

╭─────────────────────────────────────────────────────────────╮
│ > fix the parser                                            │
│   keep the public API intact                                │
╰─────────────────────────────────────────────────────────────╯
  Enter send · Alt+Enter newline · /help
```

It's a full line editor, not a single-line prompt:

- **Multi-line input** — `Alt+Enter` (or a trailing `\` then Enter) inserts a
  newline; a multi-line **paste** is kept intact instead of submitting each line.
- **Editing** — arrow keys, `Home`/`End`, `Ctrl+A`/`Ctrl+E`, `Ctrl+U`/`Ctrl+K`
  (kill to line start/end), `Ctrl+W` (delete word), `Ctrl+L` (clear screen).
- **History** — `↑`/`↓` walk previous prompts (and move between lines when the
  prompt spans several).
- **Turns are threaded** — one persistent Claude Code session backs the whole
  conversation, so context carries over without repeating it.

Every turn prints a savings footer so you can watch the compression live.

### Real tools, with permission prompts

Interactive mode runs a full Claude Code session — Claude can read files, edit
them, and run commands, streaming its activity as it goes:

```
❯ create a file note.txt containing hello
I'll create the file.
● Write(note.txt)
  Allow this action?
  ❯ Yes
    Yes, and don't ask again for Write
    No, tell Claude what to do differently
  → allowed
  ⎿ File created successfully at: note.txt
```

When Claude wants to use a tool that changes something, **the wrapper shows the
same allow / allow-always / deny prompt Claude Code would**, and sends your
choice back so Claude continues. Use `↑`/`↓` + `Enter`, or the `y` / `a` / `n`
shortcuts. Read-only tools (Read, Grep, Glob, …) are auto-approved, and an
"allow always" is remembered for the rest of the session — matching Claude
Code's behaviour. Permission decisions are routed through a small MCP permission
server over a private local socket; nothing leaves your machine.

> **Token note:** to use tools, Claude Code must load its tool definitions
> (~15k input tokens/turn), so lean mode does **not** apply in interactive mode —
> the savings there come from prompt compression only. For cheap knowledge
> questions, one-shot `cw "question"` still drops the tools and leans.

### Slash commands

| command                | what it does                                          |
| ---------------------- | ----------------------------------------------------- |
| `/help`                | list commands and key bindings                        |
| `/lean [auto\|off]`    | drop tool definitions to cut ~80% of input tokens     |
| `/raw`                 | toggle compression on/off (send your prompt verbatim) |
| `/reply terse\|normal` | how Claude writes back                                |
| `/model <name>`        | `opus`, `sonnet`, `haiku`, or a full model id         |
| `/show`                | echo the compressed caveman prompt each turn          |
| `/stats`               | toggle the savings footer                             |
| `/new`                 | forget the current session and start fresh            |
| `/clear`               | clear the screen                                      |
| `/exit`                | quit                                                  |

## What it actually does

**1. Builds a clearer prompt.** It classifies the request into an action
(`FIX`, `ADD`, `EXPLAIN`, `REVIEW`, …), pulls out the files and symbols you
named, lifts hard constraints into a `REQ` line, and states the expected
deliverable in `WANT`. Vague prompts come out more specific than they went in,
which is the half of the job that has nothing to do with token count.

**2. Cuts tokens.** Two separate levers, and they are very different in size.

## With `cw` vs without: measured

The numbers below are real, not estimated — the same prompt sent straight to
`claude -p` versus through `cw`, both counted from the input-token usage the
`claude` CLI (v2.1.216) reported for the call.

| prompt (same both ways)                 | no `cw` | with `cw` | Δ tok | cost no `cw` | cost `cw` | answer |
| --------------------------------------- | ------: | --------: | ----: | -----------: | --------: | ------ |
| closures, in 3 sentences (knowledge)    |  15,598 |     3,110 |  −80% |      $0.0924 |   $0.0366 | same   |
| `git rebase --onto`, 1 paragraph (repo) |  15,784 |    15,887 |   +1% |      $0.0759 |   $0.0969 | same   |

Two prompts, two regimes — and the difference between them is the whole story.

**When it wins big (knowledge questions):** the first prompt names no file, so
`cw` classifies it as `EXPLAIN` and drops Claude's built-in tool definitions
("lean mode"). Those schemas — not your words — are ~15k of the ~15.6k input
tokens on a bare question. Remove them and the bill falls **80%**, for the same
answer. Prompt compression contributes on top, but it is the smaller lever.

**When it's roughly break-even (anything touching your repo):** the second
prompt mentions a `--onto` flag, so `cw` conservatively keeps the tools (Claude
might need them). With the 15k tool baseline unavoidable, compressing the prompt
text saves only a few tokens, and the short protocol note `cw` appends can even
tip it slightly higher. **The answer is the same; the cost is a wash.** This is
the honest ceiling: a tool that claims a flat 90% on repo work is only measuring
the part that was never expensive.

Result quality across both: **unchanged** — Claude decodes the caveman notation
losslessly, and the terse register trims the reply without dropping substance.
`cw` never made an answer worse in these runs; on the closures question the
compressed run was actually a touch more complete, flagging the `var`/`let`
binding gotcha.

### The prompt-compression lever on its own

Independent of tools, the rewrite shrinks the prompt text itself. Measured on the
compressor directly (deterministic, no API call):

| your prompt                            |  before |   after |    saved |
| -------------------------------------- | ------: | ------: | -------: |
| polite bug report naming `src/auth.js` |      42 |      20 |     −52% |
| refactor, keep the public API          |      37 |      23 |     −38% |
| explain closures / scope chain         |      25 |      16 |     −36% |
| add retry+backoff to `src/net.js`      |      37 |      30 |     −19% |
| unit test for `parseConfig`            |      25 |      18 |     −28% |
| **overall**                            | **166** | **107** | **−36%** |

Code, paths, identifiers, flags, and error strings are preserved byte-for-byte,
so a prompt that is mostly code barely moves — and an already-terse prompt is
left alone rather than padded with invented savings.

### Reading the stats line

The `·` line after each reply shows both levers, so you always know which regime
you're in:

```
· prompt 33 -> 29 est tokens -12% | 2.9k in total | lean | $0.0456 | 11.4s
```

`prompt` is the estimated text compression; `in total`, `lean`, and the cost are
the real figures the `claude` CLI reported for that call.

### When lean applies

Lean mode is automatic, but only when it's safe — with tools off, Claude can't
read files or run commands, so a wrong guess is a broken answer, not a cheap one.
It kicks in for `EXPLAIN` / `ADVISE` / `PLAN` questions that name no file, path,
or flag; anything that might touch your repo keeps its tools. Override either way
with `--lean` / `--no-lean`, or `/lean` in the session.

> Interactive mode always needs tools, so lean doesn't apply there — the win in a
> session comes from prompt compression alone. For cheap knowledge questions,
> one-shot `cw "question"` is where the 80% lives.

## Caveman notation

| slot   | meaning                                                                  |
|--------|--------------------------------------------------------------------------|
| `DO`   | the action: FIX, ADD, EXPLAIN, REFACTOR, TEST, REVIEW, FIND, OPTIMIZE, … |
| `RE`   | files and symbols in scope                                               |
| `CTX`  | the situation, compressed                                                |
| `REQ`  | hard constraints, prefixed `NO` / `MUST` / `ONLY` / `KEEP`               |
| `WANT` | expected deliverable                                                     |

Short prompts skip the slots entirely and go out as a single line — the labels
cost about eight tokens, which is not worth paying on a six-word request.

A short protocol note is appended to Claude's system prompt so it decodes the
notation reliably and answers in the same register. Use `--reply normal` if you
want ordinary prose back.

### What is never compressed

Dropping the wrong word here silently changes the request, so these are
protected:

- fenced and inline code, verbatim
- file paths, URLs, quoted strings, CLI flags
- camelCase / snake_case / CONSTANT identifiers, function calls
- version numbers, hex, HTTP status codes
- **negations** — `not`, `no`, `never`, `without`, `only`, `unless`, and every
  `don't`/`can't` contraction
- **conditionals** — `if` is deliberately kept, because "if the tests fail,
  revert" means the opposite without it

Unfenced code indented with spaces is the one gap: it is reflowed, because
telling it apart from wrapped prose needs a heuristic, and a wrong guess there
silently disables compression for the whole prompt. Fence your code blocks.

## Config

Save your preferred defaults to `~/.config/claudecode-wrapper/config.json`:

```bash
cw --reply normal --model sonnet --config
```

## Programmatic use

```js
import { compress, ask } from 'claudecode-wrapper';

const { prompt, before, after } = compress('could you please fix the login bug?');
const { text, usage } = await ask(prompt);
```

## Notes

- Anything after `--` is passed straight through to `claude`.
- The wrapper reads no credentials and stores nothing but your config file.
- `-c` continues the last session in the directory; `cw -i` keeps one session
  across turns.

## License

MIT
