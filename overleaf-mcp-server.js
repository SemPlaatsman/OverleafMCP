#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { OverleafGitClient } from './overleaf-git-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Configuration ────────────────────────────────────────────────────────────

const PROJECTS_FILE = process.env.PROJECTS_FILE
  ? path.resolve(process.cwd(), process.env.PROJECTS_FILE)
  : path.join(__dirname, 'projects.json');

const TEMP_DIR = process.env.OVERLEAF_TEMP_DIR
  ? path.resolve(process.cwd(), process.env.OVERLEAF_TEMP_DIR)
  : path.join(__dirname, 'temp');

let projectsConfig;
try {
  const raw = await readFile(PROJECTS_FILE, 'utf-8');
  projectsConfig = JSON.parse(raw);
} catch (err) {
  console.error(`[OverleafMCP] Failed to load projects config from "${PROJECTS_FILE}": ${err.message}`);
  console.error('[OverleafMCP] Please create projects.json from projects.example.json');
  process.exit(1);
}

// ─── In-process per-project mutex ────────────────────────────────────────────
//
// Serializes all git operations for a given project within this process.
// Prevents concurrent pull → write → push cycles from corrupting the local repo.
//
// Each entry in the map is the tail promise of that project's operation chain.
// A new caller appends itself to the tail and waits for the previous to finish.
//
const _projectLocks = new Map();

async function withProjectLock(projectId, fn) {
  const previous = _projectLocks.get(projectId) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  _projectLocks.set(projectId, previous.then(() => current));
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

// ─── Project resolution ───────────────────────────────────────────────────────

function getProject(projectName) {
  const projects = projectsConfig.projects ?? {};
  const keys = Object.keys(projects);

  if (!projectName) {
    if (keys.length === 1) {
      // Exactly one project configured: safe to default without ambiguity.
      projectName = keys[0];
    } else {
      // Multiple projects: require an explicit selection to avoid silently
      // operating on the wrong project.
      throw new Error(
        `projectName is required when multiple projects are configured. ` +
        `Available projects: ${keys.join(', ')}`
      );
    }
  }

  const project = projects[projectName];
  if (!project) {
    throw new Error(
      `Project "${projectName}" not found. Available projects: ${keys.join(', ')}`
    );
  }

  return {
    client: new OverleafGitClient(project.projectId, project.gitToken, TEMP_DIR),
    projectId: project.projectId,
    // readOnly defaults to false — omitting the field means the project is writable.
    readOnly: project.readOnly === true,
  };
}

// ─── Write-tool registry ──────────────────────────────────────────────────────
//
// All tools that perform any write operation must be listed here.
// The read-only guard checks this set centrally before the switch runs,
// so adding a new write tool in a future branch only requires adding its name here.
//
const WRITE_TOOLS = new Set([
  'write_file',
  'write_section',
]);

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'overleaf-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_projects',
      description: 'List all configured Overleaf projects',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_files',
      description: 'List files in an Overleaf project',
      inputSchema: {
        type: 'object',
        properties: {
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; optional when exactly one project exists.',
          },
          extension: {
            type: 'string',
            description: 'File extension filter (optional, e.g. ".tex"). Defaults to ".tex"',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from an Overleaf project',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the file',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; optional when exactly one project exists.',
          },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_sections',
      description:
        'Get all sections from a .tex file as a flat list. Each entry includes its type ' +
        '(section, subsection, etc.), title, character offset, full content, and a short ' +
        'content preview. Only applicable to .tex files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the LaTeX file',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; optional when exactly one project exists.',
          },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_section_content',
      description:
        'Get the full content of a specific section in a .tex file. ' +
        'Only applicable to .tex files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the LaTeX file',
          },
          sectionTitle: {
            type: 'string',
            description: 'Title of the section (must match exactly)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; optional when exactly one project exists.',
          },
        },
        required: ['filePath', 'sectionTitle'],
        additionalProperties: false,
      },
    },
    {
      name: 'status_summary',
      description: 'Get a high-level status summary of an Overleaf project',
      inputSchema: {
        type: 'object',
        properties: {
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; optional when exactly one project exists.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'write_file',
      description:
        'Overwrite an entire file in an Overleaf project. ' +
        'Prefer write_section or (once available) str_replace for targeted edits. ' +
        'Use this for new file creation or full-file replacements only.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the file',
          },
          content: {
            type: 'string',
            description: 'Full file content to write',
          },
          commitMessage: {
            type: 'string',
            description: 'Git commit message (optional, defaults to "Update via Overleaf MCP")',
          },
          push: {
            type: 'boolean',
            description: 'Whether to push to Overleaf after committing (optional, defaults to true)',
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, report existing and new file sizes without writing anything ' +
              '(optional, defaults to false)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; optional when exactly one project exists.',
          },
        },
        required: ['filePath', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'write_section',
      description:
        'Replace a single named section in a .tex file and optionally push to Overleaf. ' +
        'Only the named section is replaced; the rest of the file is untouched. ' +
        'The boundary is level-aware: the section ends where the next command of equal or ' +
        'higher level begins, or at \\end{document} if there is none. ' +
        'Only applicable to .tex files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the LaTeX file',
          },
          sectionTitle: {
            type: 'string',
            description: 'Title of the section to replace (must match exactly)',
          },
          newContent: {
            type: 'string',
            description: 'Replacement content for the section, including the section heading',
          },
          commitMessage: {
            type: 'string',
            description: 'Git commit message (optional, defaults to "Update section via Overleaf MCP")',
          },
          push: {
            type: 'boolean',
            description: 'Whether to push to Overleaf after committing (optional, defaults to true)',
          },
          dryRun: {
            type: 'boolean',
            description: 'If true, verify the section exists and return its size without writing anything',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; optional when exactly one project exists.',
          },
        },
        required: ['filePath', 'sectionTitle', 'newContent'],
        additionalProperties: false,
      },
    },
  ],
}));

