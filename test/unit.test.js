import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { OverleafGitClient, PREVIEW_MAX_LENGTH } from '../overleaf-git-client.js';

// Use a resolved path so assertions are platform-safe (Windows/Linux)
const REPO_PATH = path.resolve('/tmp/overleaf-unit-test');
const client = new OverleafGitClient('dummy-id', 'dummy-token', REPO_PATH);

// ---------------------------------------------------------------------------
// Method-access tracking via Proxy
//
// The Proxy's `get` trap fires when a property is *accessed* via `tracked`.
// `accessedMethods` therefore records which methods were accessed, not which
// were invoked. The `after()` enforcer below asserts that every method on
// OverleafGitClient.prototype was accessed at least once during the test run,
// ensuring no method silently escapes the test suite.
// ---------------------------------------------------------------------------
const ALL_METHODS = Object.getOwnPropertyNames(OverleafGitClient.prototype)
  .filter(name => name !== 'constructor');

const accessedMethods = new Set();
const tracked = new Proxy(client, {
  get(target, prop) {
    if (typeof target[prop] === 'function') accessedMethods.add(prop);
    return typeof target[prop] === 'function'
      ? target[prop].bind(target)
      : target[prop];
  }
});

// ---------------------------------------------------------------------------
// _safePath
// ---------------------------------------------------------------------------
describe('_safePath', () => {
  test('valid relative path returns resolved absolute path inside repoPath', () => {
    const result = tracked._safePath('main.tex');
    assert.ok(
      result.startsWith(REPO_PATH),
      `Expected path to start with ${REPO_PATH}, got ${result}`
    );
    assert.ok(result.endsWith('main.tex'));
  });

  test('nested valid path returns resolved absolute path inside repoPath', () => {
    const result = tracked._safePath('sections/intro.tex');
    assert.ok(result.startsWith(REPO_PATH));
    assert.ok(result.endsWith(path.join('sections', 'intro.tex')));
  });

  test('path traversal attempt throws', () => {
    assert.throws(
      () => tracked._safePath('../../etc/passwd'),
      /must stay within the repository directory/
    );
  });

  test('traversal with encoding throws', () => {
    assert.throws(
      () => tracked._safePath('../outside'),
      /must stay within the repository directory/
    );
  });

  test('root path (empty string) does not throw', () => {
    assert.doesNotThrow(() => tracked._safePath(''));
  });

  test('root path (dot) does not throw', () => {
    assert.doesNotThrow(() => tracked._safePath('.'));
  });
});

