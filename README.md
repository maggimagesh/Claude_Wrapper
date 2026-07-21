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
npm install -g claudecode-wrapper
```

Requires Node 18+ and a working [Claude Code](https://claude.com/claude-code)
install (`npm install -g @anthropic-ai/claude-code`).

## Usage

```bash
cw "your prompt"          # compress and send
cw -d "your prompt"       # dry run: show the compressed prompt, send nothing
cw -s "your prompt"       # send, but print what was sent first
cw -i                     # interactive session
echo "prompt" | cw        # read from stdin
```

Both `claudecode-wrapper` and the shorter `cw` are installed.

Run `cw --help` for the full flag list.

## What it actually does

**1. Builds a clearer prompt.** It classifies the request into an action
(`FIX`, `ADD`, `EXPLAIN`, `REVIEW`, …), pulls out the files and symbols you
named, lifts hard constraints into a `REQ` line, and states the expected
deliverable in `WANT`. Vague prompts come out more specific than they went in,
which is the half of the job that has nothing to do with token count.

**2. Cuts tokens.** Two separate levers, and they are very different in size.

## Honest numbers

The headline goal for this tool was a 90% cut. Here is what is actually
achievable, measured rather than estimated.

### Prompt compression: 25–70%

Filler removal, stopword stripping, and abbreviation, measured across a sample
of realistic prompts:

| prompt style | before | after | saved |
|---|---:|---:|---:|
| padded, polite bug report | 98 | 28 | 71% |
| plain question | 51 | 22 | 57% |
| review request | 57 | 25 | 56% |
| feature request with constraints | 77 | 57 | 26% |
| refactor with a pasted code block | 76 | 67 | 12% |
| already terse (`fix login bug`) | 4 | 4 | 0% |
| **overall** | **363** | **203** | **44%** |

Two hard ceilings. Code, paths, identifiers, and error strings are preserved
byte-for-byte, so a prompt that is mostly code barely moves. And a prompt with
no padding has nothing to remove — the wrapper correctly leaves it alone rather
than inventing savings.

### Lean mode: ~80%

This is the lever that matters, and it is not about your words at all.

A trivial prompt sent through Claude Code costs about **15,400 input tokens** on
this machine. The prompt itself is five of them. The rest is the system prompt
and the built-in tool schemas. Compressing a 50-token prompt to 20 saves 30
tokens out of 15,400 — around 0.2%.

Dropping the tool definitions changes the picture:

| | input tokens | cost |
|---|---:|---:|
| default | 15.7k | $0.081 |
| lean | 2.9k | $0.046 |

Same question, same answer quality: **82% fewer input tokens.**

The catch is real: with tools disabled Claude cannot read files or run commands.
So lean mode is applied **automatically only when it is safe** — for
`EXPLAIN` / `ADVISE` / `PLAN` questions that name no file or path. Anything that
might need to touch your repo keeps its tools. Force it either way with
`--lean` / `--no-lean`.

### So: is 90% real?

For a padded, knowledge-only question — "hey, could you explain what a closure
is, thanks!" — yes, roughly: ~80% from lean mode plus prompt compression on top,
and terse replies cut output tokens too.

For "fix the failing test in src/parser.js", no. That request needs the tools,
and the tools are the bill. Expect 25–60% on the prompt text, which is a small
slice of a large total. Any tool claiming a flat 90% on that second case is
measuring only the part that was never expensive.

The `·` stats line after each reply shows both figures, so you can see which
case you are in:

```
· prompt 33 -> 29 est tokens -12% | 2.9k in total | lean | $0.0456 | 11.4s
```

`prompt` is estimated. `in total` and the cost are the real numbers Claude Code
reported for that call.

## Caveman notation

| slot | meaning |
|---|---|
| `DO` | the action: FIX, ADD, EXPLAIN, REFACTOR, TEST, REVIEW, FIND, OPTIMIZE, … |
| `RE` | files and symbols in scope |
| `CTX` | the situation, compressed |
| `REQ` | hard constraints, prefixed `NO` / `MUST` / `ONLY` / `KEEP` |
| `WANT` | expected deliverable |

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