// ─── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    // list_projects reads only in-memory config — no client or lock needed.
    if (name === 'list_projects') {
      const projects = Object.entries(projectsConfig.projects ?? {}).map(([key, p]) => ({
        id: key,
        name: p.name,
        projectId: p.projectId,
        readOnly: p.readOnly === true,
      }));
      return text(JSON.stringify(projects, null, 2));
    }

    // All other tools require a project context.
    const { client, projectId, readOnly } = getProject(args.projectName);

    // Central read-only guard: checked once here, applies to every write tool
    // automatically as new ones are added to the WRITE_TOOLS registry above.
    if (WRITE_TOOLS.has(name) && readOnly) {
      throw new Error(
        `Project "${args.projectName ?? '<none specified>'}" is configured as read-only. ` +
        `Set "readOnly": false in projects.json to enable write operations.`
      );
    }

    switch (name) {

      case 'list_files': {
        const files = await withProjectLock(projectId, () =>
          client.listFiles(args.extension ?? '.tex')
        );
        return text(files.length ? files.join('\n') : 'No files found');
      }

      case 'read_file': {
        const content = await withProjectLock(projectId, () =>
          client.readFile(args.filePath)
        );
        return text(content);
      }

      case 'get_sections': {
        const sections = await withProjectLock(projectId, () =>
          client.getSections(args.filePath)
        );
        return text(JSON.stringify(sections, null, 2));
      }

      case 'get_section_content': {
        const section = await withProjectLock(projectId, () =>
          client.getSection(args.filePath, args.sectionTitle)
        );
        if (!section) {
          throw new Error(`Section "${args.sectionTitle}" not found in "${args.filePath}"`);
        }
        return text(section.content);
      }

      case 'status_summary': {
        const result = await withProjectLock(projectId, async () => {
          const files = await client.listFiles();
          const mainFile = files.find(f => f.includes('main.tex')) ?? files[0] ?? null;
          const sections = mainFile ? await client.getSections(mainFile) : [];
          return { totalFiles: files.length, mainFile, totalSections: sections.length, files: files.slice(0, 10) };
        });
        return text(JSON.stringify(result, null, 2));
      }

      case 'write_file': {
        const result = await withProjectLock(projectId, () =>
          client.writeFile(args.filePath, args.content, {
            commitMessage: args.commitMessage,
            push: args.push,
            dryRun: args.dryRun,
          })
        );
        return text(formatWriteResult(result));
      }

      case 'write_section': {
        const result = await withProjectLock(projectId, () =>
          client.writeSection(args.filePath, args.sectionTitle, args.newContent, {
            commitMessage: args.commitMessage,
            push: args.push,
            dryRun: args.dryRun,
          })
        );
        return text(formatWriteResult(result));
      }

      default:
        throw new Error(`Unknown tool: "${name}"`);
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

// ─── Response helpers ─────────────────────────────────────────────────────────

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

function formatWriteResult(result) {
  if (result?.dryRun) {
    const lines = ['Dry run: no changes written.'];
    if ('existingSize' in result) lines.push(`Existing file size: ${result.existingSize} characters`);
    if ('newSize' in result) lines.push(`New content size:   ${result.newSize} characters`);
    if ('sectionFound' in result) lines.push(`Section found: ${result.sectionFound}`);
    if ('newContentSize' in result) lines.push(`New content size: ${result.newContentSize} characters`);
    return lines.join('\n');
  }
  if (result?.message) return result.message;
  return 'Done.';
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[OverleafMCP] Server running on stdio');
}

main().catch(err => {
  console.error('[OverleafMCP] Fatal error:', err);
  process.exit(1);
});