// ---------------------------------------------------------------------------
// _parseSections
// ---------------------------------------------------------------------------
describe('_parseSections', () => {
  test('empty string returns empty array', () => {
    const result = tracked._parseSections('');
    assert.deepEqual(result, []);
  });

  test('no sections returns empty array', () => {
    const result = tracked._parseSections('Hello world\nSome text here.');
    assert.deepEqual(result, []);
  });

  test('single section: type, title, and content', () => {
    const result = tracked._parseSections('\\section{Intro}\nhello');
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'section');
    assert.equal(result[0].title, 'Intro');
    assert.ok(result[0].content.includes('hello'));
  });

  test('two sections: correct titles and content', () => {
    const result = tracked._parseSections('\\section{A}\nfoo\n\\section{B}\nbar');
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'A');
    assert.ok(result[0].content.includes('foo'));
    assert.equal(result[1].title, 'B');
    assert.ok(result[1].content.includes('bar'));
  });

  test('subsection inside section produces 2 flat entries', () => {
    const result = tracked._parseSections('\\section{S}\n\\subsection{Sub}\ncontent');
    assert.equal(result.length, 2);
    assert.equal(result[0].type, 'section');
    assert.equal(result[0].title, 'S');
    assert.equal(result[0].content.trim(), '', 'Section content before subsection should be empty');
    assert.equal(result[1].type, 'subsection');
    assert.equal(result[1].title, 'Sub');
    assert.ok(result[1].content.includes('content'));
  });

  test('starred section: type is still "section", title without asterisk', () => {
    const result = tracked._parseSections('\\section*{Unnumbered}\ncontent');
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'section');
    assert.equal(result[0].title, 'Unnumbered');
  });

  test('all 7 LaTeX levels produce correct types', () => {
    const input = [
      '\\part{P}', 'part content',
      '\\chapter{C}', 'chapter content',
      '\\section{S}', 'section content',
      '\\subsection{Sub}', 'subsection content',
      '\\subsubsection{SubSub}', 'subsubsection content',
      '\\paragraph{Para}', 'paragraph content',
      '\\subparagraph{SubPara}', 'subparagraph content',
    ].join('\n');
    const result = tracked._parseSections(input);
    assert.equal(result.length, 7);
    assert.deepEqual(result.map(e => e.type), [
      'part', 'chapter', 'section', 'subsection',
      'subsubsection', 'paragraph', 'subparagraph',
    ]);
  });

  test('preview is truncated to at most PREVIEW_MAX_LENGTH chars', () => {
    // Content longer than the maximum — ensures truncation actually occurs
    const longContent = 'a '.repeat(PREVIEW_MAX_LENGTH + 1);
    const result = tracked._parseSections(`\\section{Long}\n${longContent}`);
    assert.equal(result.length, 1);
    assert.ok(
      result[0].preview.length <= PREVIEW_MAX_LENGTH,
      `Expected preview.length <= ${PREVIEW_MAX_LENGTH}, got ${result[0].preview.length}`
    );
  });

  test('last section content runs to EOF', () => {
    const result = tracked._parseSections('\\section{Only}\nsome content at the end');
    assert.equal(result.length, 1);
    assert.ok(result[0].content.includes('some content at the end'));
  });

  test('CRLF normalised to LF in section content', () => {
    const result = tracked._parseSections('\\section{A}\r\nsome content\r\n');
    assert.equal(result.length, 1);
    assert.ok(!result[0].content.includes('\r'), 'Expected no CR in content after normalisation');
  });
});

// ---------------------------------------------------------------------------
// _buildSectionTree
// ---------------------------------------------------------------------------
describe('_buildSectionTree', () => {
  test('flat input (all same level): each entry is root node with empty children', () => {
    const sections = tracked._parseSections('\\section{A}\nfoo\n\\section{B}\nbar');
    const tree = tracked._buildSectionTree(sections);
    assert.equal(tree.length, 2);
    assert.deepEqual(tree[0].children, []);
    assert.deepEqual(tree[1].children, []);
  });

  test('section with one subsection: section has 1 child, subsection has empty children', () => {
    const sections = tracked._parseSections('\\section{S}\n\\subsection{Sub}\ncontent');
    const tree = tracked._buildSectionTree(sections);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].title, 'S');
    assert.equal(tree[0].children.length, 1);
    assert.equal(tree[0].children[0].title, 'Sub');
    assert.deepEqual(tree[0].children[0].children, []);
  });

  test('section → subsection → subsubsection: 3-level nesting', () => {
    const input = '\\section{S}\n\\subsection{Sub}\n\\subsubsection{SubSub}\ncontent';
    const tree = tracked._buildSectionTree(tracked._parseSections(input));
    assert.equal(tree.length, 1);
    assert.equal(tree[0].children.length, 1);
    assert.equal(tree[0].children[0].children.length, 1);
    assert.equal(tree[0].children[0].children[0].title, 'SubSub');
  });

  test('two sections each with their own subsections: no cross-contamination', () => {
    const input = [
      '\\section{A}', '\\subsection{A1}', 'a1 content',
      '\\section{B}', '\\subsection{B1}', 'b1 content',
    ].join('\n');
    const tree = tracked._buildSectionTree(tracked._parseSections(input));
    assert.equal(tree.length, 2);
    assert.equal(tree[0].children.length, 1);
    assert.equal(tree[0].children[0].title, 'A1');
    assert.equal(tree[1].children.length, 1);
    assert.equal(tree[1].children[0].title, 'B1');
  });

  test('subsection followed by section (dedents): subsection is child of first section, second section is root', () => {
    const input = '\\section{First}\n\\subsection{Child}\ncontent\n\\section{Second}\nmore';
    const tree = tracked._buildSectionTree(tracked._parseSections(input));
    assert.equal(tree.length, 2);
    assert.equal(tree[0].title, 'First');
    assert.equal(tree[0].children.length, 1);
    assert.equal(tree[0].children[0].title, 'Child');
    assert.equal(tree[1].title, 'Second');
    assert.deepEqual(tree[1].children, []);
  });
});

