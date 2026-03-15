// Standalone fixture restore script for CI failure recovery.
// Restores test_fixture.tex and test_fixture.bib to their known initial state.
// Run as: node test/restore.js
// Exits 0 on success, 1 on failure.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OverleafGitClient } from '../overleaf-git-client.js';
import { withRetry } from './helpers.js';

const TEMP_DIR = process.env.OVERLEAF_TEMP_DIR
  ? path.resolve(process.cwd(), process.env.OVERLEAF_TEMP_DIR)
  : path.resolve('./temp');

const PROJECTS_FILE = process.env.PROJECTS_FILE
  ? path.resolve(process.cwd(), process.env.PROJECTS_FILE)
  : path.resolve('./projects.json');

const FIXTURE_TEX = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}

\\section{Alpha}
Alpha section content.

\\subsection{Alpha Sub}
Alpha subsection content.

\\section{Beta}
Beta section content.

\\end{document}
`;

const FIXTURE_BIB = `@article{fixture2024,
    author  = {Fixture, Author},
    title   = {The {F}ixture {P}aper},
    journal = {Test Journal},
    year    = {2024}
}
`;

try {
  const config = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
  const { projectId, gitToken } = config.projects.example_project;
  const client = new OverleafGitClient(projectId, gitToken, path.join(TEMP_DIR, 'integration'));

  console.error('[restore] Restoring test_fixture.tex...');
  await withRetry(() => client.writeFile('test_fixture.tex', FIXTURE_TEX, {
    push: true,
    commitMessage: 'test: restore test_fixture.tex to known state',
  }));

  console.error('[restore] Restoring test_fixture.bib...');
  await withRetry(() => client.writeFile('test_fixture.bib', FIXTURE_BIB, {
    push: true,
    commitMessage: 'test: restore test_fixture.bib to known state',
  }));

  console.error('[restore] Done.');
  process.exit(0);
} catch (err) {
  console.error('[restore] Failed:', err.message);
  process.exit(1);
}