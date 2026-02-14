# Overleaf MCP Server

An MCP (Model Context Protocol) server that provides access to Overleaf projects via Git integration. This allows Claude and other MCP clients to read LaTeX files, analyze document structure, extract content, and write files from and to Overleaf projects.

## Features

- 📄 **File Management**: List, read, and write files from and to Overleaf projects
- 📋 **Document Structure**: Parse LaTeX sections and subsections
- 🔍 **Content Extraction**: Extract specific sections by title
- 📊 **Project Summary**: Get overview of project status and structure
- 🏗️ **Multi-Project Support**: Manage multiple Overleaf projects

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your projects configuration:
   ```bash
   cp projects.example.json projects.json
   ```

4. Edit `projects.json` with your Overleaf credentials:
   ```json
   {
     "projects": {
       "default": {
         "name": "My Paper",
         "projectId": "YOUR_OVERLEAF_PROJECT_ID",
         "gitToken": "YOUR_OVERLEAF_GIT_TOKEN"
       }
     }
   }
   ```

## Getting Overleaf Credentials

1. **Git Token**: 
   - Go to Overleaf Account Settings → Git Integration
   - Click "Create Token"

2. **Project ID**: 
   - Open your Overleaf project
   - Find it in the URL: `https://www.overleaf.com/project/[PROJECT_ID]`

## Claude Desktop Setup

Add to your Claude Desktop configuration file:

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Linux**: `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": [
        "/path/to/OverleafMCP/overleaf-mcp-server.js"
      ]
    }
  }
}
```

Restart Claude Desktop after configuration.

## Available Tools

### `list_projects`
List all configured projects.

### `list_files`
List files in a project (default: .tex files).
- `extension`: File extension filter (optional)
- `projectName`: Project identifier (optional, defaults to "default")

### `read_file`
Read a specific file from the project.
- `filePath`: Path to the file (required)
- `projectName`: Project identifier (optional)

### `get_sections`
Get all sections from a LaTeX file.
- `filePath`: Path to the LaTeX file (required)
- `projectName`: Project identifier (optional)

### `get_section_content`
Get content of a specific section.
- `filePath`: Path to the LaTeX file (required)
- `sectionTitle`: Title of the section (required)
- `projectName`: Project identifier (optional)

### `status_summary`
Get a comprehensive project status summary.
- `projectName`: Project identifier (optional)

### `write_full`
Write the full content of a file to the project.
- `filePath`: Path to the file (required)
- `content`: Content to write to the file (required)
- `commitMessage`: Commit message (required)
- `projectName`: Project identifier (optional)

### `write_section`
Write the content of a specific section to the project.
- `filePath`: Path to the file (required)
- `sectionTitle`: Title of the section (required)
- `content`: Content to write to the section (required)
- `commitMessage`: Commit message (required)
- `projectName`: Project identifier (optional)

## Usage Examples

```
# List all projects
Use the list_projects tool

# Get project overview
Use status_summary tool

# Read main.tex file
Use read_file with filePath: "main.tex"

# Get Introduction section
Use get_section_content with filePath: "main.tex" and sectionTitle: "Introduction"

# List all sections in a file
Use get_sections with filePath: "main.tex"

# Write the full content of a file to the project
Use write_full with filePath: "main.tex", content: "...", commitMessage: "..."

# Write the content of a specific section to the project
Use write_section with filePath: "main.tex", sectionTitle: "Introduction", content: "...", commitMessage: "..."
```

## Multi-Project Usage

To work with multiple projects, add them to `projects.json`:

```json
{
  "projects": {
    "default": {
      "name": "Main Paper",
      "projectId": "project-id-1",
      "gitToken": "token-1"
    },
    "paper2": {
      "name": "Second Paper", 
      "projectId": "project-id-2",
      "gitToken": "token-2"
    }
  }
}
```

Then specify the project in tool calls:
```
Use get_section_content with projectName: "paper2", filePath: "main.tex", sectionTitle: "Methods"
```

## File Structure

```
OverleafMCP/
├── overleaf-mcp-server.js    # Main MCP server
├── overleaf-git-client.js    # Git client library
├── projects.json             # Your project configuration (gitignored)
├── projects.example.json     # Example configuration
├── package.json              # Dependencies
└── README.md                 # This file
```

## Security Notes

- `projects.json` is gitignored to protect your credentials
- Never commit real project IDs or Git tokens
- Use the provided `projects.example.json` as a template

## License

MIT License