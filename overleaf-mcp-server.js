#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { readFile, writeFile, access, readdir } from 'fs/promises';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const exec = promisify(execCallback);

// Load projects configuration
let projectsConfig;
try {
  const configPath = path.join(__dirname, 'projects.json');
  const configData = await readFile(configPath, 'utf-8');
  projectsConfig = JSON.parse(configData);
} catch (error) {
  console.error('Error loading projects.json:', error.message);
  console.error('Please create projects.json from projects.example.json');
  process.exit(1);
}

// Git operations helper
class OverleafGitClient {
  constructor(projectId, gitToken) {
    this.projectId = projectId;
    this.gitToken = gitToken;
    this.repoPath = path.join(os.tmpdir(), `overleaf-${projectId}`);
    this.gitUrl = `https://git.overleaf.com/${projectId}`;
  }

  async cloneOrPull() {
    try {
      await access(path.join(this.repoPath, '.git'));
      // .git folder exists, just pull
      const { stdout } = await exec(
        `cd "${this.repoPath}" && git pull`,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
      return stdout;
    } catch {
      // Not cloned yet, do initial clone
      const { stdout } = await exec(
        `git clone https://git:${this.gitToken}@git.overleaf.com/${this.projectId} "${this.repoPath}"`,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
      return stdout;
    }
  }

  async listFiles(extension = '.tex') {
    await this.cloneOrPull();
    // Recursive walk
    const results = [];
    const walk = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== '.git') {
          await walk(fullPath);
        } else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) {
          results.push(path.relative(this.repoPath, fullPath));
        }
      }
    };
    await walk(this.repoPath);
    return results;
  }

  async readFile(filePath) {
    await this.cloneOrPull();
    const fullPath = path.join(this.repoPath, filePath);
    return await readFile(fullPath, 'utf-8');
  }

  async getSections(filePath) {
    const content = await this.readFile(filePath);
    const sections = [];
    const sectionRegex = /\\(?:section|subsection|subsubsection)\{([^}]+)\}/g;
    let match;

    while ((match = sectionRegex.exec(content)) !== null) {
      sections.push({
        title: match[1],
        type: match[0].split('{')[0].replace('\\', ''),
        index: match.index
      });
    }

    return sections;
  }

  async getSectionContent(filePath, sectionTitle) {
    const content = await this.readFile(filePath);
    const sections = await this.getSections(filePath);

    const targetSection = sections.find(s => s.title === sectionTitle);
    if (!targetSection) {
      throw new Error(`Section "${sectionTitle}" not found`);
    }

    const nextSection = sections.find(s => s.index > targetSection.index);
    const startIdx = targetSection.index;
    const endIdx = nextSection ? nextSection.index : content.length;

    return content.substring(startIdx, endIdx);
  }

  async writeSection(filePath, sectionTitle, newContent, commitMessage) {
    try {
      await this.cloneOrPull();
    } catch (err) {
      if (err.message.includes('CONFLICT')) {
        throw new Error(`Merge conflict while pulling. Resolve the conflict in Overleaf, then retry.`);
      }
      throw err;
    }
    const fullPath = path.join(this.repoPath, filePath);
    const fileContent = await readFile(fullPath, 'utf-8');
    const sections = await this.getSections(filePath);

    const target = sections.find(s => s.title === sectionTitle);
    if (!target) {
      throw new Error(`Section "${sectionTitle}" not found`);
    }

    // Find where the next same-or-higher level section starts, or end of document
    const sectionLevels = { section: 1, subsection: 2, subsubsection: 3 };
    const targetLevel = sectionLevels[target.type] ?? 99;
    const next = sections.find(s => s.index > target.index && (sectionLevels[s.type] ?? 99) <= targetLevel);
    const endIdx = next ? next.index : fileContent.lastIndexOf('\\end{document}');

    const updated =
      fileContent.slice(0, target.index) +
      newContent.trimEnd() + '\n\n' +
      fileContent.slice(endIdx);

    await writeFile(fullPath, updated, 'utf-8');
    try {
      const { stdout } = await exec(
        `cd "${this.repoPath}" && git add "${filePath}" && git commit -m "${commitMessage}" && git push`,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
      return stdout;
    } catch (err) {
      if (err.message.includes('non-fast-forward') || err.message.includes('rejected')) {
        throw new Error(`Push rejected, remote has new changes. Retry to pull and re-apply your write.`);
      }
      throw err;
    }
  }

  async writeFile(filePath, content, commitMessage) {
    try {
      // Pull before writing to avoid conflicts with remote changes
      await this.cloneOrPull();
    } catch (err) {
      if (err.message.includes('CONFLICT')) {
        throw new Error(
          `Merge conflict while pulling. Resolve the conflict in Overleaf, then retry.`
        );
      }
      throw err;
    }
    const fullPath = path.join(this.repoPath, filePath);
    await writeFile(fullPath, content, 'utf-8');
    try {
      const { stdout } = await exec(
        `cd "${this.repoPath}" && git add "${filePath}" && git commit -m "${commitMessage}" && git push`,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
      return stdout;
    } catch (err) {
      if (err.message.includes('non-fast-forward') || err.message.includes('rejected')) {
        throw new Error(
          `Push rejected, remote has new changes. Retry to pull and re-apply your write.`
        );
      }
      throw err;
    }
  }

  async fetchZoteroBibtex(apiKey, libraryType, libraryId) {
    // Zotero API returns max 100 items per request — paginate until all collected
    const baseUrl = `https://api.zotero.org/${libraryType}s/${libraryId}/items`;
    const headers = {
      'Zotero-API-Key': apiKey,
      'Zotero-API-Version': '3',
    };

    let allBibtex = '';
    let start = 0;
    const limit = 100;
    let totalResults = null;

    do {
      const url = `${baseUrl}?format=bibtex&limit=${limit}&start=${start}`;
      const response = await fetch(url, { headers });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Zotero API error ${response.status}: ${body}`);
      }

      // First request: read total from header so we know how many pages to fetch
      if (totalResults === null) {
        totalResults = parseInt(response.headers.get('Total-Results') || '0', 10);
      }

      const chunk = await response.text();
      allBibtex += chunk;
      start += limit;
    } while (start < totalResults);

    return allBibtex;
  }

  async syncZoteroBibliography(bibFilePath, apiKey, libraryType, libraryId, commitMessage) {
    try {
      await this.cloneOrPull();
    } catch (err) {
      if (err.message.includes('CONFLICT')) {
        throw new Error(`Merge conflict while pulling. Resolve the conflict in Overleaf, then retry.`);
      }
      throw err;
    }

    const bibtex = await this.fetchZoteroBibtex(apiKey, libraryType, libraryId);

    if (!bibtex.trim()) {
      throw new Error('Zotero returned an empty bibliography. Check that the library has items and the API key has read access.');
    }

    const fullPath = path.join(this.repoPath, bibFilePath);
    await writeFile(fullPath, bibtex, 'utf-8');

    try {
      const { stdout } = await exec(
        `cd "${this.repoPath}" && git add "${bibFilePath}" && git diff --cached --quiet || git commit -m "${commitMessage}" && git push`,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
      return stdout;
    } catch (err) {
      if (err.message.includes('non-fast-forward') || err.message.includes('rejected')) {
        throw new Error(`Push rejected, remote has new changes. Retry to pull and re-apply.`);
      }
      throw err;
    }
  }
}

// Create MCP server
const server = new Server(
  {
    name: 'overleaf-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper to get project
function getProject(projectName = 'default') {
  const project = projectsConfig.projects[projectName];
  if (!project) {
    throw new Error(`Project "${projectName}" not found in configuration`);
  }
  return new OverleafGitClient(project.projectId, project.gitToken);
}

// Helper to get the raw project config entry (for zotero credentials etc.)
function getProjectConfig(projectName = 'default') {
  const project = projectsConfig.projects[projectName];
  if (!project) {
    throw new Error(`Project "${projectName}" not found in configuration`);
  }
  return project;
}

// List all projects
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_projects',
        description: 'List all configured Overleaf projects',
        inputSchema: {
          type: 'object',
          properties: {},
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
              description: 'Project identifier (optional, defaults to "default")',
            },
            extension: {
              type: 'string',
              description: 'File extension filter (optional, e.g., ".tex")',
            },
          },
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
              description: 'Project identifier (optional)',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'get_sections',
        description: 'Get all sections from a LaTeX file',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the LaTeX file',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'get_section_content',
        description: 'Get content of a specific section',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the LaTeX file',
            },
            sectionTitle: {
              type: 'string',
              description: 'Title of the section',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
          required: ['filePath', 'sectionTitle'],
        },
      },
      {
        name: 'status_summary',
        description: 'Get a comprehensive project status summary',
        inputSchema: {
          type: 'object',
          properties: {
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
        },
      },
      {
        name: 'write_file',
        description: 'Write content to a file in an Overleaf project and push to Overleaf',
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
              description: 'Git commit message',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
          required: ['filePath', 'content', 'commitMessage'],
        },
      },
      {
        name: 'write_section',
        description: 'Replace a single section in a LaTeX file and push to Overleaf. Safer than write_file for targeted edits — only the named section is replaced, leaving the rest of the file untouched.',
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
              description: 'Full replacement content for the section, including the section heading',
            },
            commitMessage: {
              type: 'string',
              description: 'Git commit message',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
          required: ['filePath', 'sectionTitle', 'newContent', 'commitMessage'],
        },
      },
      {
        name: 'sync_zotero_bibliography',
        description: 'Fetch the full BibTeX export from a Zotero library via the Zotero API and write it to a .bib file in the Overleaf project, then push. This is the equivalent of clicking the Refresh button in Overleaf but fully automated. Always call this after adding papers to Zotero so the .bib file is up to date before writing citations.',
        inputSchema: {
          type: 'object',
          properties: {
            bibFilePath: {
              type: 'string',
              description: 'Path to the .bib file in the project (e.g. "references.bib")',
            },
            zoteroApiKey: {
              type: 'string',
              description: 'Zotero private API key with read access to the library',
            },
            zoteroLibraryType: {
              type: 'string',
              enum: ['user', 'group'],
              description: '"user" for My Library, "group" for a Group Library',
            },
            zoteroLibraryId: {
              type: 'string',
              description: 'Numeric Zotero library ID — user ID for personal library, group ID for group libraries',
            },
            commitMessage: {
              type: 'string',
              description: 'Git commit message (optional, defaults to "Sync bibliography from Zotero")',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
          required: [],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'list_projects': {
        const projects = Object.entries(projectsConfig.projects).map(([key, project]) => ({
          id: key,
          name: project.name,
          projectId: project.projectId,
        }));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(projects, null, 2),
            },
          ],
        };
      }

      case 'list_files': {
        const client = getProject(args.projectName);
        const files = await client.listFiles(args.extension || '.tex');
        return {
          content: [
            {
              type: 'text',
              text: files.join('\n'),
            },
          ],
        };
      }

      case 'read_file': {
        const client = getProject(args.projectName);
        const content = await client.readFile(args.filePath);
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      }

      case 'get_sections': {
        const client = getProject(args.projectName);
        const sections = await client.getSections(args.filePath);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sections, null, 2),
            },
          ],
        };
      }

      case 'get_section_content': {
        const client = getProject(args.projectName);
        const content = await client.getSectionContent(args.filePath, args.sectionTitle);
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      }

      case 'status_summary': {
        const client = getProject(args.projectName);
        const files = await client.listFiles();
        const mainFile = files.find(f => f.includes('main.tex')) || files[0];
        let sections = [];

        if (mainFile) {
          sections = await client.getSections(mainFile);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                totalFiles: files.length,
                mainFile,
                totalSections: sections.length,
                files: files.slice(0, 10),
              }, null, 2),
            },
          ],
        };
      }

      case 'write_file': {
        const client = getProject(args.projectName);
        const result = await client.writeFile(args.filePath, args.content, args.commitMessage);
        return {
          content: [
            {
              type: 'text',
              text: result || 'File written and pushed successfully.',
            },
          ],
        };
      }

      case 'write_section': {
        const client = getProject(args.projectName);
        const result = await client.writeSection(
          args.filePath,
          args.sectionTitle,
          args.newContent,
          args.commitMessage
        );
        return {
          content: [
            {
              type: 'text',
              text: result || 'Section written and pushed successfully.',
            },
          ],
        };
      }

      case 'sync_zotero_bibliography': {
        const client = getProject(args.projectName);
        const config = getProjectConfig(args.projectName);

        // Fall back to projects.json zotero block if args not supplied explicitly
        const zotero = config.zotero || {};
        const apiKey = args.zoteroApiKey || zotero.apiKey;
        const libraryType = args.zoteroLibraryType || zotero.libraryType;
        const libraryId = args.zoteroLibraryId || zotero.libraryId;
        const bibFilePath = args.bibFilePath || zotero.bibFile;
        const commitMessage = args.commitMessage || 'Sync bibliography from Zotero';

        if (!apiKey) throw new Error('Zotero API key not found. Add it to projects.json under zotero.apiKey or pass it as zoteroApiKey.');
        if (!libraryType) throw new Error('Zotero library type not found. Add it to projects.json under zotero.libraryType or pass it as zoteroLibraryType.');
        if (!libraryId) throw new Error('Zotero library ID not found. Add it to projects.json under zotero.libraryId or pass it as zoteroLibraryId.');
        if (!bibFilePath) throw new Error('Bib file path not found. Add it to projects.json under zotero.bibFile or pass it as bibFilePath.');

        const result = await client.syncZoteroBibliography(
          bibFilePath,
          apiKey,
          libraryType,
          libraryId,
          commitMessage
        );
        return {
          content: [
            {
              type: 'text',
              text: result || 'Bibliography synced from Zotero and pushed to Overleaf successfully.',
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Overleaf MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});