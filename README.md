# OverleafMCP

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)
![Unit Tests](https://github.com/SemPlaatsman/OverleafMCP/actions/workflows/unit-tests.yml/badge.svg)
![Integration Tests](https://github.com/SemPlaatsman/OverleafMCP/actions/workflows/integration-tests.yml/badge.svg)

> Give any MCP-compatible AI assistant direct access to your Overleaf projects.

Overleaf has no public write API. The only programmatic access is through Git. OverleafMCP wraps that Git interface with 19 purpose-built tools, giving your AI assistant the ability to edit LaTeX documents the way a developer would: targeted replacements, not full-file rewrites.

OverleafMCP implements the [Model Context Protocol](https://modelcontextprotocol.io) and is compatible with any MCP client. It has been primarily tested with Claude.

> [!NOTE]
> **Status: work in progress.** Version 1 is in daily use for my own LaTeX reports. Some tested features do not yet work reliably in every case (for example, user experience and usability for LLMs still needs improvements in finding the right tools for the right task). Version 2 is in development, adding improved LLM UX, Git universality, drift detection, search, word count, compile tools, and more.

---

## Features

- Read files, document structure, preamble, postamble, and individual sections from any configured Overleaf project
- Write entire files or replace individual sections with automatic commit and push
- Surgical edits via `str_replace`, `insert_before`, and `insert_after`: no full-file rewrites needed
- BibTeX entry management: get, add, replace, and remove individual entries by cite key
- Git history and diff inspection
- Per-project read-only mode to protect published or archived projects from accidental writes
- Fine-grained tool permissions via `disallowedTools` at global and per-project level
- In-process per-project locking: safe concurrent tool calls with no external dependencies
- Dirty-state recovery: if the server crashes mid-write, staged changes are committed on next startup
- Path traversal protection on all file operations
- No Redis, no Docker required

---

## Why not just copy-paste into your AI assistant?

You can, but you lose context window space, lose the ability to make targeted edits without rewriting whole files, and lose git history. OverleafMCP keeps your document in Overleaf, edits it in place, and commits every change with a message.

## Compared to other Overleaf MCP servers

Most existing implementations are read-only or only support full-file writes. OverleafMCP adds surgical edit tools (`str_replace`, `insert_before`, `insert_after`), BibTeX entry management, fine-grained per-project permissions, and dirty-state crash recovery.

---

## Requirements

- Node.js >= 18
- Git installed and available on `PATH`
- An Overleaf account with Git integration enabled (Overleaf premium feature)

---

## Installation

```bash
git clone https://github.com/SemPlaatsman/OverleafMCP.git
cd OverleafMCP
npm install
cp projects.example.json projects.json
```

Edit `projects.json` with your Overleaf credentials:

```json
{
  "projects": {
    "my-paper": {
      "name": "My Paper",
      "projectId": "YOUR_OVERLEAF_PROJECT_ID",
      "gitToken": "YOUR_OVERLEAF_GIT_TOKEN",
      "readOnly": false
    }
  }
}
```

### Getting your credentials

**Project ID:** Open your project in Overleaf. The ID is in the URL:
`https://www.overleaf.com/project/[PROJECT_ID]`

**Git token:** Go to Overleaf Account Settings, then Git Integration, then create a token.

---

## Configuration

All options have sensible defaults and can be overridden with environment variables:

| Variable | Default | Description |
|---|---|---|
| `PROJECTS_FILE` | `./projects.json` | Path to the projects config file |
| `OVERLEAF_TEMP_DIR` | `./temp` | Directory for local git clones |
| `OVERLEAF_GIT_AUTHOR_NAME` | (git global config) | Git author name for commits |
| `OVERLEAF_GIT_AUTHOR_EMAIL` | (git global config) | Git author email for commits |

Setting `OVERLEAF_GIT_AUTHOR_NAME` and `OVERLEAF_GIT_AUTHOR_EMAIL` is recommended on environments where git is not globally configured, otherwise commits will fail.

---

## MCP client setup

OverleafMCP works with any MCP-compatible client. Add it to your client's configuration using the stdio transport:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/absolute/path/to/OverleafMCP/overleaf-mcp-server.js"],
      "env": {
        "OVERLEAF_GIT_AUTHOR_NAME": "Your Name",
        "OVERLEAF_GIT_AUTHOR_EMAIL": "you@example.com"
      }
    }
  }
}
```

Configuration file locations for common clients:

| Client | Configuration file |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/claude/claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

Restart your client after saving the configuration.

---

## Available Tools

Tools are grouped below by purpose. All write tools support an optional `commitMessage`, a `push` boolean (default `true`), and a `dryRun` boolean (default `false`) that validates inputs and reports sizes without writing anything.

### Project navigation

**`list_projects`**
List all configured projects, including their `readOnly` status and `disallowedTools`.

**`list_files`**
List files in a project. Defaults to `.tex` files; pass `extension` to filter by a different extension (e.g. `".bib"`).

**`status_summary`**
High-level overview of a project: total file count, main file, and section structure.

### Reading LaTeX files

**`read_file`**
Read the full contents of any file.

**`get_sections`**
Get all sectioning commands from a `.tex` file as a hierarchical tree. Each node includes its type (`section`, `subsection`, etc.), title, character offset, the text immediately following that heading (not including children), a 100-character preview, and a `children` array of nested sections. Supports all seven LaTeX levels including starred variants (`\section*{}`).

**`get_section_content`**
Get the text of one named section, starting with its heading line. The optional `scope` parameter sets how far the section reaches:

- `"own"` (default): the heading and the text up to the next heading of any level. Nested subsections are not included; read them by their own titles.
- `"full"`: the heading, its text, and all nested subsections.

The text returned is exactly what `write_section` replaces when called with the same `sectionTitle`, `parentTitle` and `scope`, so a section can be read, edited and written back without affecting anything the read did not show. The last section stops before bibliography commands, acknowledgements and `\end{document}`; those are returned by `get_postamble`.

If the title occurs more than once in the file, the call fails and lists each match with its parent and line number. Supply `parentTitle` (the title of any section that contains the target) to select one.

**`get_preamble`**
Get everything before the first sectioning command: document class declaration, package imports, and custom command definitions. Returns the full file content if no sections exist. Only applicable to `.tex` files.

**`get_postamble`**
Get the closing part of a `.tex` file that follows the last section: bibliography commands (`\bibliographystyle{}`, `\bibliography{}`, `\printbibliography`, a `thebibliography` environment), an acknowledgements block or `\appendix` if present, and `\end{document}`, through to the end of the file. This text belongs to no section, so `write_section` never changes it. Use `str_replace` to edit it. Returns an empty string if the file has none of these (e.g. `\input`'d files). Only applicable to `.tex` files.

### Git inspection

**`list_history`**
Show recent git commits. Supports `limit` (default 20, max 200), `filePath` to filter by file, and `since`/`until` time filters (e.g. `"2.weeks"` or `"2025-01-01"`).

**`get_diff`**
Get a unified diff. Defaults to all changes since the last commit (working tree vs HEAD). Supply `fromRef` and/or `toRef` to diff between specific commits, branches or tags; with only `toRef`, the diff runs from HEAD to that ref. Each ref must name an existing commit, and anything else is refused. Supports `filePaths` array, `contextLines` (default 3, 0 to 10), and `maxOutputChars` (default 120000).

### Writing LaTeX files

**`write_file`**
Overwrite an entire file. Use for new file creation or full-file replacements only. Prefer `str_replace`, `insert_before`, `insert_after`, or `write_section` for targeted edits.

**`write_section`**
Replace one named section in a `.tex` file. The text replaced is exactly what `get_section_content` returns for the same `sectionTitle`, `parentTitle` and `scope`, heading line included, so `newContent` must begin with the section heading.

- `scope: "own"` (default) replaces the heading and the section's own text. Nested subsections stay as they are.
- `scope: "full"` replaces the nested subsections as well: any subsection not repeated in `newContent` is removed.

Bibliography commands, acknowledgements and `\end{document}` after the last section are never part of a section and are left untouched. The call is refused, and nothing is written, when the title matches more than one section (supply `parentTitle`), when `newContent` does not begin with a heading, or when `scope` is `"own"` and `newContent` repeats a subsection that is being kept. Only applicable to `.tex` files.

> **Changed in this version.** `write_section` used to replace a section together with all its subsections, while `get_section_content` returned the section's own text only, without the heading. Writing back what had been read deleted the subsections. Both tools now use the same range and the same default. Pass `scope: "full"` for the previous `write_section` behaviour.

**`str_replace`**
Replace the single unique occurrence of `oldStr` with `newStr` in any file. `oldStr` must match exactly once. If it matches zero or multiple locations, an error is returned with the occurrence count so you can add more surrounding context to make it unambiguous. Setting `newStr` to an empty string deletes `oldStr`. This is the preferred tool for targeted edits anywhere in a file, including the preamble and bibliography commands.

**`insert_before`**
Insert content immediately before the single unique occurrence of `anchorStr`. Same uniqueness rules as `str_replace`.

**`insert_after`**
Insert content immediately after the single unique occurrence of `anchorStr`. Same uniqueness rules as `str_replace`. Useful for appending a new `\usepackage` line after the last existing one.

### BibTeX management

All BibTeX tools operate on `.bib` files. The `entry` and `newEntry` parameters accept a complete raw BibTeX string of any entry type (`@article`, `@book`, `@inproceedings`, `@misc`, etc.).

**`get_bib_entry`**
Get the raw BibTeX block for a single cite key.

**`add_bib_entry`**
Append a new BibTeX entry. The cite key is extracted server-side. Returns an error if the cite key already exists, pointing you to `replace_bib_entry` instead.

**`replace_bib_entry`**
Replace the entry with the given cite key with a new raw BibTeX block. The replacement may use a different cite key if desired.

**`remove_bib_entry`**
Remove the entry with the given cite key. Surrounding whitespace is normalised to keep the file tidy.

---

## Multi-project usage

Add multiple entries to `projects.json` and reference them by key in tool calls:

```json
{
  "defaults": {
    "disallowedTools": []
  },
  "projects": {
    "active-paper": {
      "name": "Current Paper",
      "projectId": "...",
      "gitToken": "...",
      "readOnly": false
    },
    "published-paper": {
      "name": "Published Paper",
      "projectId": "...",
      "gitToken": "...",
      "readOnly": true
    }
  }
}
```

Then pass `projectName: "active-paper"` in any tool call to target a specific project.

### `projectName` selection behaviour

- **Single project configured:** `projectName` can be omitted; the server resolves the project automatically.
- **Multiple projects configured:** `projectName` must be supplied. If omitted, the server returns an error listing the available project keys. This is intentional: silently resolving to the wrong project on a write operation would be worse than an explicit error.

### Read-only projects

Setting `"readOnly": true` on a project allows all read operations but rejects any write operation with a clear error message. The default is `false`, so omitting the field has no effect. This is useful for protecting published or archived papers from accidental edits.

### Fine-grained tool permissions

For more selective control, use `disallowedTools` to block specific tools rather than all writes. This works at two levels.

A `defaults` block at the top of `projects.json` sets the baseline for all projects:

```json
{
  "defaults": {
    "disallowedTools": ["write_file", "remove_bib_entry"]
  },
  "projects": {
    "my-paper": {
      "name": "My Paper",
      "projectId": "...",
      "gitToken": "..."
    }
  }
}
```

A per-project `disallowedTools` array overrides the global defaults entirely for that project:

```json
{
  "defaults": {
    "disallowedTools": ["write_file"]
  },
  "projects": {
    "my-paper": {
      "name": "My Paper",
      "projectId": "...",
      "gitToken": "...",
      "disallowedTools": []
    }
  }
}
```

In this example the global default blocks `write_file`, but `my-paper` overrides it with an empty list, making all tools available.

Resolution order: `readOnly: true` takes precedence over everything and blocks all write tools. Then per-project `disallowedTools` is checked. If absent, it falls through to `defaults.disallowedTools`. If that is also absent, all tools are allowed. The valid tool names are: `write_file`, `write_section`, `str_replace`, `insert_before`, `insert_after`, `add_bib_entry`, `replace_bib_entry`, `remove_bib_entry`.

---

## Safety

**Edits made in Overleaf at the same time.** Every tool call first pulls the latest state from Overleaf. Commits that were made locally with `push: false` are replayed on top of it. If one of them changes the same lines as a newer edit on Overleaf, the Overleaf version is kept: the call fails once with a message that names the files, shows what the local commits had changed, and tells the assistant to re-read before editing again. The local commits are not deleted. They are moved to a git ref named `refs/overleaf-mcp/set-aside/<timestamp>` in the local copy of the project (under `temp/`, or `OVERLEAF_TEMP_DIR`), are never pushed, and can be inspected there:

```bash
git -C temp/<projectId> for-each-ref refs/overleaf-mcp/set-aside
git -C temp/<projectId> show <ref>
```

Nothing on Overleaf is changed by a conflict, and the next tool call works normally.

**The git token.** Tokens are removed from every error message before it reaches the assistant. The `.git` directory of the local copy, which holds the remote address and git's hooks, cannot be read or written through any tool.

---

## Testing

OverleafMCP has a three-layer test suite built on Node.js's built-in `node:test` module — no extra test dependencies required.

**Unit tests** cover pure logic: section and BibTeX parsing, section ranges, path and git-ref validation, token redaction, and anchor uniqueness. They run in under a second with no credentials or network access.

**Local-repository tests** run the git-touching code, and the server itself over stdio, against a bare repository on local disk that stands in for Overleaf. They cover what needs a real repository but cannot be staged safely against a live project: a collaborator pushing a conflicting change, a clone left mid-rebase, a failed clone. They need git, but no credentials or network access, and take under a minute.

`npm test` runs both:

```bash
npm test              # unit + local-repository
npm run test:unit     # unit only
npm run test:local    # local-repository only
```

**Integration tests** run the full tool stack against a live Overleaf project via git, verifying every tool end-to-end including push verification via `listHistory`. They require a `projects.json` with writable and read-only test projects configured:

```bash
npm run test:integration
```

CI runs the unit and local-repository tests on every PR to `dev` and `main`. Integration tests run on PRs to `main` only.

---

## Attribution

See [ATTRIBUTION.md](./ATTRIBUTION.md) for credits to the open-source projects that informed this work.

---

## License

MIT. See [LICENSE](./LICENSE).