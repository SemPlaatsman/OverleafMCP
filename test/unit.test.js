import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  OverleafGitClient,
  PREVIEW_MAX_LENGTH,
  SECTION_SCOPES,
  redactSecrets,
} from '../overleaf-git-client.js';

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

  test('.git directory is rejected', () => {
    for (const p of ['.git', '.git/config', '.git/hooks/pre-commit', 'sub/../.git/config']) {
      assert.throws(() => tracked._safePath(p), /\.git directory is not accessible/, p);
    }
  });

  test('.git is rejected whatever its case, and in nested folders', () => {
    for (const p of ['.GIT/config', '.Git/HEAD', 'sections/.git/config']) {
      assert.throws(() => tracked._safePath(p), /\.git directory is not accessible/, p);
    }
  });

  test('Windows spellings of .git are rejected', () => {
    // Windows ignores trailing dots and spaces in a name, "::$INDEX_ALLOCATION"
    // is an NTFS stream name for the same directory, and GIT~1 is its 8.3 short
    // name. All four open the real .git directory on Windows.
    for (const p of ['.git./config', '.git /config', '.git::$INDEX_ALLOCATION/config', 'GIT~1/config']) {
      assert.throws(() => tracked._safePath(p), /\.git directory is not accessible/, p);
    }
  });

  test('files that merely start with .git are allowed', () => {
    for (const p of ['.gitignore', '.gitattributes', '.github/workflows/build.yml', 'git/notes.tex']) {
      assert.doesNotThrow(() => tracked._safePath(p), p);
    }
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

  test('tree nodes omit content field but retain preview', () => {
    const input = '\\section{A}\nsome long content here\n\\subsection{B}\nmore content';
    const tree = tracked._buildSectionTree(tracked._parseSections(input));
    assert.equal('content' in tree[0], false, 'root node should not have content field');
    assert.equal('content' in tree[0].children[0], false, 'child node should not have content field');
    assert.ok('preview' in tree[0], 'root node should retain preview field');
    assert.ok('preview' in tree[0].children[0], 'child node should retain preview field');
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

  test('overlapping occurrences are each counted: "aa" in "aaa" is 2 by contract', () => {
    // The contract specifies strict counting: each position where the anchor
    // starts is counted independently, including overlapping positions.
    // "aa" starts at index 0 and index 1 in "aaa", so the count is 2.
    assert.throws(
      () => tracked._findUniqueAnchor('aaa', 'aa'),
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
// redactSecrets / _redact
// ---------------------------------------------------------------------------
describe('redactSecrets', () => {
  const TOKEN = 'olp_AbCdEf0123456789';

  test('removes a secret wherever it appears', () => {
    const out = redactSecrets(`fatal: unable to access 'https://git:${TOKEN}@git.overleaf.com/abc/'`, [TOKEN]);
    assert.ok(!out.includes(TOKEN));
    assert.ok(out.includes('https://git:***@git.overleaf.com/abc/'));
  });

  test('removes every occurrence', () => {
    assert.equal(redactSecrets(`${TOKEN} and again ${TOKEN}`, [TOKEN]), '*** and again ***');
  });

  test('removes the URL-encoded form', () => {
    const secret = 'tok/en+with=chars';
    const out = redactSecrets(`https://git:${encodeURIComponent(secret)}@host/x`, [secret]);
    assert.equal(out, 'https://git:***@host/x');
  });

  test('removes the Base64 "git:<secret>" form used in Basic credentials', () => {
    const basic = Buffer.from(`git:${TOKEN}`).toString('base64');
    assert.equal(redactSecrets(`Authorization: Basic ${basic}`, [TOKEN]), 'Authorization: Basic ***');
  });

  test('handles several secrets', () => {
    const other = 'another-secret-value';
    assert.equal(redactSecrets(`${TOKEN} / ${other}`, [TOKEN, other]), '*** / ***');
  });

  test('ignores secrets too short to be tokens', () => {
    assert.equal(redactSecrets('a git commit', ['git']), 'a git commit');
  });

  test('ignores missing and non-string secrets', () => {
    assert.equal(redactSecrets('unchanged', [undefined, null, 42, '']), 'unchanged');
    assert.equal(redactSecrets('unchanged'), 'unchanged');
  });

  test('removes the password from any credential-bearing URL, known secret or not', () => {
    assert.equal(
      redactSecrets("Cloning into 'x'... https://git:unknownSecret42@git.overleaf.com/abc failed"),
      "Cloning into 'x'... https://git:***@git.overleaf.com/abc failed"
    );
    assert.equal(redactSecrets('ssh://deploy:hunter2@host.example/repo.git'), 'ssh://deploy:***@host.example/repo.git');
  });

  test('leaves URLs without a password, and ordinary text with colons and @, alone', () => {
    for (const text of [
      'https://git.overleaf.com/abc',
      'https://git@git.overleaf.com/abc',
      'git@github.com:owner/repo.git',
      'see https://example.com/a:b@c for details',
      'mail someone@example.com at 10:30',
      '\\cite{a:b} and x@y',
    ]) {
      assert.equal(redactSecrets(text, []), text);
    }
  });

  test('returns non-string and empty input as is', () => {
    assert.equal(redactSecrets(undefined, [TOKEN]), undefined);
    assert.equal(redactSecrets('', [TOKEN]), '');
  });

  test('_redact removes the token the client was constructed with', () => {
    const out = tracked._redact('git clone https://git:dummy-token@git.overleaf.com/dummy-id');
    assert.equal(out, 'git clone https://git:***@git.overleaf.com/dummy-id');
  });
});

// ---------------------------------------------------------------------------
// _assertSafeRef
// ---------------------------------------------------------------------------
describe('_assertSafeRef', () => {
  test('ordinary refs are returned unchanged', () => {
    for (const ref of ['HEAD', 'HEAD~3', 'HEAD^', 'main', 'origin/main', 'v1.0', 'a1b2c3d', 'main@{1}']) {
      assert.equal(tracked._assertSafeRef(ref), ref);
    }
  });

  test('a value that git would read as an option is refused', () => {
    for (const ref of ['--output=/tmp/x', '-p', '--no-index', '-']) {
      assert.throws(() => tracked._assertSafeRef(ref, 'fromRef'), /cannot start with "-"/, ref);
    }
  });

  test('whitespace and control characters are refused', () => {
    for (const ref of ['HEAD --output=x', 'HEAD\n--output=x', 'a\tb', 'a\x00b']) {
      assert.throws(
        () => tracked._assertSafeRef(ref),
        /whitespace or control characters/,
        JSON.stringify(ref)
      );
    }
  });

  test('empty, non-string and oversized values are refused', () => {
    for (const ref of ['', null, undefined, 42, {}, 'a'.repeat(201)]) {
      assert.throws(() => tracked._assertSafeRef(ref), /non-empty string/);
    }
  });

  test('the label appears in the error', () => {
    assert.throws(() => tracked._assertSafeRef('--x', 'toRef'), /Invalid toRef/);
  });
});

// ---------------------------------------------------------------------------
// Section addressing: _assertScope, _lineOf, _closingIndex, _sectionRange,
// _resolveSection, _checkSectionReplacement
// ---------------------------------------------------------------------------
const NESTED_DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  '',
  '\\section{Alpha}',
  'Alpha text.',
  '',
  '\\subsection{Alpha Sub}',
  'Alpha sub text.',
  '',
  '\\subsubsection{Deep}',
  'Deep text.',
  '',
  '\\section{Beta}',
  'Beta text.',
  '',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '',
  '\\end{document}',
  '',
].join('\n');

const DUPLICATE_DOC = [
  '\\section{Experiment A}',
  'Intro A.',
  '',
  '\\subsection{Setup}',
  'Setup of A.',
  '',
  '\\section{Experiment B}',
  'Intro B.',
  '',
  '\\subsection{Setup}',
  'Setup of B.',
  '',
].join('\n');

function rangeText(doc, title, scope) {
  const sections = tracked._parseSections(doc);
  const target = sections.find(s => s.title === title);
  const { start, end } = tracked._sectionRange(sections, target, doc, scope);
  return doc.slice(start, end);
}

describe('_assertScope', () => {
  test('accepts every value in SECTION_SCOPES', () => {
    assert.deepEqual(SECTION_SCOPES, ['own', 'full']);
    for (const scope of SECTION_SCOPES) assert.doesNotThrow(() => tracked._assertScope(scope));
  });

  test('refuses anything else', () => {
    for (const scope of ['all', '', undefined, null, 'OWN']) {
      assert.throws(() => tracked._assertScope(scope), /Invalid scope/);
    }
  });
});

describe('_lineOf', () => {
  test('offset 0 is line 1', () => {
    assert.equal(tracked._lineOf('a\nb\nc', 0), 1);
  });

  test('counts the newlines before the offset', () => {
    assert.equal(tracked._lineOf('a\nb\nc', 2), 2);
    assert.equal(tracked._lineOf('a\nb\nc', 4), 3);
  });

  test('an offset past the end gives the last line', () => {
    assert.equal(tracked._lineOf('a\nb', 99), 2);
  });
});

describe('_closingIndex', () => {
  test('no closing material: returns content.length', () => {
    const doc = '\\section{A}\ntext\n';
    assert.equal(tracked._closingIndex(doc), doc.length);
  });

  test('only \\end{document}: returns its offset', () => {
    const doc = '\\section{A}\ntext\n\\end{document}\n';
    assert.equal(tracked._closingIndex(doc), doc.indexOf('\\end{document}'));
  });

  test('bibliography commands come before \\end{document}', () => {
    assert.equal(tracked._closingIndex(NESTED_DOC), NESTED_DOC.indexOf('\\bibliographystyle'));
  });

  test('each kind of closing marker is recognised', () => {
    const markers = [
      '\\bibliographystyle{plain}',
      '\\bibliography{refs}',
      '\\printbibliography',
      '\\printbibliography[title={References}]',
      '\\begin{thebibliography}{9}',
      '\\begin{acks}',
      '\\begin{acknowledgments}',
      '\\begin{acknowledgements}',
      '\\begin{appendices}',
      '\\appendix',
      '  \\appendix',
    ];
    for (const marker of markers) {
      const doc = `\\section{A}\ntext\n\n${marker}\nmore\n\\end{document}\n`;
      assert.equal(tracked._closingIndex(doc), doc.indexOf('\n\n') + 2, marker);
    }
  });

  test('a marker is only recognised at the start of a line', () => {
    const doc = '\\section{A}\nWe call \\printbibliography at the end.\n% \\bibliography{old}\n';
    assert.equal(tracked._closingIndex(doc), doc.length);
  });

  test('commands that merely start like a marker are not markers', () => {
    const doc = '\\section{A}\n\\appendixname is a macro.\n\\printbibliographyX\n';
    assert.equal(tracked._closingIndex(doc), doc.length);
  });

  test('markers before fromIndex are ignored', () => {
    const doc = '\\appendix\n\\section{Extra}\ntext\n';
    assert.equal(tracked._closingIndex(doc, doc.indexOf('\\section')), doc.length);
  });
});

describe('_sectionRange', () => {
  test('scope "own" stops at the next heading of any level', () => {
    assert.equal(rangeText(NESTED_DOC, 'Alpha', 'own'), '\\section{Alpha}\nAlpha text.\n\n');
  });

  test('scope "full" runs to the next heading of equal or higher level', () => {
    const text = rangeText(NESTED_DOC, 'Alpha', 'full');
    assert.ok(text.startsWith('\\section{Alpha}'));
    assert.ok(text.includes('\\subsection{Alpha Sub}'));
    assert.ok(text.includes('\\subsubsection{Deep}'));
    assert.ok(text.endsWith('Deep text.\n\n'));
    assert.ok(!text.includes('\\section{Beta}'));
  });

  test('scope defaults to "own"', () => {
    const sections = tracked._parseSections(NESTED_DOC);
    const target = sections.find(s => s.title === 'Alpha');
    assert.deepEqual(
      tracked._sectionRange(sections, target, NESTED_DOC),
      tracked._sectionRange(sections, target, NESTED_DOC, 'own')
    );
  });

  test('a subsection in scope "full" includes its own children only', () => {
    const text = rangeText(NESTED_DOC, 'Alpha Sub', 'full');
    assert.ok(text.startsWith('\\subsection{Alpha Sub}'));
    assert.ok(text.includes('Deep text.'));
    assert.ok(!text.includes('Beta'));
  });

  test('the two scopes agree for a section without subsections', () => {
    assert.equal(rangeText(NESTED_DOC, 'Deep', 'own'), rangeText(NESTED_DOC, 'Deep', 'full'));
  });

  test('the last section stops before the bibliography in both scopes', () => {
    for (const scope of SECTION_SCOPES) {
      assert.equal(rangeText(NESTED_DOC, 'Beta', scope), '\\section{Beta}\nBeta text.\n\n', scope);
    }
  });

  test('the last section stops before \\end{document} when there is no bibliography', () => {
    const doc = '\\begin{document}\n\\section{Only}\nText.\n\n\\end{document}\n';
    assert.equal(rangeText(doc, 'Only', 'full'), '\\section{Only}\nText.\n\n');
  });

  test('the last section runs to the end of a file with no closing material', () => {
    const doc = '\\section{Only}\nText.\n';
    assert.equal(rangeText(doc, 'Only', 'own'), doc);
  });

  test('a parent in scope "full" stops before closing material after its last child', () => {
    const doc = '\\section{A}\nText.\n\\subsection{B}\nChild.\n\n\\printbibliography\n\\end{document}\n';
    assert.ok(rangeText(doc, 'A', 'full').endsWith('Child.\n\n'));
  });

  test('the "own" ranges of all sections tile the body without gaps or overlap', () => {
    const sections = tracked._parseSections(NESTED_DOC);
    let cursor = sections[0].startIndex;
    for (const section of sections) {
      const { start, end } = tracked._sectionRange(sections, section, NESTED_DOC, 'own');
      assert.equal(start, cursor, section.title);
      cursor = end;
    }
    assert.equal(cursor, tracked._closingIndex(NESTED_DOC));
  });

  test('an invalid scope throws', () => {
    const sections = tracked._parseSections(NESTED_DOC);
    assert.throws(
      () => tracked._sectionRange(sections, sections[0], NESTED_DOC, 'everything'),
      /Invalid scope/
    );
  });
});

describe('_resolveSection', () => {
  const resolve = (doc, title, parent) =>
    tracked._resolveSection(tracked._parseSections(doc), doc, title, parent);

  test('a unique title resolves to its entry', () => {
    const found = resolve(NESTED_DOC, 'Beta');
    assert.equal(found.title, 'Beta');
    assert.equal(found.startIndex, NESTED_DOC.indexOf('\\section{Beta}'));
  });

  test('an unknown title resolves to null', () => {
    assert.equal(resolve(NESTED_DOC, 'Gamma'), null);
  });

  test('a title that occurs twice is refused, not resolved to the first', () => {
    assert.throws(() => resolve(DUPLICATE_DOC, 'Setup'), /matches 2 sections/);
  });

  test('the refusal lists each candidate with its parent and line, and names the remedy', () => {
    let message = '';
    try { resolve(DUPLICATE_DOC, 'Setup'); } catch (err) { message = err.message; }
    assert.ok(message.includes('"Experiment A > Setup" (line 4)'), message);
    assert.ok(message.includes('"Experiment B > Setup" (line 10)'), message);
    assert.ok(message.includes('parentTitle'), message);
  });

  test('parentTitle selects among duplicates', () => {
    const a = resolve(DUPLICATE_DOC, 'Setup', 'Experiment A');
    const b = resolve(DUPLICATE_DOC, 'Setup', 'Experiment B');
    assert.equal(a.startIndex, DUPLICATE_DOC.indexOf('\\subsection{Setup}'));
    assert.equal(b.startIndex, DUPLICATE_DOC.lastIndexOf('\\subsection{Setup}'));
  });

  test('parentTitle matches any ancestor, not only the direct parent', () => {
    assert.equal(resolve(NESTED_DOC, 'Deep', 'Alpha').title, 'Deep');
  });

  test('a parentTitle that does not contain the section resolves to null', () => {
    assert.equal(resolve(DUPLICATE_DOC, 'Setup', 'Nowhere'), null);
    assert.equal(resolve(NESTED_DOC, 'Beta', 'Alpha'), null);
  });

  test('duplicates under one parent are refused with a pointer to str_replace', () => {
    const doc = '\\section{P}\n\\subsection{Dup}\none\n\\subsection{Dup}\ntwo\n';
    assert.throws(() => resolve(doc, 'Dup', 'P'), /matches 2 sections.*str_replace/s);
  });
});

describe('_checkSectionReplacement', () => {
  const check = (doc, title, newContent, scope) => {
    const sections = tracked._parseSections(doc);
    const target = sections.find(s => s.title === title);
    return tracked._checkSectionReplacement(sections, target, doc, newContent, scope);
  };

  test('text that begins with the heading is accepted', () => {
    for (const scope of SECTION_SCOPES) {
      assert.doesNotThrow(() => check(NESTED_DOC, 'Alpha', '\\section{Alpha}\nNew text.', scope));
    }
  });

  test('blank lines and comment lines may precede the heading', () => {
    assert.doesNotThrow(
      () => check(NESTED_DOC, 'Alpha', '\n% revised\n\\section{Alpha}\nNew text.', 'own')
    );
  });

  test('the heading may be renamed or change level', () => {
    assert.doesNotThrow(() => check(NESTED_DOC, 'Alpha', '\\section*{Introduction}\nNew text.', 'own'));
    assert.doesNotThrow(
      () => check(NESTED_DOC, 'Alpha Sub', '\\subsubsection{Alpha Sub}\nNew text.', 'own')
    );
  });

  test('text without a heading is refused in both scopes', () => {
    for (const scope of SECTION_SCOPES) {
      assert.throws(
        () => check(NESTED_DOC, 'Alpha', 'Just the new body text.', scope),
        /must begin with the section's heading line.*\\section\{Alpha\}/s,
        scope
      );
    }
  });

  test('text that puts prose before the heading is refused', () => {
    assert.throws(
      () => check(NESTED_DOC, 'Alpha', 'Some prose.\n\\section{Alpha}\nText.', 'own'),
      /must begin with the section's heading line/
    );
  });

  test('an empty string is refused', () => {
    assert.throws(
      () => check(NESTED_DOC, 'Alpha', '', 'own'),
      /must begin with the section's heading line/
    );
  });

  test('a non-string is refused', () => {
    assert.throws(() => check(NESTED_DOC, 'Alpha', undefined, 'own'), /must be a string/);
  });

  test('scope "own": repeating a nested subsection that is kept is refused', () => {
    const newContent = '\\section{Alpha}\nNew text.\n\n\\subsection{Alpha Sub}\nRewritten sub.';
    assert.throws(
      () => check(NESTED_DOC, 'Alpha', newContent, 'own'),
      /would duplicate it.*scope "full"/s
    );
  });

  test('scope "own": a deeper descendant that is kept is also caught', () => {
    const newContent = '\\section{Alpha}\nNew text.\n\n\\subsubsection{Deep}\nRewritten.';
    assert.throws(() => check(NESTED_DOC, 'Alpha', newContent, 'own'), /\\subsubsection\{Deep\}/);
  });

  test('scope "own": adding a subsection that does not exist yet is accepted', () => {
    const newContent = '\\section{Alpha}\nNew text.\n\n\\subsection{Brand New}\nFresh.';
    assert.doesNotThrow(() => check(NESTED_DOC, 'Alpha', newContent, 'own'));
  });

  test('scope "own": the same title elsewhere in the file is not a kept child', () => {
    const newContent = '\\section{Beta}\nNew text.\n\n\\subsection{Alpha Sub}\nSame title elsewhere.';
    assert.doesNotThrow(() => check(NESTED_DOC, 'Beta', newContent, 'own'));
  });

  test('scope "full": repeating nested subsections is the point, and accepted', () => {
    const newContent = '\\section{Alpha}\nNew text.\n\n\\subsection{Alpha Sub}\nRewritten sub.';
    assert.doesNotThrow(() => check(NESTED_DOC, 'Alpha', newContent, 'full'));
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
// check. Behavioural testing of these methods is in the local-repository tests
// (test/local-repo.test.js, no network) and the integration tests (live Overleaf).
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
    '_runGit',
    '_resolveRef',
    '_operationInProgress',
    '_abortInProgress',
    '_setAsideConflictingCommits',
    '_commitAndPush',
    '_recoverDirtyState',
    '_readRaw',
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