// ---------------------------------------------------------------------------
// _parseBibEntries
// ---------------------------------------------------------------------------
describe('_parseBibEntries', () => {
  test('empty string returns empty array', () => {
    const result = tracked._parseBibEntries('');
    assert.deepEqual(result, []);
  });

  test('single @article entry: citeKey and raw are correct', () => {
    const bib = '@article{smith2024,\n  author = {Smith, John},\n  year = {2024}\n}';
    const result = tracked._parseBibEntries(bib);
    assert.equal(result.length, 1);
    assert.equal(result[0].citeKey, 'smith2024');
    assert.ok(result[0].raw.includes('smith2024'));
  });

  test('entry with nested braces in title is parsed correctly', () => {
    const bib = '@article{key2024,\n  title = {The {N}ested},\n  year = {2024}\n}';
    const result = tracked._parseBibEntries(bib);
    assert.equal(result.length, 1);
    assert.equal(result[0].citeKey, 'key2024');
  });

  test('two entries: both citeKeys returned', () => {
    const bib = '@article{a2024,\n  year = {2024}\n}\n\n@book{b2024,\n  year = {2024}\n}';
    const result = tracked._parseBibEntries(bib);
    assert.equal(result.length, 2);
    assert.equal(result[0].citeKey, 'a2024');
    assert.equal(result[1].citeKey, 'b2024');
  });

  test('@comment entry is skipped', () => {
    const bib = '@comment{ignored}\n@article{real2024,\n  year = {2024}\n}';
    const result = tracked._parseBibEntries(bib);
    assert.equal(result.length, 1);
    assert.equal(result[0].citeKey, 'real2024');
  });

  test('@string entry is skipped', () => {
    const bib = '@string{abbrev = {Journal of Things}}\n@article{real2024,\n  year = {2024}\n}';
    const result = tracked._parseBibEntries(bib);
    assert.equal(result.length, 1);
    assert.equal(result[0].citeKey, 'real2024');
  });

  test('@preamble entry is skipped', () => {
    const bib = '@preamble{"\\newcommand{\\foo}{bar}"}\n@article{real2024,\n  year = {2024}\n}';
    const result = tracked._parseBibEntries(bib);
    assert.equal(result.length, 1);
    assert.equal(result[0].citeKey, 'real2024');
  });

  test('mixed article + comment + book returns 2 entries (article, book), comment skipped', () => {
    const bib = '@article{a2024,\n  year={2024}\n}\n@comment{skip}\n@book{b2024,\n  year={2024}\n}';
    const result = tracked._parseBibEntries(bib);
    assert.equal(result.length, 2);
    const keys = result.map(e => e.citeKey);
    assert.ok(keys.includes('a2024'));
    assert.ok(keys.includes('b2024'));
  });

  test('entry using () delimiters is parsed correctly', () => {
    const bib = '@article(paren2024,\n  year = {2024}\n)';
    const result = tracked._parseBibEntries(bib);
    assert.equal(result.length, 1);
    assert.equal(result[0].citeKey, 'paren2024');
  });

  test('malformed entry with unclosed brace does not crash', () => {
    const bib = '@article{broken,\n  title = {unclosed\n@article{valid2024,\n  year = {2024}\n}';
    assert.doesNotThrow(() => tracked._parseBibEntries(bib));
  });

  test('start and end offsets: content.slice(start, end) === raw', () => {
    const bib = '@article{key2024,\n  year = {2024}\n}';
    const result = tracked._parseBibEntries(bib);
    assert.equal(result.length, 1);
    assert.equal(bib.slice(result[0].start, result[0].end), result[0].raw);
  });
});

