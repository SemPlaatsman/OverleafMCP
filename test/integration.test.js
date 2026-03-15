import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OverleafGitClient, PREVIEW_MAX_LENGTH } from '../overleaf-git-client.js';
// TOOL_NAMES import is deferred to the after() hook to avoid triggering
// the server's stdio startup code at module load time. See restore note below.
// import { TOOL_NAMES } from '../overleaf-mcp-server.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TEMP_DIR = process.env.OVERLEAF_TEMP_DIR
  ? path.resolve(process.env.OVERLEAF_TEMP_DIR)
  : path.resolve('./temp');

const PROJECTS_FILE = process.env.PROJECTS_FILE
  ? path.resolve(process.env.PROJECTS_FILE)
  : path.resolve('./projects.json');

const config = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
const { projectId: exProjectId, gitToken: exToken } = config.projects.example_project;
const { projectId: roProjectId, gitToken: roToken } = config.projects.readonly_example_project;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const exClient = new OverleafGitClient(
  exProjectId,
  exToken,
  path.join(TEMP_DIR, 'example_project')
);
const roClient = new OverleafGitClient(
  roProjectId,
  roToken,
  path.join(TEMP_DIR, 'readonly_example_project')
);

// ---------------------------------------------------------------------------
// Fixture content (authoritative source for setup and teardown)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function withRetry(fn, { attempts = 3, delayMs = 5000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isTransient =
        err.message?.includes('403') ||
        err.message?.includes('502') ||
        err.message?.includes('504') ||
        err.message?.includes('unable to access') ||
        err.message?.includes('timed out');
      if (!isTransient || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tool coverage tracking
// (enforcer added in after() once all groups are written)
// ---------------------------------------------------------------------------
const testedTools = new Set();

// ---------------------------------------------------------------------------
// Global setup: push fixture files to known state before any test runs
// ---------------------------------------------------------------------------
before(async () => {
  await withRetry(() => exClient.writeFile('test_fixture.tex', FIXTURE_TEX, {
    push: true,
    commitMessage: 'test: restore test_fixture.tex to known state',
  }));
  await withRetry(() => exClient.writeFile('test_fixture.bib', FIXTURE_BIB, {
    push: true,
    commitMessage: 'test: restore test_fixture.bib to known state',
  }));
});

// ---------------------------------------------------------------------------
// Global teardown: restore fixture files regardless of test outcome
// ---------------------------------------------------------------------------
after(async () => {
  await withRetry(() => exClient.writeFile('test_fixture.tex', FIXTURE_TEX, {
    push: true,
    commitMessage: 'test: restore test_fixture.tex to known state',
  }));
  await withRetry(() => exClient.writeFile('test_fixture.bib', FIXTURE_BIB, {
    push: true,
    commitMessage: 'test: restore test_fixture.bib to known state',
  }));

  // Tool coverage enforcer — enabled once all groups (1–8) are written.
  // for (const name of TOOL_NAMES) {
  //   assert.ok(testedTools.has(name), `Tool "${name}" has no integration test coverage`);
  // }
});

// ---------------------------------------------------------------------------
// Group 1: Project navigation
// ---------------------------------------------------------------------------
describe('Group 1: Project navigation', () => {
  test('1.1 listFiles: .tex extension returns array containing main.tex', async () => {
    testedTools.add('list_files');
    const files = await withRetry(() => exClient.listFiles('.tex'));
    assert.ok(Array.isArray(files), 'listFiles should return an array');
    assert.ok(
      files.some(f => f === 'main.tex' || f.endsWith('/main.tex')),
      `Expected main.tex in results, got: ${JSON.stringify(files)}`
    );
  });

  test('1.2 listFiles: .bib extension returns array containing sample.bib', async () => {
    testedTools.add('list_files');
    const files = await withRetry(() => exClient.listFiles('.bib'));
    assert.ok(Array.isArray(files));
    assert.ok(
      files.some(f => f === 'sample.bib' || f.endsWith('/sample.bib')),
      `Expected sample.bib in results, got: ${JSON.stringify(files)}`
    );
  });

  test('1.3 listFiles: no extension filter returns all files', async () => {
    testedTools.add('list_files');
    const files = await withRetry(() => exClient.listFiles());
    assert.ok(Array.isArray(files));
    assert.ok(files.length > 0, 'Expected at least one file');
    // All-files result should be a superset of .tex-only result
    const texFiles = await withRetry(() => exClient.listFiles('.tex'));
    for (const f of texFiles) {
      assert.ok(files.includes(f), `All-files result missing ${f}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 2: LaTeX read tools (against test_fixture.tex)
// ---------------------------------------------------------------------------
describe('Group 2: LaTeX read tools', () => {
  before(() => sleep(3000));

  test('2.1 readFile: content matches known initial fixture content exactly', async () => {
    testedTools.add('read_file');
    const content = await withRetry(() => exClient.readFile('test_fixture.tex'));
    assert.equal(content, FIXTURE_TEX);
  });

  test('2.2 getSections: 2 top-level sections; Alpha has 1 child (Alpha Sub), Beta has none', async () => {
    testedTools.add('get_sections');
    const tree = await withRetry(() => exClient.getSectionTree('test_fixture.tex'));
    assert.equal(tree.length, 2, `Expected 2 top-level sections, got ${tree.length}`);
    assert.equal(tree[0].title, 'Alpha');
    assert.equal(tree[0].children.length, 1, 'Alpha should have 1 child');
    assert.equal(tree[0].children[0].title, 'Alpha Sub');
    assert.equal(tree[1].title, 'Beta');
    assert.equal(tree[1].children.length, 0, 'Beta should have no children');
  });

  test('2.3 getSections: content fields match fixture text', async () => {
    testedTools.add('get_sections');
    const tree = await withRetry(() => exClient.getSectionTree('test_fixture.tex'));
    assert.ok(
      tree[0].content.includes('Alpha section content.'),
      `Alpha content: "${tree[0].content}"`
    );
    assert.ok(
      tree[0].children[0].content.includes('Alpha subsection content.'),
      `Alpha Sub content: "${tree[0].children[0].content}"`
    );
  });

  test('2.4 getSections: preview is within PREVIEW_MAX_LENGTH and non-empty for sections with content', async () => {
    testedTools.add('get_sections');
    const tree = await withRetry(() => exClient.getSectionTree('test_fixture.tex'));
    const allNodes = [tree[0], tree[0].children[0], tree[1]];
    for (const node of allNodes) {
      assert.ok(
        node.preview.length <= PREVIEW_MAX_LENGTH,
        `${node.title}: preview length ${node.preview.length} > ${PREVIEW_MAX_LENGTH}`
      );
      if (node.content.trim().length > 0) {
        assert.ok(
          node.preview.length > 0,
          `${node.title}: expected non-empty preview for non-empty content`
        );
      }
    }
  });

  test('2.5 getSection: returns section content for "Alpha" without parentTitle', async () => {
    testedTools.add('get_section_content');
    const result = await withRetry(() => exClient.getSection('test_fixture.tex', 'Alpha'));
    assert.notEqual(result, null, 'getSection should return a result for an existing section');
    const content = typeof result === 'string' ? result : result?.content;
    assert.ok(
      content?.includes('Alpha section content.'),
      `Expected fixture text in result, got: "${content}"`
    );
  });

  test('2.6 getSection: with parentTitle resolves correct subsection in main.tex', async () => {
    testedTools.add('get_section_content');
    // Discover structure dynamically via the tree to avoid hardcoding subsection titles
    const tree = await withRetry(() => exClient.getSectionTree('main.tex'));
    const parent = tree.find(
      s => s.title === 'Some examples to get started' && s.children?.length > 0
    );
    assert.ok(
      parent,
      'Expected a section titled "Some examples to get started" with subsections in main.tex'
    );
    const child = parent.children[0];
    const result = await withRetry(() =>
      exClient.getSection('main.tex', child.title, parent.title)
    );
    assert.notEqual(result, null, 'getSection with parentTitle should return a result');
  });

  test('2.7 getSection: returns null for nonexistent section title', async () => {
    testedTools.add('get_section_content');
    const result = await withRetry(() =>
      exClient.getSection('test_fixture.tex', 'NonexistentSection_xyz')
    );
    assert.equal(result, null);
  });

  test('2.8 getPreamble: returns content before first section, including \\documentclass and \\usepackage{amsmath}', async () => {
    testedTools.add('get_preamble');
    const preamble = await withRetry(() => exClient.getPreamble('test_fixture.tex'));
    assert.ok(preamble.includes('\\documentclass'), 'Preamble should include \\documentclass');
    assert.ok(preamble.includes('\\usepackage{amsmath}'), 'Preamble should include \\usepackage{amsmath}');
    assert.ok(!preamble.includes('\\section{Alpha}'), 'Preamble should not include the first section heading');
  });

  test('2.9 getPostamble: returns \\end{document} for test_fixture.tex', async () => {
    testedTools.add('get_postamble');
    const postamble = await withRetry(() => exClient.getPostamble('test_fixture.tex'));
    assert.equal(
      postamble.trim(),
      '\\end{document}',
      `Expected postamble to be "\\end{document}", got: "${postamble}"`
    );
  });

  test('2.10 getPostamble: returns empty string for file without \\end{document}', async () => {
    testedTools.add('get_postamble');
    const postamble = await withRetry(() => exClient.getPostamble('test_fixture.bib'));
    assert.equal(postamble, '', 'Expected empty postamble for a .bib file');
  });
});

// ---------------------------------------------------------------------------
// Group 3: Git inspection
// ---------------------------------------------------------------------------
describe('Group 3: Git inspection', () => {
  before(() => sleep(3000));

  test('3.1 listHistory: default returns commits with hash, date, author, subject fields', async () => {
    testedTools.add('list_history');
    const history = await withRetry(() => exClient.listHistory());
    assert.ok(Array.isArray(history), 'listHistory should return an array');
    assert.ok(history.length > 0, 'Expected at least one commit');
    const entry = history[0];
    assert.ok('hash' in entry, 'Entry missing hash field');
    assert.ok('date' in entry, 'Entry missing date field');
    assert.ok('author' in entry, 'Entry missing author field');
    assert.ok('subject' in entry, 'Entry missing subject field');
  });

  test('3.2 listHistory: limit:1 returns exactly 1 entry', async () => {
    testedTools.add('list_history');
    const history = await withRetry(() => exClient.listHistory({ limit: 1 }));
    assert.equal(history.length, 1);
  });

  test('3.3 listHistory: filePath filter returns only commits touching that file', async () => {
    testedTools.add('list_history');
    const history = await withRetry(() =>
      exClient.listHistory({ filePath: 'test_fixture.tex' })
    );
    assert.ok(Array.isArray(history));
    // Setup push guarantees at least one commit touching test_fixture.tex
    assert.ok(
      history.length > 0,
      'Expected at least one commit for test_fixture.tex after setup push'
    );
  });

  test('3.4 listHistory: until date in far past returns empty array', async () => {
    testedTools.add('list_history');
    const history = await withRetry(() => exClient.listHistory({ until: '2020-01-01' }));
    assert.deepEqual(history, []);
  });

  test('3.5 getDiff: no refs returns { diff, truncated } with no differences on clean repo', async () => {
    testedTools.add('get_diff');
    const result = await withRetry(() => exClient.getDiff());
    assert.ok('diff' in result, 'Result should have a diff field');
    assert.ok('truncated' in result, 'Result should have a truncated field');
    assert.equal(typeof result.diff, 'string');
    assert.equal(typeof result.truncated, 'boolean');
    assert.equal(result.diff.trim(), '', 'Expected empty diff on a clean repo after setup push');
  });

  test('3.6 getDiff: fromRef HEAD~1 toRef HEAD returns non-empty diff', async () => {
    testedTools.add('get_diff');
    const result = await withRetry(() =>
      exClient.getDiff({ fromRef: 'HEAD~1', toRef: 'HEAD' })
    );
    assert.ok('diff' in result);
    assert.ok(result.diff.length > 0, 'Expected a non-empty diff between HEAD~1 and HEAD');
  });

  test('3.7 getDiff: contextLines:0 produces diff with no context lines', async () => {
    testedTools.add('get_diff');
    const result = await withRetry(() =>
      exClient.getDiff({ fromRef: 'HEAD~1', toRef: 'HEAD', contextLines: 0 })
    );
    assert.ok('diff' in result);
    // In unified diff format, context lines are prefixed with a single space.
    // With contextLines:0 there should be none.
    const contextLines = result.diff
      .split('\n')
      .filter(l => l.startsWith(' '));
    assert.equal(
      contextLines.length,
      0,
      `Expected no context lines with contextLines:0, found: ${JSON.stringify(contextLines)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Group 4: Write tools — dryRun (no actual writes)
// ---------------------------------------------------------------------------
describe('Group 4: Write tools — dryRun', () => {
  before(() => sleep(3000));

  test('4.1 writeFile dryRun: returns { dryRun: true, existingSize, newSize } with existingSize > 0', async () => {
    testedTools.add('write_file');
    const result = await withRetry(() =>
      exClient.writeFile(
        'test_fixture.tex',
        '\\documentclass{article}\n\\begin{document}\nReplaced.\n\\end{document}\n',
        { dryRun: true }
      )
    );
    assert.equal(result.dryRun, true);
    assert.ok(
      typeof result.existingSize === 'number' && result.existingSize > 0,
      `Expected existingSize > 0, got: ${result.existingSize}`
    );
    assert.ok(typeof result.newSize === 'number', 'Expected newSize to be a number');
  });

  test('4.2 writeSection dryRun: existing section "Alpha" returns { dryRun: true, sectionFound: true, newContentSize }', async () => {
    testedTools.add('write_section');
    const result = await withRetry(() =>
      exClient.writeSection('test_fixture.tex', 'Alpha', 'New Alpha content.\n', { dryRun: true })
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.sectionFound, true);
    assert.ok(typeof result.newContentSize === 'number', 'Expected newContentSize to be a number');
  });

  test('4.3 writeSection dryRun: nonexistent section throws "Section not found"', async () => {
    testedTools.add('write_section');
    await assert.rejects(
      () => withRetry(() =>
        exClient.writeSection(
          'test_fixture.tex',
          'NonexistentSection_xyz',
          'content',
          { dryRun: true }
        )
      ),
      /Section.*not found/i
    );
  });

  test('4.4 strReplace dryRun: unique oldStr returns { dryRun: true, anchorIndex >= 0 }', async () => {
    testedTools.add('str_replace');
    const result = await withRetry(() =>
      exClient.strReplace(
        'test_fixture.tex',
        'Alpha section content.',
        'Replacement text.',
        { dryRun: true }
      )
    );
    assert.equal(result.dryRun, true);
    assert.ok(
      typeof result.anchorIndex === 'number' && result.anchorIndex >= 0,
      `Expected non-negative anchorIndex, got: ${result.anchorIndex}`
    );
  });

  test('4.5 insertBefore dryRun: unique anchor returns { dryRun: true, anchorIndex >= 0 }', async () => {
    testedTools.add('insert_before');
    const result = await withRetry(() =>
      exClient.insertBefore(
        'test_fixture.tex',
        '\\section{Beta}',
        'Inserted before Beta.\n',
        { dryRun: true }
      )
    );
    assert.equal(result.dryRun, true);
    assert.ok(
      typeof result.anchorIndex === 'number' && result.anchorIndex >= 0,
      `Expected non-negative anchorIndex, got: ${result.anchorIndex}`
    );
  });

  test('4.6 insertAfter dryRun: unique anchor returns { dryRun: true, anchorIndex >= 0 }', async () => {
    testedTools.add('insert_after');
    const result = await withRetry(() =>
      exClient.insertAfter(
        'test_fixture.tex',
        '\\usepackage{amsmath}',
        '\n\\usepackage{amssymb}',
        { dryRun: true }
      )
    );
    assert.equal(result.dryRun, true);
    assert.ok(
      typeof result.anchorIndex === 'number' && result.anchorIndex >= 0,
      `Expected non-negative anchorIndex, got: ${result.anchorIndex}`
    );
  });

  test('4.7 addBibEntry dryRun: returns { dryRun: true, citeKey: "test2024", action: "add" }', async () => {
    testedTools.add('add_bib_entry');
    const result = await withRetry(() =>
      exClient.addBibEntry(
        'test_fixture.bib',
        '@inproceedings{test2024,\n  author = {Test, Author},\n  title  = {A Test Paper},\n  year   = {2024}\n}',
        { dryRun: true }
      )
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.citeKey, 'test2024');
    assert.equal(result.action, 'add');
  });

  test('4.8 replaceBibEntry dryRun: existing key returns { dryRun: true, citeKey: "fixture2024", action: "replace" }', async () => {
    testedTools.add('replace_bib_entry');
    const result = await withRetry(() =>
      exClient.replaceBibEntry(
        'test_fixture.bib',
        'fixture2024',
        '@article{fixture2024,\n  author  = {Fixture, Author},\n  title   = {Updated Title},\n  journal = {Test Journal},\n  year    = {2024}\n}',
        { dryRun: true }
      )
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.citeKey, 'fixture2024');
    assert.equal(result.action, 'replace');
  });

  test('4.9 removeBibEntry dryRun: existing key returns { dryRun: true, citeKey: "fixture2024", action: "remove" }', async () => {
    testedTools.add('remove_bib_entry');
    const result = await withRetry(() =>
      exClient.removeBibEntry('test_fixture.bib', 'fixture2024', { dryRun: true })
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.citeKey, 'fixture2024');
    assert.equal(result.action, 'remove');
  });
});
