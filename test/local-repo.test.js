// Local-repository tests.
//
// These exercise the git-touching code paths against a bare repository on the
// local disk that stands in for Overleaf. They need git but no network, no
// projects.json and no token, so they run anywhere the unit tests run.
//
// They exist because some behaviour cannot be reached by the pure unit tests
// (it needs a real repository) and cannot be staged safely against live
// Overleaf (it needs a second writer and a conflict on demand).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OverleafGitClient } from '../overleaf-git-client.js';

// ---------------------------------------------------------------------------
// Environment
//
// Every git process, the client's included, gets an empty global configuration
// and no system configuration. The tests then behave the same on every machine,
// whatever the developer has configured (commit signing, hooks, autocrlf).
// ---------------------------------------------------------------------------
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'overleaf-mcp-local-'));
const EMPTY_GIT_CONFIG = path.join(ROOT, 'empty.gitconfig');
writeFileSync(EMPTY_GIT_CONFIG, '');

const TEST_ENV = {
  GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  OVERLEAF_GIT_AUTHOR_NAME: 'OverleafMCP Agent',
  OVERLEAF_GIT_AUTHOR_EMAIL: 'agent@example.invalid',
};
const savedEnv = {};

before(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const COLLABORATOR_ENV = {
  ...process.env,
  ...TEST_ENV,
  GIT_AUTHOR_NAME: 'Collaborator',
  GIT_AUTHOR_EMAIL: 'collaborator@example.invalid',
  GIT_COMMITTER_NAME: 'Collaborator',
  GIT_COMMITTER_EMAIL: 'collaborator@example.invalid',
};

/** Run git as the collaborator. Returns stdout. Throws if git fails. */
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: COLLABORATOR_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// A token-shaped string. It never reaches a network; it is here so the tests
// can assert that it never reaches an error message either.
const TOKEN = 'olp_LocalTestToken0123456789';

let projectCounter = 0;

/**
 * Create a bare "remote" seeded with the given files, a collaborator's clone
 * of it, and an OverleafGitClient pointed at it.
 */
function makeProject(files) {
  const dir = path.join(ROOT, `p${++projectCounter}`);
  const remote = path.join(dir, 'remote.git');
  const collaborator = path.join(dir, 'collaborator');
  mkdirSync(dir, { recursive: true });

  execFileSync('git', ['init', '--quiet', '--bare', remote], { env: COLLABORATOR_ENV });
  execFileSync('git', ['init', '--quiet', collaborator], { env: COLLABORATOR_ENV });
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(collaborator, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(collaborator, 'add', '-A');
  git(collaborator, 'commit', '--quiet', '-m', 'Initial content');
  git(collaborator, 'branch', '-M', 'main');
  git(collaborator, 'remote', 'add', 'origin', remote);
  git(collaborator, 'push', '--quiet', '-u', 'origin', 'main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  const client = new OverleafGitClient('project', TOKEN, path.join(dir, 'clones'));
  client._repoUrl = remote; // the only difference from a real project
  const clone = client.localPath;

  return {
    dir,
    remote,
    collaborator,
    client,
    clone,
    /** The collaborator edits a file and pushes, as a co-author in Overleaf would. */
    collaboratorEdits(name, transform, message = 'Collaborator edit') {
      git(collaborator, 'pull', '--quiet', '--rebase');
      const full = path.join(collaborator, name);
      writeFileSync(full, transform(readFileSync(full, 'utf8')));
      git(collaborator, 'commit', '--quiet', '-am', message);
      git(collaborator, 'push', '--quiet');
    },
    /** Content of a file at the tip of the remote. */
    remoteFile(name) {
      return git(remote, 'show', `refs/heads/main:${name}`);
    },
    remoteHead() {
      return git(remote, 'rev-parse', 'refs/heads/main').trim();
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const MAIN_TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  '',
  '\\section{Alpha}',
  'Alpha section content.',
  '',
  '\\subsection{Alpha Sub}',
  'Alpha subsection content.',
  '',
  '\\section{Beta}',
  'Beta section content.',
  '',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '',
  '\\end{document}',
  '',
].join('\n');

const DUPLICATES_TEX = [
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

const REFS_BIB = '@article{a2024,\n  title = {A},\n  year = {2024}\n}\n';

const standardFiles = () => ({
  'main.tex': MAIN_TEX,
  'duplicates.tex': DUPLICATES_TEX,
  'refs.bib': REFS_BIB,
});

// ---------------------------------------------------------------------------
// a section that is read and written back keeps its subsections
// ---------------------------------------------------------------------------
describe('section read and write cover the same text', { concurrency: true }, () => {
  test('default scope returns the heading and own text, without the subsection', async () => {
    const { client } = makeProject(standardFiles());
    const section = await client.getSection('main.tex', 'Alpha');
    assert.equal(section.scope, 'own');
    assert.equal(section.content, '\\section{Alpha}\nAlpha section content.');
  });

  test('scope "full" returns the section with its subsections and nothing after', async () => {
    const { client } = makeProject(standardFiles());
    const section = await client.getSection('main.tex', 'Alpha', null, { scope: 'full' });
    assert.equal(
      section.content,
      '\\section{Alpha}\nAlpha section content.\n\n\\subsection{Alpha Sub}\nAlpha subsection content.'
    );
  });

  test('writing back what was read changes nothing, in either scope', async () => {
    const { client, remoteFile } = makeProject(standardFiles());
    for (const scope of ['own', 'full']) {
      for (const title of ['Alpha', 'Alpha Sub', 'Beta']) {
        const section = await client.getSection('main.tex', title, null, { scope });
        const result = await client.writeSection('main.tex', title, section.content, { scope });
        assert.equal(result.committed, false, `${title} / ${scope}: ${result.message}`);
      }
    }
    assert.equal(remoteFile('main.tex'), MAIN_TEX);
  });

  test('read, edit, write with the default scope keeps the subsection', async () => {
    const { client, remoteFile } = makeProject(standardFiles());
    const section = await client.getSection('main.tex', 'Alpha');
    const edited = section.content.replace('Alpha section content.', 'Alpha, revised.');
    const result = await client.writeSection('main.tex', 'Alpha', edited);
    assert.equal(result.pushed, true);

    assert.equal(
      remoteFile('main.tex'),
      MAIN_TEX.replace('Alpha section content.', 'Alpha, revised.')
    );
  });

  test('read, edit, write with scope "full" keeps everything that was sent back', async () => {
    const { client, remoteFile } = makeProject(standardFiles());
    const section = await client.getSection('main.tex', 'Alpha', null, { scope: 'full' });
    const edited = section.content.replace('Alpha subsection content.', 'Sub, revised.');
    await client.writeSection('main.tex', 'Alpha', edited, { scope: 'full' });

    assert.equal(
      remoteFile('main.tex'),
      MAIN_TEX.replace('Alpha subsection content.', 'Sub, revised.')
    );
  });

  test('scope "full" removes subsections that newContent leaves out, and only those', async () => {
    const { client, remoteFile } = makeProject(standardFiles());
    await client.writeSection('main.tex', 'Alpha', '\\section{Alpha}\nOnly this.', { scope: 'full' });

    const content = remoteFile('main.tex');
    assert.ok(!content.includes('\\subsection{Alpha Sub}'));
    assert.ok(content.includes('\\section{Alpha}\nOnly this.\n\n\\section{Beta}\nBeta section content.'));
    assert.ok(content.includes('\\bibliography{refs}'));
  });

  test('default scope refuses text that repeats a subsection it keeps', async () => {
    const { client, remoteFile, remoteHead } = makeProject(standardFiles());
    const before = remoteHead();
    const full = await client.getSection('main.tex', 'Alpha', null, { scope: 'full' });

    await assert.rejects(
      client.writeSection('main.tex', 'Alpha', full.content),
      /would duplicate it/
    );
    assert.equal(remoteHead(), before);
    assert.equal(remoteFile('main.tex'), MAIN_TEX);
  });

  test('text without the heading is refused and nothing is written', async () => {
    const { client, remoteFile } = makeProject(standardFiles());
    await assert.rejects(
      client.writeSection('main.tex', 'Alpha', 'Body text only.'),
      /must begin with the section's heading line/
    );
    assert.equal(remoteFile('main.tex'), MAIN_TEX);
  });

  test('dryRun reports the size of the text the read returns, and writes nothing', async () => {
    const { client, remoteFile } = makeProject(standardFiles());
    for (const scope of ['own', 'full']) {
      const section = await client.getSection('main.tex', 'Alpha', null, { scope });
      const result = await client.writeSection('main.tex', 'Alpha', '\\section{Alpha}\nX.', {
        scope,
        dryRun: true,
      });
      assert.deepEqual(result, {
        dryRun: true,
        sectionFound: true,
        scope,
        replacedSize: section.content.length,
        newContentSize: '\\section{Alpha}\nX.'.length,
      });
    }
    assert.equal(remoteFile('main.tex'), MAIN_TEX);
  });

  test('an unknown scope is refused before anything is read', async () => {
    const { client } = makeProject(standardFiles());
    await assert.rejects(client.getSection('main.tex', 'Alpha', null, { scope: 'all' }), /Invalid scope/);
    await assert.rejects(
      client.writeSection('main.tex', 'Alpha', '\\section{Alpha}\nX.', { scope: 'all' }),
      /Invalid scope/
    );
  });

  test('an unknown section is reported as not found', async () => {
    const { client } = makeProject(standardFiles());
    assert.equal(await client.getSection('main.tex', 'Gamma'), null);
    await assert.rejects(
      client.writeSection('main.tex', 'Gamma', '\\section{Gamma}\nX.'),
      /Section "Gamma" not found/
    );
  });
});

// ---------------------------------------------------------------------------
// rewriting the last section leaves the bibliography alone
// ---------------------------------------------------------------------------
describe('the last section ends before the bibliography', { concurrency: true }, () => {
  test('reading the last section does not return the bibliography commands', async () => {
    const { client } = makeProject(standardFiles());
    for (const scope of ['own', 'full']) {
      const section = await client.getSection('main.tex', 'Beta', null, { scope });
      assert.equal(section.content, '\\section{Beta}\nBeta section content.', scope);
    }
  });

  test('rewriting the last section keeps the bibliography and \\end{document}', async () => {
    for (const scope of ['own', 'full']) {
      const { client, remoteFile } = makeProject(standardFiles());
      await client.writeSection('main.tex', 'Beta', '\\section{Beta}\nRewritten conclusion.', { scope });
      assert.equal(
        remoteFile('main.tex'),
        MAIN_TEX.replace('Beta section content.', 'Rewritten conclusion.'),
        scope
      );
    }
  });

  test('get_postamble returns the bibliography commands through to the end of the file', async () => {
    const { client } = makeProject(standardFiles());
    assert.equal(
      await client.getPostamble('main.tex'),
      '\\bibliographystyle{plain}\n\\bibliography{refs}\n\n\\end{document}\n'
    );
  });

  test('sections plus preamble plus postamble account for the whole file', async () => {
    const { client } = makeProject(standardFiles());
    const preamble = await client.getPreamble('main.tex');
    const postamble = await client.getPostamble('main.tex');
    const sections = [];
    for (const title of ['Alpha', 'Alpha Sub', 'Beta']) {
      sections.push((await client.getSection('main.tex', title)).content);
    }
    const rebuilt = preamble + sections.map(s => s + '\n\n').join('') + postamble;
    assert.equal(rebuilt, MAIN_TEX);
  });

  test('a file without closing material has an empty postamble and a last section to the end', async () => {
    const { client } = makeProject(standardFiles());
    assert.equal(await client.getPostamble('duplicates.tex'), '');
    assert.equal(await client.getPostamble('refs.bib'), '');
    const last = await client.getSection('duplicates.tex', 'Setup', 'Experiment B');
    assert.equal(last.content, '\\subsection{Setup}\nSetup of B.');
  });
});

// ---------------------------------------------------------------------------
// a title that occurs twice is never resolved by position
// ---------------------------------------------------------------------------
describe('duplicate section titles', { concurrency: true }, () => {
  test('reading an ambiguous title is refused with the candidates listed', async () => {
    const { client } = makeProject(standardFiles());
    await assert.rejects(
      client.getSection('duplicates.tex', 'Setup'),
      err => {
        assert.match(err.message, /matches 2 sections/);
        assert.match(err.message, /"Experiment A > Setup" \(line 4\)/);
        assert.match(err.message, /"Experiment B > Setup" \(line 10\)/);
        assert.match(err.message, /parentTitle/);
        return true;
      }
    );
  });

  test('writing to an ambiguous title is refused and nothing is written', async () => {
    const { client, remoteFile, remoteHead } = makeProject(standardFiles());
    const before = remoteHead();
    await assert.rejects(
      client.writeSection('duplicates.tex', 'Setup', '\\subsection{Setup}\nOverwritten.'),
      /matches 2 sections/
    );
    assert.equal(remoteHead(), before);
    assert.equal(remoteFile('duplicates.tex'), DUPLICATES_TEX);
  });

  test('a dry run on an ambiguous title is refused too', async () => {
    const { client } = makeProject(standardFiles());
    await assert.rejects(
      client.writeSection('duplicates.tex', 'Setup', '\\subsection{Setup}\nX.', { dryRun: true }),
      /matches 2 sections/
    );
  });

  test('parentTitle selects the section to read', async () => {
    const { client } = makeProject(standardFiles());
    const a = await client.getSection('duplicates.tex', 'Setup', 'Experiment A');
    const b = await client.getSection('duplicates.tex', 'Setup', 'Experiment B');
    assert.equal(a.content, '\\subsection{Setup}\nSetup of A.');
    assert.equal(b.content, '\\subsection{Setup}\nSetup of B.');
  });

  test('parentTitle selects the section to write, and only that one changes', async () => {
    const { client, remoteFile } = makeProject(standardFiles());
    await client.writeSection('duplicates.tex', 'Setup', '\\subsection{Setup}\nNew setup of B.', {
      parentTitle: 'Experiment B',
    });
    assert.equal(
      remoteFile('duplicates.tex'),
      DUPLICATES_TEX.replace('Setup of B.', 'New setup of B.')
    );
  });

  test('a parentTitle that does not contain the section is reported as not found', async () => {
    const { client } = makeProject(standardFiles());
    assert.equal(await client.getSection('duplicates.tex', 'Setup', 'Nowhere'), null);
    await assert.rejects(
      client.writeSection('duplicates.tex', 'Setup', '\\subsection{Setup}\nX.', { parentTitle: 'Nowhere' }),
      /Section "Setup" not found under parent "Nowhere"/
    );
  });
});

// ---------------------------------------------------------------------------
// a conflict with the remote is reported once and leaves a working clone
// ---------------------------------------------------------------------------
describe('conflicting local commits', { concurrency: true }, () => {
  /** A local unpushed commit and a collaborator's push that change the same line. */
  async function makeConflict() {
    const project = makeProject(standardFiles());
    await project.client.strReplace(
      'main.tex', 'Beta section content.', 'Beta, edited by the agent.', { push: false }
    );
    project.collaboratorEdits(
      'main.tex', text => text.replace('Beta section content.', 'Beta, edited by a collaborator.')
    );
    return project;
  }

  const setAsideRefs = clone =>
    git(clone, 'for-each-ref', '--format=%(refname)', 'refs/overleaf-mcp/set-aside')
      .split('\n').filter(Boolean);

  test('the conflict is reported with what happened and what to do', async () => {
    const { client } = await makeConflict();
    await assert.rejects(client.readFile('main.tex'), err => {
      assert.match(err.message, /^Sync conflict: 1 local commit\(s\)/);
      assert.match(err.message, /in: main\.tex/);
      assert.match(err.message, /Nothing on the remote was changed/);
      assert.match(err.message, /refs\/overleaf-mcp\/set-aside\//);
      assert.match(err.message, /Re-read the affected sections/);
      // The set-aside change itself, so the agent can see what it had written.
      assert.match(err.message, /\+Beta, edited by the agent\./);
      return true;
    });
  });

  test('the next call works and returns the remote text without conflict markers', async () => {
    const { client, clone } = await makeConflict();
    await assert.rejects(client.readFile('main.tex'), /Sync conflict/);

    const content = await client.readFile('main.tex');
    assert.ok(content.includes('Beta, edited by a collaborator.'));
    assert.ok(!content.includes('edited by the agent'));
    assert.ok(!/^(<<<<<<<|=======|>>>>>>>)/m.test(content), 'no conflict markers');

    assert.equal(git(clone, 'status', '--porcelain').trim(), '');
    assert.ok(!existsSync(path.join(clone, '.git', 'rebase-merge')));
    assert.ok(!existsSync(path.join(clone, '.git', 'rebase-apply')));
  });

  test('the local commit is kept under a set-aside ref, and the remote is untouched', async () => {
    const { client, clone, collaborator, remoteHead } = await makeConflict();
    const collaboratorHead = git(collaborator, 'rev-parse', 'HEAD').trim();
    await assert.rejects(client.readFile('main.tex'), /Sync conflict/);

    const refs = setAsideRefs(clone);
    assert.equal(refs.length, 1);
    assert.ok(git(clone, 'show', `${refs[0]}:main.tex`).includes('Beta, edited by the agent.'));

    assert.equal(remoteHead(), collaboratorHead);
    assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), collaboratorHead);
    // Nothing set aside is ever offered to the remote.
    assert.equal(git(clone, 'log', '--format=%h', '@{u}..HEAD').trim(), '');
  });

  test('writing works again afterwards and reaches the remote', async () => {
    const { client, remoteFile } = await makeConflict();
    await assert.rejects(client.readFile('main.tex'), /Sync conflict/);

    const result = await client.strReplace('main.tex', 'Alpha section content.', 'Alpha after conflict.');
    assert.equal(result.pushed, true);
    const content = remoteFile('main.tex');
    assert.ok(content.includes('Alpha after conflict.'));
    assert.ok(content.includes('Beta, edited by a collaborator.'));
  });

  test('a conflict hit by a write is reported the same way and nothing is written', async () => {
    const { client, remoteFile, remoteHead } = await makeConflict();
    const before = remoteHead();
    await assert.rejects(
      client.strReplace('main.tex', 'Alpha section content.', 'Alpha, second edit.'),
      /Sync conflict/
    );
    assert.equal(remoteHead(), before);
    assert.ok(!remoteFile('main.tex').includes('second edit'));
  });

  test('a clone left mid-rebase by an earlier failure repairs itself', async () => {
    const { client, clone } = await makeConflict();
    // Reproduce the state the previous implementation left behind.
    assert.throws(() => git(clone, 'pull', '--rebase'));
    assert.ok(existsSync(path.join(clone, '.git', 'rebase-merge')), 'rebase is in progress');

    await assert.rejects(client.readFile('main.tex'), /Sync conflict/);
    const content = await client.readFile('main.tex');
    assert.ok(content.includes('Beta, edited by a collaborator.'));
    assert.equal(setAsideRefs(clone).length, 1);
  });

  test('local commits that do not conflict are kept and pushed as before', async () => {
    const project = makeProject(standardFiles());
    await project.client.strReplace(
      'main.tex', 'Alpha section content.', 'Alpha, edited by the agent.', { push: false }
    );
    project.collaboratorEdits(
      'main.tex', text => text.replace('Beta section content.', 'Beta, edited by a collaborator.')
    );

    const content = await project.client.readFile('main.tex');
    assert.ok(content.includes('Alpha, edited by the agent.'));
    assert.ok(content.includes('Beta, edited by a collaborator.'));
    assert.equal(setAsideRefs(project.clone).length, 0);

    // The pending commit is flushed by the next pushing write.
    await project.client.strReplace('refs.bib', 'title = {A}', 'title = {B}');
    assert.ok(project.remoteFile('main.tex').includes('Alpha, edited by the agent.'));
  });

  test('a failed pull that is not a conflict sets nothing aside', async () => {
    const { client, clone, remote, dir } = makeProject(standardFiles());
    await client.strReplace('main.tex', 'Alpha section content.', 'Alpha, pending.', { push: false });
    const pending = git(clone, 'rev-parse', 'HEAD').trim();

    // Make the remote unreachable.
    const moved = path.join(dir, 'moved.git');
    execFileSync('git', ['clone', '--quiet', '--bare', remote, moved], { env: COLLABORATOR_ENV });
    rmSync(remote, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    await assert.rejects(client.readFile('main.tex'), err => {
      assert.doesNotMatch(err.message, /Sync conflict/);
      return true;
    });
    assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), pending, 'the pending commit is still on the branch');
    assert.equal(setAsideRefs(clone).length, 0);
  });

  test('a write interrupted before it was staged does not block later calls', async () => {
    const project = makeProject(standardFiles());
    await project.client.readFile('main.tex');
    // What a killed process leaves behind: a modified, unstaged tracked file.
    const local = path.join(project.clone, 'main.tex');
    writeFileSync(local, readFileSync(local, 'utf8') + 'half-written edit\n');
    project.collaboratorEdits('refs.bib', text => text.replace('title = {A}', 'title = {C}'));

    const content = await project.client.readFile('main.tex');
    assert.equal(content, MAIN_TEX, 'the half-written text is not in the working file');
    assert.ok((await project.client.readFile('refs.bib')).includes('title = {C}'), 'the pull went through');
    // Kept, not deleted, and never published.
    assert.ok(git(project.clone, 'stash', 'show', '-p').includes('+half-written edit'));
    assert.equal(project.remoteFile('main.tex'), MAIN_TEX);

    const result = await project.client.strReplace('main.tex', 'Alpha section content.', 'Alpha, revised.');
    assert.equal(result.pushed, true);
  });
});

// ---------------------------------------------------------------------------
// caller-supplied refs and paths cannot become git options
// ---------------------------------------------------------------------------
describe('refs and paths given to git', { concurrency: true }, () => {
  test('a ref that is an option is refused and no file is written', async () => {
    const { client, dir } = makeProject(standardFiles());
    for (const key of ['fromRef', 'toRef']) {
      const target = path.join(dir, `injected-${key}.txt`);
      await assert.rejects(client.getDiff({ [key]: `--output=${target}` }), /cannot start with "-"/);
      assert.ok(!existsSync(target), `${key}: no file may be created`);
    }
  });

  test('an unknown ref is refused with a plain message', async () => {
    const { client } = makeProject(standardFiles());
    await assert.rejects(
      client.getDiff({ fromRef: 'no-such-branch' }),
      /fromRef "no-such-branch" is not a known commit, branch or tag/
    );
    await assert.rejects(client.getDiff({ fromRef: 'HEAD:main.tex' }), /is not a known commit/);
  });

  test('ordinary refs still work', async () => {
    const { client } = makeProject(standardFiles());
    await client.strReplace('main.tex', 'Alpha section content.', 'Alpha, revised.');
    const head = (await client.listHistory({ limit: 1 }))[0].hash;

    for (const fromRef of ['HEAD~1', 'HEAD^', head.slice(0, 7) + '~1']) {
      const { diff } = await client.getDiff({ fromRef });
      assert.ok(diff.includes('+Alpha, revised.'), fromRef);
    }
    const both = await client.getDiff({ fromRef: 'HEAD~1', toRef: 'HEAD' });
    assert.ok(both.diff.includes('-Alpha section content.'));
  });

  test('toRef on its own diffs HEAD against it', async () => {
    const { client } = makeProject(standardFiles());
    await client.strReplace('main.tex', 'Alpha section content.', 'Alpha, revised.');
    const { diff } = await client.getDiff({ toRef: 'HEAD~1' });
    assert.ok(diff.includes('-Alpha, revised.'));
    assert.ok(diff.includes('+Alpha section content.'));
  });

  test('contextLines: 0 is honoured', async () => {
    const { client } = makeProject(standardFiles());
    await client.strReplace('main.tex', 'Alpha section content.', 'Alpha, revised.');
    const { diff } = await client.getDiff({ fromRef: 'HEAD~1', contextLines: 0 });
    const context = diff.split('\n').filter(line => line.startsWith(' '));
    assert.deepEqual(context, []);
  });

  test('paths outside the project are refused in get_diff and list_history', async () => {
    const { client } = makeProject(standardFiles());
    await assert.rejects(client.getDiff({ filePaths: ['../outside.tex'] }), /must stay within/);
    await assert.rejects(client.listHistory({ filePath: '../outside.tex' }), /must stay within/);
  });

  test('an option passed as a date filter is not acted on', async () => {
    const { client, dir } = makeProject(standardFiles());
    const target = path.join(dir, 'injected-since.txt');
    await client.listHistory({ since: `--output=${target}` }).catch(() => {});
    assert.ok(!existsSync(target));
  });

  test('list_history restricted to a file still works', async () => {
    const { client } = makeProject(standardFiles());
    await client.strReplace('refs.bib', 'title = {A}', 'title = {B}', { commitMessage: 'Retitle A' });
    const history = await client.listHistory({ filePath: 'refs.bib' });
    assert.deepEqual(history.map(h => h.subject), ['Retitle A', 'Initial content']);
  });
});

// ---------------------------------------------------------------------------
// the git token never appears in an error, and .git is out of reach
// ---------------------------------------------------------------------------
describe('the token stays out of errors and out of reach', { concurrency: true }, () => {
  test('a failed clone does not reveal the token', async () => {
    const client = new OverleafGitClient('unreachable', TOKEN, path.join(ROOT, 'clones-unreachable'));
    // A remote that cannot be cloned and whose address contains the token,
    // as the real remote URL does.
    client._repoUrl = path.join(ROOT, `missing-${TOKEN}.git`);

    await assert.rejects(client.readFile('main.tex'), err => {
      for (const field of ['message', 'stack', 'cmd', 'stdout', 'stderr']) {
        assert.ok(!String(err[field] ?? '').includes(TOKEN), `token found in error.${field}`);
      }
      assert.ok(!JSON.stringify(err.spawnargs ?? []).includes(TOKEN), 'token found in error.spawnargs');
      assert.ok(err.message.includes('***'), 'the redaction is visible');
      return true;
    });
  });

  test('the .git directory cannot be read', async () => {
    const { client } = makeProject(standardFiles());
    await client.readFile('main.tex'); // make sure the clone exists
    for (const filePath of ['.git/config', '.GIT/config', 'sub/../.git/config', '.git/HEAD']) {
      await assert.rejects(client.readFile(filePath), /\.git directory is not accessible/, filePath);
    }
  });

  test('the .git directory cannot be written, so no hook can be planted', async () => {
    const { client, clone } = makeProject(standardFiles());
    await client.readFile('main.tex');
    const hook = path.join(clone, '.git', 'hooks', 'pre-commit');
    const configBefore = readFileSync(path.join(clone, '.git', 'config'), 'utf8');

    await assert.rejects(
      client.writeFile('.git/hooks/pre-commit', '#!/bin/sh\necho planted\n'),
      /\.git directory is not accessible/
    );
    await assert.rejects(
      client.writeFile('.git/config', '[core]\n'),
      /\.git directory is not accessible/
    );
    await assert.rejects(
      client.strReplace('.git/config', '[core]', '[core]\n\tfsmonitor = planted'),
      /\.git directory is not accessible/
    );

    assert.ok(!existsSync(hook));
    assert.equal(readFileSync(path.join(clone, '.git', 'config'), 'utf8'), configBefore);
  });

  test('ordinary dotfiles next to .git stay usable', async () => {
    const { client, remoteFile } = makeProject(standardFiles());
    await client.writeFile('.gitignore', '*.aux\n');
    assert.equal(remoteFile('.gitignore'), '*.aux\n');
    assert.equal(await client.readFile('.gitignore'), '*.aux\n');
  });
});

// ---------------------------------------------------------------------------
// The server, end to end over stdio
//
// The server builds an https://git:<token>@git.overleaf.com/<id> address for
// every project. git's own url.<base>.insteadOf setting, passed through the
// environment, redirects that address to a local bare repository, so the real
// server process can be driven through real tool calls with no network.
// ---------------------------------------------------------------------------
describe('server over stdio', () => {
  const SERVER = fileURLToPath(new URL('../overleaf-mcp-server.js', import.meta.url));
  const BROKEN_TOKEN = 'olp_BrokenProjectToken987654';
  let mcp;
  let project;

  const call = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: result.content.map(c => c.text).join('\n') };
  };

  before(async () => {
    project = makeProject(standardFiles());
    const projectsFile = path.join(project.dir, 'projects.json');
    writeFileSync(projectsFile, JSON.stringify({
      projects: {
        paper: { name: 'Paper', projectId: 'paper-id', gitToken: TOKEN },
        broken: { name: 'Broken', projectId: 'broken-id', gitToken: BROKEN_TOKEN },
      },
    }));

    const remoteUrl = project.remote.split(path.sep).join('/');
    mcp = new Client({ name: 'local-repo-test', version: '0.0.0' });
    await mcp.connect(new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      stderr: 'ignore',
      env: {
        ...process.env,
        ...TEST_ENV,
        PROJECTS_FILE: projectsFile,
        OVERLEAF_TEMP_DIR: path.join(project.dir, 'server-clones'),
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: `url.${remoteUrl}.insteadOf`,
        GIT_CONFIG_VALUE_0: `https://git:${TOKEN}@git.overleaf.com/paper-id`,
        // The second project is redirected to a repository that does not exist.
        GIT_CONFIG_KEY_1: `url.${remoteUrl}-missing/.insteadOf`,
        GIT_CONFIG_VALUE_1: `https://git:${BROKEN_TOKEN}@git.overleaf.com/`,
      },
    }));
  });

  after(async () => {
    await mcp?.close();
  });

  test('the section tools advertise scope and parentTitle', async () => {
    const { tools } = await mcp.listTools();
    for (const name of ['get_section_content', 'write_section']) {
      const properties = tools.find(t => t.name === name).inputSchema.properties;
      assert.deepEqual(properties.scope.enum, ['own', 'full'], name);
      assert.ok(properties.parentTitle, name);
    }
  });

  test('get_section_content returns the heading and own text by default', async () => {
    const result = await call('get_section_content', {
      projectName: 'paper', filePath: 'main.tex', sectionTitle: 'Alpha',
    });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.text, '\\section{Alpha}\nAlpha section content.');
  });

  test('get_section_content passes scope through', async () => {
    const result = await call('get_section_content', {
      projectName: 'paper', filePath: 'main.tex', sectionTitle: 'Alpha', scope: 'full',
    });
    assert.ok(result.text.includes('\\subsection{Alpha Sub}'), result.text);
  });

  test('an ambiguous title comes back as an error that lists the candidates', async () => {
    const result = await call('get_section_content', {
      projectName: 'paper', filePath: 'duplicates.tex', sectionTitle: 'Setup',
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /matches 2 sections/);
  });

  test('write_section passes parentTitle and scope through, and keeps what it should', async () => {
    const dry = await call('write_section', {
      projectName: 'paper', filePath: 'main.tex', sectionTitle: 'Alpha',
      newContent: '\\section{Alpha}\nX.', scope: 'full', dryRun: true,
    });
    assert.match(dry.text, /Scope: full/);
    assert.match(dry.text, /Text that would be replaced: \d+ characters/);

    const written = await call('write_section', {
      projectName: 'paper', filePath: 'duplicates.tex', sectionTitle: 'Setup',
      parentTitle: 'Experiment B', newContent: '\\subsection{Setup}\nServer wrote this.',
    });
    assert.equal(written.isError, false, written.text);
    assert.equal(
      project.remoteFile('duplicates.tex'),
      DUPLICATES_TEX.replace('Setup of B.', 'Server wrote this.')
    );

    const own = await call('write_section', {
      projectName: 'paper', filePath: 'main.tex', sectionTitle: 'Alpha',
      newContent: '\\section{Alpha}\nServer wrote Alpha.',
    });
    assert.equal(own.isError, false, own.text);
    assert.equal(
      project.remoteFile('main.tex'),
      MAIN_TEX.replace('Alpha section content.', 'Server wrote Alpha.')
    );
  });

  test('get_diff refuses a ref that is an option', async () => {
    const target = path.join(project.dir, 'injected-by-server.txt');
    const result = await call('get_diff', { projectName: 'paper', fromRef: `--output=${target}` });
    assert.equal(result.isError, true);
    assert.match(result.text, /cannot start with "-"/);
    assert.ok(!existsSync(target));
  });

  test('read_file refuses the .git directory', async () => {
    const result = await call('read_file', { projectName: 'paper', filePath: '.git/config' });
    assert.equal(result.isError, true);
    assert.match(result.text, /\.git directory is not accessible/);
    assert.ok(!result.text.includes(TOKEN));
  });

  test('an error from git reaches the model without any configured token', async () => {
    const result = await call('read_file', { projectName: 'broken', filePath: 'main.tex' });
    assert.equal(result.isError, true);
    assert.ok(!result.text.includes(BROKEN_TOKEN), result.text);
    assert.ok(!result.text.includes(TOKEN), result.text);
    assert.ok(result.text.includes('***'), result.text);
  });
});