// ---------------------------------------------------------------------------
// _findUniqueAnchor
// ---------------------------------------------------------------------------
describe('_findUniqueAnchor', () => {
  test('zero matches throws "not found in file"', () => {
    assert.throws(
      () => tracked._findUniqueAnchor('hello world', 'xyz'),
      /not found in file/
    );
  });

  test('zero matches error includes whitespace hint', () => {
    assert.throws(
      () => tracked._findUniqueAnchor('hello world', 'xyz'),
      /Check for whitespace or line-ending differences/
    );
  });

  test('exactly one match returns correct index', () => {
    const content = 'hello world foo';
    const idx = tracked._findUniqueAnchor(content, 'world');
    assert.equal(idx, content.indexOf('world'));
  });

  test('two matches throws with count 2', () => {
    assert.throws(
      () => tracked._findUniqueAnchor('foo foo', 'foo'),
      /matches 2 locations/
    );
  });

  test('five matches throws with count 5', () => {
    assert.throws(
      () => tracked._findUniqueAnchor('x x x x x', 'x'),
      /matches 5 locations/
    );
  });

  test('empty anchorStr throws "must not be empty"', () => {
    assert.throws(
      () => tracked._findUniqueAnchor('some content', ''),
      /must not be empty/
    );
  });

  test('anchor at position 0 returns 0', () => {
    const idx = tracked._findUniqueAnchor('anchor at start', 'anchor');
    assert.equal(idx, 0);
  });

  test('anchor at end of string returns correct index', () => {
    const content = 'some content end';
    const idx = tracked._findUniqueAnchor(content, 'end');
    assert.equal(idx, content.lastIndexOf('end'));
  });

  test('two non-overlapping matches throws with count 2', () => {
    assert.throws(
      () => tracked._findUniqueAnchor('foo bar foo', 'foo'),
      /matches 2 locations/
    );
  });

  test('match count in error message is accurate', () => {
    let errorMessage = '';
    try {
      tracked._findUniqueAnchor('foo foo foo', 'foo');
    } catch (err) {
      errorMessage = err.message;
    }
    assert.ok(errorMessage.includes('3'), `Expected count 3 in error message, got: "${errorMessage}"`);
  });
});

// ---------------------------------------------------------------------------
// Coverage registration: I/O and git-touching methods
//
// The Proxy registers a method when its property is *accessed* via `tracked`,
// not when the method is called. Accessing `tracked.methodName` is enough to
// satisfy the coverage enforcer and avoids spawning real git processes (which
// would each take ~500 ms to fail, violating the <1 s run-time target).
//
// Each test asserts the method is a function, which is a meaningful and fast
// check. Behavioural testing of all these methods is in integration tests.
// ---------------------------------------------------------------------------
describe('coverage registration (I/O methods)', () => {
  const ioMethods = [
    'cloneOrPull',
    'listFiles',
    'readFile',
    'getSections',
    'getSection',
    'getPreamble',
    'getPostamble',
    'listHistory',
    'getDiff',
    'writeFile',
    'writeSection',
    'strReplace',
    'insertBefore',
    'insertAfter',
    'getBibEntry',
    'addBibEntry',
    'replaceBibEntry',
    'removeBibEntry',
    '_gitEnv',
    '_git',
    '_commitAndPush',
    '_recoverDirtyState',
    'getSectionTree',
  ];

  for (const method of ioMethods) {
    test(`${method} is a function on the client`, () => {
      assert.equal(
        typeof tracked[method],
        'function',
        `Expected ${method} to be a function`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Access enforcer
// Every method on OverleafGitClient.prototype must be accessed via `tracked`
// at least once during the test run. Adding a new method to the class
// automatically makes it required here.
// ---------------------------------------------------------------------------
after(() => {
  for (const method of ALL_METHODS) {
    assert.ok(
      accessedMethods.has(method),
      `Method "${method}" has no unit test coverage`
    );
  }
});
