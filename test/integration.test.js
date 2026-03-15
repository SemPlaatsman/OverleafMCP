import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OverleafGitClient, PREVIEW_MAX_LENGTH } from '../overleaf-git-client.js';
import { TOOL_NAMES, getProject } from '../overleaf-mcp-server.js';

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
  path.join(TEMP_DIR, 'integration')
);
const roClient = new OverleafGitClient(
  roProjectId,
  roToken,
  path.join(TEMP_DIR, 'integration')
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
// Global teardown: restore fixture files regardless of test outcome,
// then enforce tool coverage.
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

  // Tool coverage enforcer.
  // Tools in SERVER_LAYER_TOOLS are excluded from the strict per-tool coverage check
  // because they have no direct client-method equivalent and are tested through other
  // means (e.g. list_projects logic is exercised by Group 8 via getProject; status_summary
  // composes listFiles + getSections which are individually tested).
  // Any future tool added to this set requires explicit justification and a corresponding
  // test of its server-layer logic, even if it cannot be tested through the client.
  const SERVER_LAYER_TOOLS = new Set(['list_projects', 'status_summary']);
  for (const name of TOOL_NAMES) {
    if (SERVER_LAYER_TOOLS.has(name)) continue;
    assert.ok(
      testedTools.has(name),
      `Tool "${name}" has no integration test coverage`
    );
  }
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

// ---------------------------------------------------------------------------
// Group 5: Write tools — actual writes (against test_fixture.tex)
//
// State flow:
//   5.1/5.2 replace the full file (push:true each time).
//   Before 5.3, the fixture is restored with push:false so that the restore
//   commit is bundled into 5.3's push:true.
//   5.4 replaces only Alpha Sub (requires it to exist from 5.3); 5.5 restores
//   the fixture and then replaces the entire Alpha section, consuming the subsection.
//   Before 5.6 the fixture is restored again (push:false, bundled into 5.6).
//   Before 5.8 the fixture is restored again (push:false, bundled into 5.8).
// ---------------------------------------------------------------------------
describe('Group 5: Write tools — actual writes', () => {
  before(() => sleep(3000));

  test('5.1 writeFile: replace test_fixture.tex content (push:true)', async () => {
    testedTools.add('write_file');
    const newContent = '\\documentclass{article}\n\\begin{document}\nReplaced in 5.1.\n\\end{document}\n';
    await withRetry(() =>
      exClient.writeFile('test_fixture.tex', newContent, {
        push: true,
        commitMessage: 'test 5.1: writeFile replacement',
      })
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.tex'));
    assert.equal(content, newContent, 'readFile should return the new content');
    const history = await withRetry(() => exClient.listHistory({ limit: 1 }));
    assert.ok(
      history[0].subject.includes('5.1'),
      `Expected 5.1 commit in history, got: ${history[0].subject}`
    );
  });

  test('5.2 writeFile: push:false then identical content push:true flushes pending commit', async () => {
    testedTools.add('write_file');
    const newContent = '\\documentclass{article}\n\\begin{document}\nReplaced in 5.2.\n\\end{document}\n';
    // First call: create a local-only commit
    await withRetry(() =>
      exClient.writeFile('test_fixture.tex', newContent, {
        push: false,
        commitMessage: 'test 5.2a: writeFile push:false',
      })
    );
    // Second call: same content — should flush the pending local commit
    const result = await withRetry(() =>
      exClient.writeFile('test_fixture.tex', newContent, {
        push: true,
        commitMessage: 'test 5.2b: writeFile identical content push:true',
      })
    );
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    assert.ok(
      resultStr.includes('pushed any pending local commits'),
      `Expected "pushed any pending local commits" in result, got: ${resultStr}`
    );
    const history = await withRetry(() => exClient.listHistory({ limit: 3 }));
    assert.ok(
      history.some(h => h.subject.includes('5.2')),
      `Expected a 5.2 commit in recent history, got: ${JSON.stringify(history.map(h => h.subject))}`
    );
  });

  test('5.3 writeSection: replace "Alpha" section (push:true)', async () => {
    testedTools.add('write_section');
    // Restore fixture with push:false — bundled into this test's push:true
    await withRetry(() =>
      exClient.writeFile('test_fixture.tex', FIXTURE_TEX, {
        push: false,
        commitMessage: 'test: restore fixture for 5.3',
      })
    );
    const newAlpha = 'New Alpha intro.\n\n\\subsection{Alpha Sub}\nNew Alpha sub content.\n';
    await withRetry(() =>
      exClient.writeSection('test_fixture.tex', 'Alpha', newAlpha, {
        push: true,
        commitMessage: 'test 5.3: writeSection Alpha replacement',
      })
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.tex'));
    assert.ok(content.includes('New Alpha intro.'), 'Alpha intro should be replaced');
    assert.ok(!content.includes('Alpha section content.'), 'Old Alpha content should be gone');
    assert.ok(content.includes('Beta section content.'), 'Beta should be untouched');
    const history = await withRetry(() => exClient.listHistory({ limit: 1 }));
    assert.ok(
      history[0].subject.includes('5.3'),
      `Expected 5.3 commit in history, got: ${history[0].subject}`
    );
  });


  test('5.4 writeSection: replace "Alpha Sub" subsection only (push:false)', async () => {
    testedTools.add('write_section');
    // Alpha Sub exists from 5.3
    await withRetry(() =>
      exClient.writeSection(
        'test_fixture.tex',
        'Alpha Sub',
        'Standalone subsection replacement.\n',
        {
          push: false,
          commitMessage: 'test 5.4: writeSection Alpha Sub only',
        }
      )
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.tex'));
    assert.ok(
      content.includes('Standalone subsection replacement.'),
      'Alpha Sub content should be replaced'
    );
    assert.ok(
      content.includes('New Alpha intro.'),
      'Alpha intro from 5.3 should be untouched'
    );
    assert.ok(content.includes('Beta section content.'), 'Beta should be untouched');
  });

  test('5.5 writeSection: level-aware boundary for "Alpha" consumes subsection (push:false)', async () => {
    testedTools.add('write_section');
    // writeSection replaces FROM the section heading itself. After 5.3, \section{Alpha} was
    // consumed. Restore the fixture first so \section{Alpha} and \subsection{Alpha Sub} both
    // exist, then verify that writing 'Alpha' consumes the subsection up to \section{Beta}.
    await withRetry(() =>
      exClient.writeFile('test_fixture.tex', FIXTURE_TEX, {
        push: false,
        commitMessage: 'test: restore fixture for 5.5',
      })
    );
    await withRetry(() =>
      exClient.writeSection(
        'test_fixture.tex',
        'Alpha',
        'Level-aware replacement, no subsection.\n',
        {
          push: false,
          commitMessage: 'test 5.5: writeSection Alpha consumes subsection',
        }
      )
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.tex'));
    assert.ok(
      content.includes('Level-aware replacement, no subsection.'),
      'New Alpha content should be present'
    );
    assert.ok(
      !content.includes('Alpha subsection content.'),
      'Alpha Sub content should be consumed'
    );
    assert.ok(content.includes('Beta section content.'), 'Beta should be untouched');
  });

  test('5.6 strReplace: replace unique string (push:true)', async () => {
    testedTools.add('str_replace');
    // Restore fixture with push:false — bundled into this test's push:true
    await withRetry(() =>
      exClient.writeFile('test_fixture.tex', FIXTURE_TEX, {
        push: false,
        commitMessage: 'test: restore fixture for 5.6',
      })
    );
    await withRetry(() =>
      exClient.strReplace(
        'test_fixture.tex',
        'Alpha section content.',
        'strReplace was here.',
        {
          push: true,
          commitMessage: 'test 5.6: strReplace unique string',
        }
      )
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.tex'));
    assert.ok(content.includes('strReplace was here.'), 'Replacement should be present');
    assert.ok(!content.includes('Alpha section content.'), 'Original string should be gone');
    const history = await withRetry(() => exClient.listHistory({ limit: 1 }));
    assert.ok(
      history[0].subject.includes('5.6'),
      `Expected 5.6 commit in history, got: ${history[0].subject}`
    );
  });

  test('5.7 strReplace: empty newStr deletes the string (push:false)', async () => {
    testedTools.add('str_replace');
    await withRetry(() =>
      exClient.strReplace('test_fixture.tex', 'strReplace was here.', '', {
        push: false,
        commitMessage: 'test 5.7: strReplace deletion',
      })
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.tex'));
    assert.ok(!content.includes('strReplace was here.'), 'Deleted string should be absent');
  });

  test('5.8 insertBefore: insert before \\section{Beta} (push:true)', async () => {
    testedTools.add('insert_before');
    // Restore fixture with push:false — bundled into this test's push:true
    await withRetry(() =>
      exClient.writeFile('test_fixture.tex', FIXTURE_TEX, {
        push: false,
        commitMessage: 'test: restore fixture for 5.8',
      })
    );
    await withRetry(() =>
      exClient.insertBefore(
        'test_fixture.tex',
        '\\section{Beta}',
        'Inserted before Beta.\n\n',
        {
          push: true,
          commitMessage: 'test 5.8: insertBefore Beta',
        }
      )
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.tex'));
    const insertIdx = content.indexOf('Inserted before Beta.');
    const betaIdx = content.indexOf('\\section{Beta}');
    assert.ok(insertIdx >= 0, 'Inserted content should be present');
    assert.ok(insertIdx < betaIdx, 'Inserted content should appear before \\section{Beta}');
    const history = await withRetry(() => exClient.listHistory({ limit: 1 }));
    assert.ok(
      history[0].subject.includes('5.8'),
      `Expected 5.8 commit in history, got: ${history[0].subject}`
    );
  });

  test('5.9 insertAfter: insert after \\usepackage{amsmath} (push:true)', async () => {
    testedTools.add('insert_after');
    await withRetry(() =>
      exClient.insertAfter(
        'test_fixture.tex',
        '\\usepackage{amsmath}',
        '\n\\usepackage{amssymb}',
        {
          push: true,
          commitMessage: 'test 5.9: insertAfter amsmath',
        }
      )
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.tex'));
    const amsmathIdx = content.indexOf('\\usepackage{amsmath}');
    const amssymbIdx = content.indexOf('\\usepackage{amssymb}');
    assert.ok(amssymbIdx >= 0, 'Inserted \\usepackage{amssymb} should be present');
    assert.ok(amssymbIdx > amsmathIdx, '\\usepackage{amssymb} should appear after \\usepackage{amsmath}');
    const history = await withRetry(() => exClient.listHistory({ limit: 1 }));
    assert.ok(
      history[0].subject.includes('5.9'),
      `Expected 5.9 commit in history, got: ${history[0].subject}`
    );
  });
});

// ---------------------------------------------------------------------------
// Group 6: Write tool error paths (no actual writes)
//
// Restores FIXTURE_TEX with push:false in before() so that the file is in
// a known state for the anchor-counting assertions. The pending restore commit
// is pushed by the first push:true in Group 7.
// ---------------------------------------------------------------------------
describe('Group 6: Write tool error paths', () => {
  before(async () => {
    await sleep(3000);
    // Restore fixture to known state — push:false so no extra push budget consumed
    await withRetry(() =>
      exClient.writeFile('test_fixture.tex', FIXTURE_TEX, {
        push: false,
        commitMessage: 'test: restore fixture for Group 6',
      })
    );
  });

  test('6.1 writeSection: nonexistent section throws "Section … not found"', async () => {
    testedTools.add('write_section');
    await assert.rejects(
      () => withRetry(() => exClient.writeSection('test_fixture.tex', 'NonexistentSection_xyz', 'content')),
      /Section.*not found/i
    );
  });

  test('6.2 strReplace: oldStr not in file throws "not found in file"', async () => {
    testedTools.add('str_replace');
    await assert.rejects(
      () => withRetry(() => exClient.strReplace(
        'test_fixture.tex',
        'this_string_is_absolutely_not_in_the_fixture',
        'replacement'
      )),
      /not found in file/i
    );
  });

  test('6.3 strReplace: oldStr matches 3 places — error message contains "3"', async () => {
    testedTools.add('str_replace');
    // 'content.' appears in FIXTURE_TEX exactly 3 times:
    //   "Alpha section content."
    //   "Alpha subsection content."
    //   "Beta section content."
    await assert.rejects(
      () => withRetry(() => exClient.strReplace('test_fixture.tex', 'content.', 'replacement')),
      /matches 3 locations/
    );
  });

  test('6.4 insertBefore: anchor not found throws "not found in file"', async () => {
    testedTools.add('insert_before');
    await assert.rejects(
      () => withRetry(() => exClient.insertBefore('test_fixture.tex', 'anchor_not_in_fixture_xyz', 'content')),
      /not found in file/i
    );
  });

  test('6.5 insertBefore: anchor matches 4 places — error message contains "4"', async () => {
    testedTools.add('insert_before');
    // 'Alpha' appears in FIXTURE_TEX exactly 4 times:
    //   \section{Alpha}, Alpha section content., \subsection{Alpha Sub}, Alpha subsection content.
    await assert.rejects(
      () => withRetry(() => exClient.insertBefore('test_fixture.tex', 'Alpha', 'content')),
      /matches 4 locations/
    );
  });

  test('6.6 insertAfter: anchor not found throws "not found in file"', async () => {
    testedTools.add('insert_after');
    await assert.rejects(
      () => withRetry(() => exClient.insertAfter('test_fixture.tex', 'anchor_not_in_fixture_xyz', 'content')),
      /not found in file/i
    );
  });

  test('6.7 insertAfter: anchor matches 2 places — error message contains "2"', async () => {
    testedTools.add('insert_after');
    // '\\section{' appears in FIXTURE_TEX exactly 2 times: \section{Alpha} and \section{Beta}.
    // Wrapped in withRetry so transient 403s from cloneOrPull are retried before the
    // anchor-count validation error propagates to assert.rejects.
    await assert.rejects(
      () => withRetry(() => exClient.insertAfter('test_fixture.tex', '\\section{', 'content')),
      /matches 2 locations/
    );
  });
});

// ---------------------------------------------------------------------------
// Group 7: BibTeX tools (against test_fixture.bib)
//
// Tests build sequentially on each other's state. State after each test:
//   7.3: [fixture2024, test2024]
//   7.5: [fixture2024, test2024, test2024b]          (push:false)
//   7.6: [fixture2024, test2024(replaced), test2024b] (push:true — also pushes 7.5)
//   7.7: [fixture2024, test2024(replaced), test2024new] (push:false, key rename)
//   7.9: [fixture2024, test2024new]                  (push:true — also pushes 7.7)
//   7.10: [fixture2024]                              (push:false)
//   7.11: []                                         (push:true — also pushes 7.10)
// ---------------------------------------------------------------------------
describe('Group 7: BibTeX tools', () => {
  before(() => sleep(3000));

  test('7.1 getBibEntry: existing key "fixture2024" returns raw BibTeX with nested braces intact', async () => {
    testedTools.add('get_bib_entry');
    const entry = await withRetry(() => exClient.getBibEntry('test_fixture.bib', 'fixture2024'));
    assert.ok(entry !== null, 'getBibEntry should return a value for existing key');
    assert.ok(entry.includes('fixture2024'), 'Entry should contain the cite key');
    assert.ok(entry.includes('{F}'), 'Nested braces in title should be intact');
  });

  test('7.2 getBibEntry: nonexistent key returns null', async () => {
    testedTools.add('get_bib_entry');
    const entry = await withRetry(() => exClient.getBibEntry('test_fixture.bib', 'nonexistent_key_xyz'));
    assert.equal(entry, null);
  });

  test('7.3 addBibEntry: add @inproceedings{test2024} with nested braces (push:true)', async () => {
    testedTools.add('add_bib_entry');
    const newEntry = '@inproceedings{test2024,\n    author = {Test, Author},\n    title  = {The {T}est {P}aper},\n    year   = {2024}\n}';
    await withRetry(() =>
      exClient.addBibEntry('test_fixture.bib', newEntry, {
        push: true,
        commitMessage: 'test 7.3: addBibEntry test2024',
      })
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.bib'));
    assert.ok(content.includes('test2024'), 'New entry should appear in file');
    assert.ok(content.includes('{T}'), 'Nested braces should be preserved');
    assert.ok(content.includes('}\n\n@'), 'Blank line separator should be present between entries');
    const history = await withRetry(() =>
      exClient.listHistory({ limit: 1, filePath: 'test_fixture.bib' })
    );
    assert.ok(history.length > 0, 'Expected a commit touching test_fixture.bib');
  });

  test('7.4 addBibEntry: duplicate key throws "already exists"', async () => {
    testedTools.add('add_bib_entry');
    await assert.rejects(
      () => exClient.addBibEntry(
        'test_fixture.bib',
        '@article{test2024,\n    author = {Dup, Author},\n    year   = {2024}\n}'
      ),
      /already exists/i
    );
  });

  test('7.5 addBibEntry: add second entry test2024b — one blank line between entries (push:false)', async () => {
    testedTools.add('add_bib_entry');
    const newEntry = '@inproceedings{test2024b,\n    author = {Another, Author},\n    title  = {Another {P}aper},\n    year   = {2024}\n}';
    await withRetry(() =>
      exClient.addBibEntry('test_fixture.bib', newEntry, {
        push: false,
        commitMessage: 'test 7.5: addBibEntry test2024b',
      })
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.bib'));
    assert.ok(content.includes('test2024b'), 'test2024b should be in file');
    assert.ok(!content.includes('\n\n\n'), 'No double blank lines between entries');
    assert.ok(!content.endsWith('\n\n'), 'No trailing blank line at end of file');
  });

  test('7.6 replaceBibEntry: replace "test2024" with new content (push:true)', async () => {
    testedTools.add('replace_bib_entry');
    const newContent = '@article{test2024,\n    author  = {Replaced, Author},\n    title   = {The {R}eplaced {P}aper},\n    journal = {Test Journal},\n    year    = {2024}\n}';
    await withRetry(() =>
      exClient.replaceBibEntry('test_fixture.bib', 'test2024', newContent, {
        push: true,
        commitMessage: 'test 7.6: replaceBibEntry test2024',
      })
    );
    const entry = await withRetry(() => exClient.getBibEntry('test_fixture.bib', 'test2024'));
    assert.ok(entry !== null, 'test2024 should still exist');
    assert.ok(entry.includes('Replaced, Author'), 'Entry should contain the new author');
    const history = await withRetry(() =>
      exClient.listHistory({ limit: 1, filePath: 'test_fixture.bib' })
    );
    assert.ok(history.length > 0, 'Expected a commit touching test_fixture.bib');
  });

  test('7.7 replaceBibEntry: rename key from "test2024b" to "test2024new" (push:false)', async () => {
    testedTools.add('replace_bib_entry');
    const renamedEntry = '@inproceedings{test2024new,\n    author = {Renamed, Author},\n    title  = {The {R}enamed {P}aper},\n    year   = {2024}\n}';
    await withRetry(() =>
      exClient.replaceBibEntry('test_fixture.bib', 'test2024b', renamedEntry, {
        push: false,
        commitMessage: 'test 7.7: replaceBibEntry rename test2024b to test2024new',
      })
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.bib'));
    assert.ok(!content.includes('test2024b'), 'Old key test2024b should be gone');
    assert.ok(content.includes('test2024new'), 'New key test2024new should be present');
  });

  test('7.8 replaceBibEntry: nonexistent key throws "not found"', async () => {
    testedTools.add('replace_bib_entry');
    await assert.rejects(
      () => exClient.replaceBibEntry(
        'test_fixture.bib',
        'nonexistent_key_xyz',
        '@article{nonexistent_key_xyz,\n    year = {2024}\n}'
      ),
      /not found/i
    );
  });

  test('7.9 removeBibEntry: remove middle entry "test2024" with 3 entries present (push:true)', async () => {
    testedTools.add('remove_bib_entry');
    // State: [fixture2024, test2024(replaced), test2024new]
    await withRetry(() =>
      exClient.removeBibEntry('test_fixture.bib', 'test2024', {
        push: true,
        commitMessage: 'test 7.9: removeBibEntry test2024 (middle entry)',
      })
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.bib'));
    assert.ok(!content.includes('test2024,'), 'test2024 should be removed');
    assert.ok(content.includes('fixture2024'), 'fixture2024 should still be present');
    assert.ok(content.includes('test2024new'), 'test2024new should still be present');
    assert.ok(!content.includes('\n\n\n'), 'No double blank lines between remaining entries');
    const history = await withRetry(() =>
      exClient.listHistory({ limit: 1, filePath: 'test_fixture.bib' })
    );
    assert.ok(history.length > 0, 'Expected a commit touching test_fixture.bib');
  });

  test('7.10 removeBibEntry: remove "test2024new" (push:false) — file ends with single newline', async () => {
    testedTools.add('remove_bib_entry');
    await withRetry(() =>
      exClient.removeBibEntry('test_fixture.bib', 'test2024new', {
        push: false,
        commitMessage: 'test 7.10: removeBibEntry test2024new',
      })
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.bib'));
    assert.ok(!content.includes('test2024new'), 'test2024new should be removed');
    assert.ok(content.includes('fixture2024'), 'fixture2024 should still be present');
    assert.ok(content.endsWith('\n'), 'File should end with a newline');
    assert.ok(!content.endsWith('\n\n'), 'File should not end with a blank line');
  });

  test('7.11 removeBibEntry: remove last remaining entry "fixture2024" (push:true)', async () => {
    testedTools.add('remove_bib_entry');
    await withRetry(() =>
      exClient.removeBibEntry('test_fixture.bib', 'fixture2024', {
        push: true,
        commitMessage: 'test 7.11: removeBibEntry fixture2024 (last entry)',
      })
    );
    const content = await withRetry(() => exClient.readFile('test_fixture.bib'));
    assert.ok(!content.includes('fixture2024'), 'fixture2024 should be removed');
    assert.equal(content.trim(), '', 'File should be empty after removing last entry');
    const history = await withRetry(() =>
      exClient.listHistory({ limit: 1, filePath: 'test_fixture.bib' })
    );
    assert.ok(history.length > 0, 'Expected a commit touching test_fixture.bib');
  });

  test('7.12 removeBibEntry: nonexistent key throws "not found"', async () => {
    testedTools.add('remove_bib_entry');
    await assert.rejects(
      () => exClient.removeBibEntry('test_fixture.bib', 'nonexistent_key_xyz'),
      /not found/i
    );
  });
});

// ---------------------------------------------------------------------------
// Group 8: Permission guard
//
// Uses the exported getProject(projectName, config) function directly with
// inline config objects. No subprocess, no MCP protocol overhead. Tests
// verify that the config resolution logic (readOnly precedence, per-project
// vs global defaults inheritance) produces the correct disallowedTools set.
//
// list_projects and status_summary are excluded from the tool coverage enforcer
// (see after() hook) because they are server-layer-only with no client method
// equivalent.
// ---------------------------------------------------------------------------
describe('Group 8: Permission guard', () => {
  before(() => sleep(3000));

  const WRITE_TOOL_NAMES = [
    'write_file', 'write_section', 'str_replace',
    'insert_before', 'insert_after',
    'add_bib_entry', 'replace_bib_entry', 'remove_bib_entry',
  ];

  test('8.1 readOnly: true puts all write tools in disallowedTools set', () => {
    const cfg = {
      projects: {
        ro: { projectId: roProjectId, gitToken: roToken, readOnly: true },
      },
    };
    const { readOnly, disallowedTools } = getProject('ro', cfg);
    assert.equal(readOnly, true, 'readOnly should be true');
    for (const tool of WRITE_TOOL_NAMES) {
      assert.ok(
        disallowedTools.has(tool),
        `Expected "${tool}" to be in disallowedTools for readOnly project`
      );
    }
  });

  test('8.2 read from readonly_example_project succeeds', async () => {
    const files = await withRetry(() => roClient.listFiles('.tex'));
    assert.ok(Array.isArray(files), 'listFiles should return an array');
    assert.ok(files.length > 0, 'Expected at least one .tex file in readonly project');
  });

  test('8.3 per-project disallowedTools: [write_file] blocks write_file only', () => {
    const cfg = {
      projects: {
        example_project: {
          projectId: exProjectId,
          gitToken: exToken,
          readOnly: false,
          disallowedTools: ['write_file'],
        },
      },
    };
    const { readOnly, disallowedTools } = getProject('example_project', cfg);
    assert.equal(readOnly, false);
    assert.ok(disallowedTools.has('write_file'), '"write_file" should be disallowed');
  });

  test('8.4 per-project disallowedTools: [write_file] does not block str_replace', () => {
    const cfg = {
      projects: {
        example_project: {
          projectId: exProjectId,
          gitToken: exToken,
          readOnly: false,
          disallowedTools: ['write_file'],
        },
      },
    };
    const { disallowedTools } = getProject('example_project', cfg);
    assert.ok(!disallowedTools.has('str_replace'), '"str_replace" should not be disallowed');
  });

  test('8.5 global defaults.disallowedTools: [write_file] blocks when no per-project override', () => {
    const cfg = {
      defaults: { disallowedTools: ['write_file'] },
      projects: {
        example_project: { projectId: exProjectId, gitToken: exToken },
      },
    };
    const { disallowedTools } = getProject('example_project', cfg);
    assert.ok(disallowedTools.has('write_file'), '"write_file" should be blocked via global default');
  });

  test('8.6 per-project disallowedTools: [] overrides global default', () => {
    const cfg = {
      defaults: { disallowedTools: ['write_file'] },
      projects: {
        example_project: {
          projectId: exProjectId,
          gitToken: exToken,
          disallowedTools: [],
        },
      },
    };
    const { disallowedTools } = getProject('example_project', cfg);
    assert.ok(
      !disallowedTools.has('write_file'),
      '"write_file" should NOT be disallowed (per-project empty list overrides global)'
    );
  });
});
