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

  if (keys.length === 0) {
    throw new Error('No projects configured. Add at least one entry to projects.json.');
  }

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
    resolvedName: projectName,
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
  'str_replace',
  'insert_before',
  'insert_after',
  'add_bib_entry',
  'replace_bib_entry',
  'remove_bib_entry',
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
        'Get all sections from a .tex file as a hierarchical tree. Each node includes ' +
        'its type (section, subsection, etc.), title, character offset, the text content ' +
        'immediately following that heading (not including children), a 100-character ' +
        'preview, and a children array of nested sections. Use this for document structure ' +
        'overview and to identify which section to read or edit next. ' +
        'Only applicable to .tex files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the LaTeX file',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
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
        'If the same section title appears under multiple parent sections, supply ' +
        'parentTitle to disambiguate. Only applicable to .tex files.',
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
          parentTitle: {
            type: 'string',
            description:
              'Title of the parent section, used to disambiguate when the same ' +
              'sectionTitle appears under multiple parents (optional)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        required: ['filePath', 'sectionTitle'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_preamble',
      description:
        'Get everything before the first sectioning command in a .tex file: ' +
        'the document class declaration, package imports, and custom command definitions. ' +
        'Returns the full file content if the file contains no sections. ' +
        'Only applicable to .tex files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the LaTeX file',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_postamble',
      description:
        'Get everything from \\end{document} (inclusive) to the end of the file. ' +
        'Returns an empty string if \\end{document} is absent (e.g. \\input\'d files). ' +
        'Note: bibliography commands (\\bibliography{}, \\bibliographystyle{}, ' +
        '\\printbibliography) appear before \\end{document} and are part of the last ' +
        "section's content range — use str_replace to edit them. " +
        'Only applicable to .tex files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the LaTeX file',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_history',
      description:
        'Show recent git commits for the project, optionally filtered by file path ' +
        'and/or time range. Each entry includes the commit hash, date, author, and subject.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Maximum number of commits to return (optional, default 20, max 200)',
          },
          filePath: {
            type: 'string',
            description: 'Restrict history to a specific file path (optional)',
          },
          since: {
            type: 'string',
            description: 'git --since filter, e.g. "2.weeks" or "2025-01-01" (optional)',
          },
          until: {
            type: 'string',
            description: 'git --until filter (optional)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_diff',
      description:
        'Get a unified diff for the project. By default returns all changes since the ' +
        'last commit (working tree vs HEAD). Supply fromRef and/or toRef to diff between ' +
        'specific commits or branches.',
      inputSchema: {
        type: 'object',
        properties: {
          fromRef: {
            type: 'string',
            description: 'Base ref (commit hash, branch, or tag). Omit to diff working tree vs HEAD (optional)',
          },
          toRef: {
            type: 'string',
            description: 'Target ref. Omit to use the working tree (optional)',
          },
          filePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Restrict the diff to these file paths (optional)',
          },
          contextLines: {
            type: 'integer',
            description: 'Lines of context around each hunk (optional, default 3, max 10)',
          },
          maxOutputChars: {
            type: 'integer',
            description: 'Truncate output to this many characters (optional, default 120000)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
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
        'Prefer str_replace, insert_before, or insert_after for targeted edits, ' +
        'or write_section for full section replacements. ' +
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
    {
      name: 'str_replace',
      description:
        'Replace the single unique occurrence of oldStr with newStr in a file. ' +
        'oldStr must appear exactly once — if it matches zero or multiple locations, ' +
        'an error is returned with the occurrence count so you can add more surrounding ' +
        'context to make it unambiguous. ' +
        'This is the preferred tool for targeted edits anywhere in a file, including ' +
        'the preamble, bibliography commands, and inline content.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the file',
          },
          oldStr: {
            type: 'string',
            description:
              'The exact string to find and replace. Must appear exactly once in the file. ' +
              'Include enough surrounding context to make it unique.',
          },
          newStr: {
            type: 'string',
            description: 'The replacement string. May be empty to delete oldStr.',
          },
          commitMessage: {
            type: 'string',
            description: 'Git commit message (optional, defaults to "Edit via Overleaf MCP")',
          },
          push: {
            type: 'boolean',
            description: 'Whether to push to Overleaf after committing (optional, defaults to true)',
          },
          dryRun: {
            type: 'boolean',
            description:
              'If true, verify oldStr is unique and return its position without writing anything ' +
              '(optional, defaults to false)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        required: ['filePath', 'oldStr', 'newStr'],
        additionalProperties: false,
      },
    },
    {
      name: 'insert_before',
      description:
        'Insert newContent immediately before the single unique occurrence of anchorStr in a file. ' +
        'anchorStr must appear exactly once — same uniqueness rules as str_replace. ' +
        'Use this for pure insertions where no existing content should be removed.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the file',
          },
          anchorStr: {
            type: 'string',
            description:
              'The exact string to insert before. Must appear exactly once in the file.',
          },
          newContent: {
            type: 'string',
            description: 'The content to insert immediately before anchorStr.',
          },
          commitMessage: {
            type: 'string',
            description: 'Git commit message (optional, defaults to "Edit via Overleaf MCP")',
          },
          push: {
            type: 'boolean',
            description: 'Whether to push to Overleaf after committing (optional, defaults to true)',
          },
          dryRun: {
            type: 'boolean',
            description: 'If true, verify anchorStr is unique without writing anything (optional, defaults to false)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        required: ['filePath', 'anchorStr', 'newContent'],
        additionalProperties: false,
      },
    },
    {
      name: 'insert_after',
      description:
        'Insert newContent immediately after the single unique occurrence of anchorStr in a file. ' +
        'anchorStr must appear exactly once — same uniqueness rules as str_replace. ' +
        'Use this for pure insertions where no existing content should be removed, ' +
        'for example appending a new \\usepackage line after the last existing one.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the file',
          },
          anchorStr: {
            type: 'string',
            description:
              'The exact string to insert after. Must appear exactly once in the file.',
          },
          newContent: {
            type: 'string',
            description: 'The content to insert immediately after anchorStr.',
          },
          commitMessage: {
            type: 'string',
            description: 'Git commit message (optional, defaults to "Edit via Overleaf MCP")',
          },
          push: {
            type: 'boolean',
            description: 'Whether to push to Overleaf after committing (optional, defaults to true)',
          },
          dryRun: {
            type: 'boolean',
            description: 'If true, verify anchorStr is unique without writing anything (optional, defaults to false)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        required: ['filePath', 'anchorStr', 'newContent'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_bib_entry',
      description:
        'Get the raw BibTeX block for a single cite key from a .bib file. ' +
        'Returns the full entry string including the @type{key, ...} wrapper. ' +
        'Only applicable to .bib files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the .bib file',
          },
          citeKey: {
            type: 'string',
            description: 'The citation key to look up (e.g. "smith2024")',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        required: ['filePath', 'citeKey'],
        additionalProperties: false,
      },
    },
    {
      name: 'add_bib_entry',
      description:
        'Append a new BibTeX entry to a .bib file. ' +
        'The entry parameter must be a complete raw BibTeX string, e.g.: ' +
        '@inproceedings{smith2024, author = {Smith, John}, title = {A Paper}, booktitle = {NeurIPS}, year = {2024}}. ' +
        'Any valid BibTeX entry type is accepted (@article, @book, @inproceedings, @misc, etc.). ' +
        'The cite key is extracted server-side — an error is returned if it already exists. ' +
        'Only applicable to .bib files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the .bib file',
          },
          entry: {
            type: 'string',
            description: 'Complete raw BibTeX entry string including the @type{key, ...} wrapper',
          },
          commitMessage: {
            type: 'string',
            description: 'Git commit message (optional, defaults to "Add bib entry via Overleaf MCP")',
          },
          push: {
            type: 'boolean',
            description: 'Whether to push to Overleaf after committing (optional, defaults to true)',
          },
          dryRun: {
            type: 'boolean',
            description: 'If true, validate the entry and check for duplicate cite key without writing anything (optional, defaults to false)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        required: ['filePath', 'entry'],
        additionalProperties: false,
      },
    },
    {
      name: 'replace_bib_entry',
      description:
        'Replace the BibTeX entry with the given cite key with a new raw BibTeX block. ' +
        'The new entry may use a different cite key if desired. ' +
        'Only applicable to .bib files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the .bib file',
          },
          citeKey: {
            type: 'string',
            description: 'The citation key of the entry to replace',
          },
          newEntry: {
            type: 'string',
            description: 'Complete replacement raw BibTeX entry string',
          },
          commitMessage: {
            type: 'string',
            description: 'Git commit message (optional, defaults to "Update bib entry via Overleaf MCP")',
          },
          push: {
            type: 'boolean',
            description: 'Whether to push to Overleaf after committing (optional, defaults to true)',
          },
          dryRun: {
            type: 'boolean',
            description: 'If true, verify the cite key exists without writing anything (optional, defaults to false)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        required: ['filePath', 'citeKey', 'newEntry'],
        additionalProperties: false,
      },
    },
    {
      name: 'remove_bib_entry',
      description:
        'Remove the BibTeX entry with the given cite key from a .bib file. ' +
        'Also removes the preceding blank line to keep the file tidy. ' +
        'Only applicable to .bib files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the .bib file',
          },
          citeKey: {
            type: 'string',
            description: 'The citation key of the entry to remove',
          },
          commitMessage: {
            type: 'string',
            description: 'Git commit message (optional, defaults to "Remove bib entry via Overleaf MCP")',
          },
          push: {
            type: 'boolean',
            description: 'Whether to push to Overleaf after committing (optional, defaults to true)',
          },
          dryRun: {
            type: 'boolean',
            description: 'If true, verify the cite key exists without writing anything (optional, defaults to false)',
          },
          projectName: {
            type: 'string',
            description: 'Project identifier. Required when multiple projects are configured; can be omitted when exactly one project exists.',
          },
        },
        required: ['filePath', 'citeKey'],
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
    const { client, projectId, resolvedName, readOnly } = getProject(args.projectName);

    // Central read-only guard: checked once here, applies to every write tool
    // automatically as new ones are added to the WRITE_TOOLS registry above.
    if (WRITE_TOOLS.has(name) && readOnly) {
      throw new Error(
        `Project "${resolvedName}" is configured as read-only. ` +
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
        const tree = await withProjectLock(projectId, () =>
          client.getSectionTree(args.filePath)
        );
        return text(JSON.stringify(tree, null, 2));
      }

      case 'get_section_content': {
        const section = await withProjectLock(projectId, () =>
          client.getSection(args.filePath, args.sectionTitle, args.parentTitle ?? null)
        );
        if (!section) {
          const hint = args.parentTitle
            ? ` under parent "${args.parentTitle}"`
            : ' (consider supplying parentTitle if the title appears under multiple sections)';
          throw new Error(`Section "${args.sectionTitle}" not found in "${args.filePath}"${hint}`);
        }
        return text(section.content);
      }

      case 'get_preamble': {
        const preamble = await withProjectLock(projectId, () =>
          client.getPreamble(args.filePath)
        );
        return text(preamble);
      }

      case 'get_postamble': {
        const postamble = await withProjectLock(projectId, () =>
          client.getPostamble(args.filePath)
        );
        return text(postamble || '(no \\end{document} found in this file)');
      }

      case 'list_history': {
        const entries = await withProjectLock(projectId, () =>
          client.listHistory({
            limit: args.limit,
            filePath: args.filePath,
            since: args.since,
            until: args.until,
          })
        );
        if (!entries.length) return text('No commits found for the given filters.');
        const lines = entries.map(
          (e, i) => `${i + 1}. ${e.hash.slice(0, 8)} | ${e.date} | ${e.author} | ${e.subject}`
        );
        return text(lines.join('\n'));
      }

      case 'get_diff': {
        const { diff, truncated } = await withProjectLock(projectId, () =>
          client.getDiff({
            fromRef: args.fromRef,
            toRef: args.toRef,
            filePaths: args.filePaths ?? [],
            contextLines: args.contextLines,
            maxOutputChars: args.maxOutputChars,
          })
        );
        const header = [
          `Base:   ${args.fromRef ?? 'HEAD'}`,
          `Target: ${args.toRef ?? 'working tree'}`,
          args.filePaths?.length ? `Paths: ${args.filePaths.join(', ')}` : 'Paths: all',
          truncated ? '(output truncated)' : null,
        ].filter(Boolean).join('\n');
        return text(`${header}\n\n${diff || '(no differences)'}`);
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

      case 'str_replace': {
        const result = await withProjectLock(projectId, () =>
          client.strReplace(args.filePath, args.oldStr, args.newStr, {
            commitMessage: args.commitMessage,
            push: args.push,
            dryRun: args.dryRun,
          })
        );
        return text(formatWriteResult(result));
      }

      case 'insert_before': {
        const result = await withProjectLock(projectId, () =>
          client.insertBefore(args.filePath, args.anchorStr, args.newContent, {
            commitMessage: args.commitMessage,
            push: args.push,
            dryRun: args.dryRun,
          })
        );
        return text(formatWriteResult(result));
      }

      case 'insert_after': {
        const result = await withProjectLock(projectId, () =>
          client.insertAfter(args.filePath, args.anchorStr, args.newContent, {
            commitMessage: args.commitMessage,
            push: args.push,
            dryRun: args.dryRun,
          })
        );
        return text(formatWriteResult(result));
      }

      case 'get_bib_entry': {
        const entry = await withProjectLock(projectId, () =>
          client.getBibEntry(args.filePath, args.citeKey)
        );
        if (!entry) {
          throw new Error(`Cite key "${args.citeKey}" not found in "${args.filePath}".`);
        }
        return text(entry);
      }

      case 'add_bib_entry': {
        const result = await withProjectLock(projectId, () =>
          client.addBibEntry(args.filePath, args.entry, {
            commitMessage: args.commitMessage,
            push: args.push,
            dryRun: args.dryRun,
          })
        );
        return text(formatWriteResult(result));
      }

      case 'replace_bib_entry': {
        const result = await withProjectLock(projectId, () =>
          client.replaceBibEntry(args.filePath, args.citeKey, args.newEntry, {
            commitMessage: args.commitMessage,
            push: args.push,
            dryRun: args.dryRun,
          })
        );
        return text(formatWriteResult(result));
      }

      case 'remove_bib_entry': {
        const result = await withProjectLock(projectId, () =>
          client.removeBibEntry(args.filePath, args.citeKey, {
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
    if ('anchorIndex' in result) lines.push(`Anchor position: character ${result.anchorIndex}`);
    if ('citeKey' in result) lines.push(`Cite key: ${result.citeKey}`);
    if ('action' in result) lines.push(`Action: ${result.action}`);
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