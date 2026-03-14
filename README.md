# OverleafMCP

An MCP (Model Context Protocol) server that gives Claude direct access to Overleaf projects through Git integration. Read, write, and surgically edit LaTeX documents and BibTeX bibliographies without leaving your conversation.

---

## Features

- Read files, document structure, preamble, postamble, and individual sections from any configured Overleaf project
- Write entire files or replace individual sections with automatic commit and push
- Surgical edits via `str_replace`, `insert_before`, and `insert_after` — no full-file rewrites needed
- BibTeX entry management: get, add, replace, and remove individual entries by cite key
- Git history and diff inspection
- Per-project read-only mode to protect published or archived projects from accidental writes
- In-process per-project locking: safe concurrent tool calls with no external dependencies
- Dirty-state recovery: if the server crashes mid-write, staged changes are committed on next startup
- Path traversal protection on all file operations
- No Redis, no Docker required

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

## Claude Desktop Setup

Add to your Claude Desktop configuration file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/claude/claude_desktop_config.json`

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

Restart Claude Desktop after saving the configuration.

---

## Available Tools

Tools are grouped below by purpose. All write tools support an optional `commitMessage`, a `push` boolean (default `true`), and a `dryRun` boolean (default `false`) that validates inputs and reports sizes without writing anything.

### Project navigation

**`list_projects`**
List all configured projects, including their `readOnly` status.

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
Get the full content of a specific named section. Supply the optional `parentTitle` parameter to disambiguate when the same section title appears under multiple parent sections.

**`get_preamble`**
Get everything before the first sectioning command: document class declaration, package imports, and custom command definitions. Returns the full file content if no sections exist. Only applicable to `.tex` files.

**`get_postamble`**
Get everything from `\end{document}` (inclusive) to the end of the file. Returns an empty string if `\end{document}` is absent (e.g. `\input`'d files). Note that bibliography commands (`\bibliography{}`, `\printbibliography`) appear before `\end{document}` and fall within the last section's content range — use `str_replace` to edit them. Only applicable to `.tex` files.

### Git inspection

**`list_history`**
Show recent git commits. Supports `limit` (default 20, max 200), `filePath` to filter by file, and `since`/`until` time filters (e.g. `"2.weeks"` or `"2025-01-01"`).

**`get_diff`**
Get a unified diff. Defaults to all changes since the last commit (working tree vs HEAD). Supply `fromRef` and/or `toRef` to diff between specific commits or branches. Supports `filePaths` array, `contextLines` (default 3, max 10), and `maxOutputChars` (default 120000).

### Writing LaTeX files

**`write_file`**
Overwrite an entire file. Use for new file creation or full-file replacements only. Prefer `str_replace`, `insert_before`, `insert_after`, or `write_section` for targeted edits.

**`write_section`**
Replace a single named section in a `.tex` file. Only the named section is replaced; everything else is untouched. The boundary is level-aware: the section ends where the next command of equal or higher level begins, or at `\end{document}` if there is none. Only applicable to `.tex` files.

**`str_replace`**
Replace the single unique occurrence of `oldStr` with `newStr` in any file. `oldStr` must match exactly once — if it matches zero or multiple locations, an error is returned with the occurrence count so you can add more surrounding context to make it unambiguous. Setting `newStr` to an empty string deletes `oldStr`. This is the preferred tool for targeted edits anywhere in a file, including the preamble and bibliography commands.

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

The resolution order is: `readOnly: true` (blocks all writes, takes precedence over everything) → per-project `disallowedTools` → global `defaults.disallowedTools`. Omitting `disallowedTools` at either level falls through to the next. The valid tool names are the same names used in tool calls: `write_file`, `write_section`, `str_replace`, `insert_before`, `insert_after`, `add_bib_entry`, `replace_bib_entry`, `remove_bib_entry`.

---

## Attribution

See [ATTRIBUTION.md](./ATTRIBUTION.md) for credits to the open-source projects that informed this work.

---

## License

MIT. See [LICENSE](./LICENSE).