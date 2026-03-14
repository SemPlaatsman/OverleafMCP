# OverleafMCP

An MCP (Model Context Protocol) server that gives Claude direct access to Overleaf projects through Git integration. Read, write, and surgically edit LaTeX documents without leaving your conversation.

---

## Features

- Read files, sections, and document structure from any configured Overleaf project
- Write entire files or individual sections with automatic commit and push
- Surgical edits via `str_replace`, `insert_before`, and `insert_after` (coming soon)
- BibTeX entry management (coming soon)
- Git history and diff inspection (coming soon)
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
      "gitToken": "YOUR_OVERLEAF_GIT_TOKEN"
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

Setting `OVERLEAF_GIT_AUTHOR_NAME` and `OVERLEAF_GIT_AUTHOR_EMAIL` is recommended on
environments where git is not globally configured, otherwise commits will fail.

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

### `list_projects`
List all configured Overleaf projects.

### `list_files`
List files in a project. Defaults to `.tex` files; pass `extension` to filter differently.

### `read_file`
Read a file's full contents.

### `get_sections`
Get all sectioning commands from a `.tex` file as a flat list. Each entry includes its type
(`section`, `subsection`, etc.), title, character offset, full content, and a 100-character
preview. Supports all seven LaTeX levels including starred variants.

### `get_section_content`
Get the full content of a specific named section.

### `status_summary`
Get a high-level overview of a project: file count, main file, and section structure.

### `write_file`
Overwrite an entire file. Prefer `write_section` or `str_replace` for targeted edits.
Supports `dryRun` (size check without writing) and `push: false` (commit locally only).

### `write_section`
Replace a single named section in a `.tex` file. Only the named section is replaced;
the rest of the file is untouched. The boundary is level-aware. Supports `dryRun` and `push`.

---

## Multi-Project Usage

Add multiple entries to `projects.json` and reference them by key in tool calls:

```json
{
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
- **Multiple projects configured:** `projectName` must be supplied. If omitted, the server returns an error listing the available project keys. This is intentional: silently defaulting to the wrong project on a write operation would be worse than an explicit error.

---

## Read-only projects

Any project can be marked read-only by setting `"readOnly": true` in `projects.json`:

```json
{
  "projects": {
    "my-project": {
      "name": "My Paper",
      "projectId": "...",
      "gitToken": "...",
      "readOnly": true
    }
  }
}
```

Read-only projects allow all read operations (`read_file`, `get_sections`, `get_section_content`, etc.) but reject any write operation with a clear error message. The default is `false` (writable), so omitting the field has no effect.

---

## Attribution

See [ATTRIBUTION.md](./ATTRIBUTION.md) for credits to the open-source projects that
informed this work.

---

## License

MIT. See [LICENSE](./LICENSE).