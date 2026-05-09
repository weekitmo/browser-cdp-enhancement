# OpenCode compatibility

This repository is a single-skill package, not an OpenCode hook plugin.

Use OpenCode's native skill discovery by copying or symlinking this repository into an OpenCode skills path, for example:

```bash
mkdir -p ~/.config/opencode/skills
ln -s /path/to/browser-cdp-enhancement ~/.config/opencode/skills/browser-cdp-enhancement
```

Then restart OpenCode and load the skill by name:

```text
use skill tool to load browser-cdp-enhancement
```

Notes:

- No OpenCode hook file is needed for this skill.
- The skill's canonical entrypoint is `SKILL.md` at the repository root.
- Supporting files live in `references/`, `scripts/`, and `examples/`.
