import { execFile as execFileCallback } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCallback);

// Numeric level for each LaTeX sectioning command, lower = higher in hierarchy.
// Used for level-aware boundary detection in writeSection.
const SECTION_LEVELS = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
    paragraph: 5,
    subparagraph: 6,
};

export const PREVIEW_MAX_LENGTH = 100;

// Valid values for the `scope` option of getSection and writeSection.
//   own  — the heading and the text up to the next heading of any level
//   full — the heading and everything up to the next heading of equal or
//          higher level, i.e. including all nested subsections
export const SECTION_SCOPES = ['own', 'full'];

// Document-level constructs that follow the last section and are not part of
// it. The last section's range stops at the first of these. Anchored to the
// start of a line so that commented-out or inline mentions do not count.
const CLOSING_MARKER_SOURCE =
    '^[ \\t]*\\\\(?:' +
    'bibliographystyle\\s*\\{|bibliography\\s*\\{|printbibliography\\b|' +
    'begin\\{(?:thebibliography|acks|acknowledgments|acknowledgements|appendices)\\}|' +
    'appendix\\b)';

// Path segments that refer to git's own directory, including the spellings
// Windows resolves to it (trailing dots or spaces, NTFS streams, 8.3 names).
const GIT_DIR_SEGMENT = /^(\.git[. ]*(:.*)?|git~\d+)$/i;

// Upper bound on the diff of set-aside commits included in a conflict error.
const SET_ASIDE_DIFF_MAX_CHARS = 3000;

// The password part of a URL that carries credentials: scheme://user:PASSWORD@host
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@/gi;

/**
 * Replace every occurrence of the given secrets in `text` with "***".
 * Also covers the URL-encoded form and the Base64 "git:<secret>" form used in
 * HTTP Basic credentials. Secrets shorter than 8 characters are ignored: they
 * cannot be real tokens, and replacing them could mangle ordinary text.
 *
 * Independently of the list, the password in any URL of the form
 * scheme://user:password@host is replaced, so a credential this function was
 * not told about does not get through in a remote address either.
 */
export function redactSecrets(text, secrets = []) {
    if (typeof text !== 'string' || !text) return text;
    let out = text.replace(URL_PASSWORD, '$1***@');
    for (const secret of secrets) {
        if (typeof secret !== 'string' || secret.length < 8) continue;
        const forms = new Set([
            secret,
            encodeURIComponent(secret),
            Buffer.from(`git:${secret}`).toString('base64'),
        ]);
        for (const form of forms) out = out.split(form).join('***');
    }
    return out;
}

export class OverleafGitClient {
    constructor(projectId, gitToken, tempDir) {
        this.projectId = projectId;
        this.localPath = path.join(tempDir, projectId);
        this._gitToken = gitToken;

        // NOTE: the token is embedded in the remote URL and will be visible in `ps aux`
        // during the initial clone (passed as a CLI argument to git). A future improvement
        // is to use a GIT_ASKPASS helper script written to a temp file so the token never
        // appears in the process list at all. For now the risk is limited to local process
        // inspection on a single-user machine.
        this._repoUrl = `https://git:${gitToken}@git.overleaf.com/${projectId}`;
    }

    // ─── Internal helpers ───────────────────────────────────────────────────────

    /**
     * Resolve filePath relative to the local repo, rejecting path traversal and
     * anything inside git's own directory. `.git/config` holds the remote URL
     * with its credential, and `.git/hooks` is executed by git, so neither may
     * be reachable through a tool argument.
     */
    _safePath(filePath) {
        const base = path.resolve(this.localPath);
        const resolved = path.resolve(this.localPath, filePath);
        if (resolved !== base && !resolved.startsWith(base + path.sep)) {
            throw new Error(`Invalid path "${filePath}": must stay within the repository directory`);
        }
        const segments = path.relative(base, resolved).split(path.sep);
        if (segments.some(segment => GIT_DIR_SEGMENT.test(segment))) {
            throw new Error(`Invalid path "${filePath}": the .git directory is not accessible`);
        }
        return resolved;
    }

    /** Remove this project's git token from a string. */
    _redact(text) {
        return redactSecrets(text, [this._gitToken]);
    }

    /**
     * Run git with the given full argument list. Errors are rethrown with the
     * token removed from every field: Node puts the whole command line into
     * the error message, and the clone command line contains the remote URL.
     */
    async _runGit(fullArgs) {
        try {
            return await execFile('git', fullArgs, { env: this._gitEnv() });
        } catch (err) {
            for (const key of ['message', 'stack', 'cmd', 'stdout', 'stderr']) {
                if (typeof err[key] === 'string') err[key] = this._redact(err[key]);
            }
            if (Array.isArray(err.spawnargs)) {
                err.spawnargs = err.spawnargs.map(arg => this._redact(arg));
            }
            throw err;
        }
    }

    /** Build the environment for every git invocation. */
    _gitEnv() {
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        if (process.env.OVERLEAF_GIT_AUTHOR_NAME) {
            env.GIT_AUTHOR_NAME = process.env.OVERLEAF_GIT_AUTHOR_NAME;
            env.GIT_COMMITTER_NAME = process.env.OVERLEAF_GIT_AUTHOR_NAME;
        }
        if (process.env.OVERLEAF_GIT_AUTHOR_EMAIL) {
            env.GIT_AUTHOR_EMAIL = process.env.OVERLEAF_GIT_AUTHOR_EMAIL;
            env.GIT_COMMITTER_EMAIL = process.env.OVERLEAF_GIT_AUTHOR_EMAIL;
        }
        return env;
    }

    /**
     * Run a git command inside the local repo using execFile (no shell).
     * Arguments must be passed as an array — they are never shell-interpreted,
     * so no quoting or escaping is needed and shell injection is not possible.
     *
     * Example: this._git(['commit', '-m', 'my message with "quotes" and $(stuff)'])
     */
    async _git(args) {
        return this._runGit(['-C', this.localPath, ...args]);
    }

    /**
     * Validate a caller-supplied git ref before it gets near a git command.
     * execFile prevents shell injection but not option injection: a value such
     * as "--output=/some/path" would be parsed by git as an option.
     */
    _assertSafeRef(ref, label = 'ref') {
        if (typeof ref !== 'string' || ref.length === 0 || ref.length > 200) {
            throw new Error(`${label} must be a non-empty string naming a commit, branch or tag`);
        }
        if (ref.startsWith('-')) {
            throw new Error(`Invalid ${label} "${ref}": a git ref cannot start with "-"`);
        }
        if (/[\s\x00-\x1f\x7f]/.test(ref)) {
            throw new Error(`Invalid ${label}: a git ref cannot contain whitespace or control characters`);
        }
        return ref;
    }

    /**
     * Resolve a caller-supplied ref to a full commit hash. Only the returned
     * hash is passed on to other git commands, so nothing the caller typed
     * reaches them.
     */
    async _resolveRef(ref, label = 'ref') {
        this._assertSafeRef(ref, label);
        try {
            const { stdout } = await this._git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
            const hash = stdout.trim();
            if (!/^[0-9a-f]{7,64}$/.test(hash)) throw new Error('unexpected rev-parse output');
            return hash;
        } catch {
            throw new Error(`${label} "${ref}" is not a known commit, branch or tag in this project`);
        }
    }

    /**
     * Stage filePath, then commit and optionally push.
     * Returns { committed, pushed } flags plus a human-readable message.
     */
    async _commitAndPush(filePath, commitMessage, push) {
        await this._git(['add', filePath]);

        // Nothing staged means the write produced no actual change.
        const { stdout: staged } = await this._git(['diff', '--cached', '--name-only']);
        if (!staged.trim()) {
            // Even with nothing new to commit, push if requested — this flushes any
            // local commits from a previous push:false operation, which would otherwise
            // be permanently stranded with no way to reach the remote.
            if (push) {
                try {
                    await this._git(['push']);
                } catch (err) {
                    const output = (err.stdout ?? '') + (err.stderr ?? '');
                    if (output.includes('rejected') || output.includes('non-fast-forward')) {
                        throw new Error('Push rejected: remote has new changes. Pull and retry.');
                    }
                    throw err;
                }
                return { committed: false, pushed: true, message: 'No new changes to commit; pushed any pending local commits' };
            }
            return { committed: false, pushed: false, message: 'No changes to commit' };
        }

        try {
            await this._git(['commit', '-m', commitMessage]);
        } catch (err) {
            throw new Error(`Commit failed: ${err.message}`);
        }

        if (!push) {
            return { committed: true, pushed: false, message: 'Committed locally, not pushed' };
        }

        try {
            await this._git(['push']);
        } catch (err) {
            const output = (err.stdout ?? '') + (err.stderr ?? '');
            if (output.includes('rejected') || output.includes('non-fast-forward')) {
                throw new Error('Push rejected: remote has new changes. Pull and retry.');
            }
            throw err;
        }

        return { committed: true, pushed: true, message: 'Committed and pushed successfully' };
    }

    // ─── Dirty-state recovery ───────────────────────────────────────────────────

    /**
     * Called at the start of every cloneOrPull. Handles three cases:
     *
     * 1. Staged but uncommitted changes: crash after file write, before commit.
     *    These are committed with a recovery message and pushed.
     *
     * 2. Unstaged changes to tracked files: crash after partial write or manual
     *    interference. Logged as a warning; not auto-committed since we cannot
     *    know if the state is intentional.
     *
     * 3. Untracked files: `git status --porcelain` reports these (lines starting
     *    with "??") but neither staged nor unstaged checks will catch them.
     *    They are logged as a warning and left untouched — auto-staging unknown
     *    files would be more dangerous than ignoring them.
     *
     * Returns a human-readable recovery message, or null if the tree was clean.
     */
    async _recoverDirtyState() {
        // A rebase or merge left half-finished by an earlier failure must be
        // cleared before anything else. Its conflict markers sit in the working
        // files and its entries sit in the index, where Case 1 below would
        // mistake them for an interrupted write and try to commit them.
        const interrupted = await this._operationInProgress();
        if (interrupted) {
            console.warn(`[OverleafMCP] Aborting an unfinished ${interrupted} in project "${this.projectId}"`);
            await this._abortInProgress(interrupted);
        }

        let porcelain;
        try {
            ({ stdout: porcelain } = await this._git(['status', '--porcelain']));
        } catch {
            return null; // Repo may not exist yet; that is fine.
        }

        if (!porcelain.trim()) return null;

        // Never commit while git still reports unmerged paths: the files contain
        // conflict markers, not content anyone wrote.
        const { stdout: unmerged } = await this._git(['diff', '--name-only', '--diff-filter=U']);
        if (unmerged.trim()) {
            const msg = `Unresolved merge state in: ${unmerged.trim().split('\n').join(', ')}`;
            console.warn(`[OverleafMCP] ${msg}`);
            return msg;
        }

        // Case 1: staged but uncommitted.
        const { stdout: stagedFiles } = await this._git(['diff', '--cached', '--name-only']);
        if (stagedFiles.trim()) {
            console.warn(`[OverleafMCP] Recovering uncommitted staged changes in project "${this.projectId}"`);
            await this._git(['commit', '-m', 'Recovery: uncommitted changes from previous session']);
            try {
                await this._git(['push']);
            } catch {
                console.warn('[OverleafMCP] Recovery commit could not be pushed; will retry on next operation');
            }
            return `Recovered uncommitted staged changes: ${stagedFiles.trim()}`;
        }

        // Case 2: unstaged changes to tracked files.
        const { stdout: unstagedFiles } = await this._git(['diff', '--name-only']);
        if (unstagedFiles.trim()) {
            // Typically a write that was interrupted before it was staged. Git
            // refuses to pull onto a modified tree, so leaving the change in
            // place would make every later call fail. It is moved to the stash,
            // where it stays recoverable (`git stash list` in the local copy),
            // rather than committed: a half-written file must not be published.
            const names = unstagedFiles.trim().split('\n').join(', ');
            await this._git(['stash', 'push', '-m', 'OverleafMCP: uncommitted changes set aside during recovery']);
            const msg = `Uncommitted changes in tracked files were moved to the git stash: ${names}`;
            console.warn(`[OverleafMCP] ${msg}`);
            return msg;
        }

        // Case 3: only untracked files present.
        const untrackedLines = porcelain.split('\n').filter(l => l.startsWith('??'));
        if (untrackedLines.length) {
            const names = untrackedLines.map(l => l.slice(3).trim()).join(', ');
            const msg = `Untracked files present (ignored by recovery): ${names}`;
            console.warn(`[OverleafMCP] ${msg}`);
            return msg;
        }

        return null;
    }

    // ─── Conflict handling ──────────────────────────────────────────────────────

    /**
     * Returns "rebase" or "merge" if git has such an operation unfinished in
     * the local clone, otherwise null.
     */
    async _operationInProgress() {
        const exists = async (name) => {
            try {
                await fs.access(path.join(this.localPath, '.git', name));
                return true;
            } catch {
                return false;
            }
        };
        if (await exists('rebase-merge') || await exists('rebase-apply')) return 'rebase';
        if (await exists('MERGE_HEAD')) return 'merge';
        return null;
    }

    /** Abort an unfinished rebase or merge, returning the clone to its prior state. */
    async _abortInProgress(operation) {
        try {
            await this._git([operation, '--abort']);
        } catch (err) {
            throw new Error(
                `Could not abort an unfinished ${operation} in the local copy of project ` +
                `"${this.projectId}" (${this.localPath}). The local copy needs to be repaired ` +
                `or deleted by hand. git said: ${err.message}`
            );
        }
    }

    /**
     * Called when pulling the remote onto local unpushed commits conflicts.
     *
     * Leaving the rebase half-done would break every later call, and replaying
     * the same commits would hit the same conflict each time. The remote holds
     * someone else's newer edit, so it wins: the local commits are moved to a
     * ref outside the branch namespace (kept, never pushed, and reachable for
     * recovery) and the branch is reset to the remote state.
     *
     * Returns the text of the error to raise. Nothing on the remote is touched.
     */
    async _setAsideConflictingCommits() {
        const interrupted = await this._operationInProgress();
        if (interrupted) await this._abortInProgress(interrupted);

        const { stdout: log } = await this._git(['log', '--format=%h %s', '@{u}..HEAD']);
        const commits = log.split('\n').map(line => line.trim()).filter(Boolean);
        if (commits.length === 0) {
            return 'Sync with the remote failed and was rolled back. No local changes were lost. Retry the call.';
        }

        const { stdout: names } = await this._git(['diff', '--name-only', '@{u}...HEAD']);
        const files = names.split('\n').map(line => line.trim()).filter(Boolean);
        const { stdout: fullDiff } = await this._git(['diff', '--unified=1', '@{u}...HEAD']);
        const diff = fullDiff.length > SET_ASIDE_DIFF_MAX_CHARS
            ? fullDiff.slice(0, SET_ASIDE_DIFF_MAX_CHARS) + '\n(diff truncated)'
            : fullDiff;

        const stamp = new Date().toISOString().replace(/[-:.]/g, '');
        const ref = `refs/overleaf-mcp/set-aside/${stamp}`;
        await this._git(['update-ref', ref, 'HEAD']);
        await this._git(['reset', '--hard', '@{u}']);

        return [
            `Sync conflict: ${commits.length} local commit(s) that had not been pushed conflict ` +
            `with newer changes on the remote${files.length ? ` in: ${files.join(', ')}` : ''}.`,
            'Nothing on the remote was changed. The remote version was kept, and the local ' +
            `commit(s) were set aside under the git ref ${ref} (nothing is deleted). ` +
            'The local copy now matches the remote, so tool calls work again.',
            'The remote text is someone else\'s newer edit. Re-read the affected sections ' +
            'before editing again, and do not reapply the earlier change over it unchanged.',
            '',
            'Set-aside commit(s):',
            ...commits.map(commit => `  ${commit}`),
            '',
            'What they changed, for reference:',
            diff.trimEnd(),
        ].join('\n');
    }

    // ─── Core sync ──────────────────────────────────────────────────────────────

    /**
     * Ensures the local clone is up to date.
     * Uses --rebase to avoid polluting history with merge commits.
     */
    async cloneOrPull() {
        const gitDir = path.join(this.localPath, '.git');

        let repoExists = false;
        try {
            await fs.access(gitDir);
            repoExists = true;
        } catch { /* not cloned yet */ }

        if (repoExists) {
            await this._recoverDirtyState();
            try {
                await this._git(['pull', '--rebase']);
            } catch (err) {
                // A pull that stops with a rebase in progress hit a conflict between
                // local unpushed commits and the remote. Any other failure (network,
                // authentication) leaves no rebase behind and is passed on as is.
                if ((await this._operationInProgress()) !== null) {
                    throw new Error(await this._setAsideConflictingCommits());
                }
                throw err;
            }
        } else {
            await fs.mkdir(path.dirname(this.localPath), { recursive: true });
            // The token in _repoUrl is passed as a plain argument and never
            // interpreted by a shell; _runGit removes it from any error raised.
            await this._runGit(['clone', this._repoUrl, this.localPath]);
        }
    }

    // ─── Public read API ────────────────────────────────────────────────────────

    async listFiles(extension = '.tex') {
        await this.cloneOrPull();
        const results = [];

        const walk = async (dir) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && entry.name !== '.git') {
                    await walk(fullPath);
                } else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) {
                    results.push(path.relative(this.localPath, fullPath));
                }
            }
        };

        await walk(this.localPath);
        return results;
    }

    async readFile(filePath) {
        await this.cloneOrPull();
        const content = await fs.readFile(this._safePath(filePath), 'utf-8');
        // Normalise Windows-style CRLF to LF. Overleaf's git server uses CRLF on
        // some projects. Without this, str_replace and insert_before/after anchors
        // constructed with LF would fail to match even when visually identical.
        return content.replace(/\r\n/g, '\n');
    }

    /**
     * Pure helper: parses a LaTeX string into a flat array of section entries.
     * No I/O performed. Used by getSections and writeSection to avoid reading
     * the file twice and to eliminate any race between the two reads.
     *
     * Each entry contains:
     *   type        — e.g. "section", "subsection"
     *   title       — the argument text
     *   startIndex  — byte offset of the command in the source string
     *   content     — text from the command to the start of the next command (trimmed)
     *   preview     — first 100 characters of content, whitespace-collapsed
     */
    _parseSections(content) {
        const regex = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^}]+)\}/g;
        const flat = [];
        let match;

        while ((match = regex.exec(content)) !== null) {
            flat.push({
                type: match[1],
                title: match[2],
                startIndex: match.index,
                _cmdEndIndex: match.index + match[0].length,
            });
        }

        flat.forEach((entry, i) => {
            const contentStart = entry._cmdEndIndex;
            const contentEnd = i + 1 < flat.length ? flat[i + 1].startIndex : content.length;
            entry.content = content.substring(contentStart, contentEnd).trim();
            entry.preview = entry.content.substring(0, PREVIEW_MAX_LENGTH).replace(/\s+/g, ' ');
            delete entry._cmdEndIndex;
        });

        return flat;
    }

    /** Returns a flat array of all sections in a .tex file (includes content + preview). */
    async getSections(filePath) {
        const content = await this.readFile(filePath);
        return this._parseSections(content);
    }

    /**
     * Builds a hierarchical section tree from a flat array produced by _parseSections.
     * Each node gets a `children` array containing its direct descendants.
     * The `content` field on each node is the text immediately following the heading,
     * up to the next heading of any level — it does not include children's content.
     * This gives the LLM a clean view of direct content vs. nested structure.
     */
    _buildSectionTree(flat) {
        const root = [];
        // Stack entries: { node, level }
        // The top of the stack is always the current open ancestor.
        const stack = [];

        for (const entry of flat) {
            const level = SECTION_LEVELS[entry.type] ?? 99;
            const { content: _content, ...rest } = entry;
            const node = { ...rest, children: [] };

            // Pop ancestors that are at the same or deeper level.
            while (stack.length && stack[stack.length - 1].level >= level) {
                stack.pop();
            }

            if (stack.length === 0) {
                root.push(node);
            } else {
                stack[stack.length - 1].node.children.push(node);
            }

            stack.push({ node, level });
        }

        return root;
    }

    /** Returns a hierarchical section tree for the given .tex file. */
    async getSectionTree(filePath) {
        const flat = await this.getSections(filePath);
        return this._buildSectionTree(flat);
    }

    // ─── Section addressing (pure helpers) ──────────────────────────────────────
    //
    // Every tool that reads or replaces a section goes through _resolveSection
    // and _sectionRange. Reading a section and writing it back therefore always
    // cover exactly the same characters. Before these helpers existed, the read
    // returned the text up to the next heading of any level while the write
    // replaced everything up to the next heading of equal or higher level, so a
    // read-edit-write round trip silently deleted every subsection.

    /** Throws unless scope is one of SECTION_SCOPES. */
    _assertScope(scope) {
        if (!SECTION_SCOPES.includes(scope)) {
            throw new Error(`Invalid scope "${scope}": use "own" or "full"`);
        }
    }

    /** 1-based line number of a character offset. */
    _lineOf(content, index) {
        let line = 1;
        for (let i = 0; i < index && i < content.length; i++) {
            if (content.charCodeAt(i) === 10) line++;
        }
        return line;
    }

    /**
     * Offset where document-level closing material begins at or after fromIndex:
     * the first bibliography, acknowledgement or appendix construct on its own
     * line, or \end{document}, whichever comes first. Returns content.length if
     * there is none (for example in a file that is \input into another).
     */
    _closingIndex(content, fromIndex = 0) {
        const endDocIdx = content.lastIndexOf('\\end{document}');
        let boundary = endDocIdx !== -1 && endDocIdx >= fromIndex ? endDocIdx : content.length;

        const marker = new RegExp(CLOSING_MARKER_SOURCE, 'gm');
        marker.lastIndex = fromIndex;
        const match = marker.exec(content);
        if (match && match.index < boundary) boundary = match.index;

        return boundary;
    }

    /**
     * Character range of a section within content, as { start, end }.
     *
     *   scope "own"  — from the heading to the next heading of any level
     *   scope "full" — from the heading to the next heading of equal or higher
     *                  level, i.e. including all nested subsections
     *
     * In both scopes the range also stops at document-level closing material
     * (see _closingIndex), so the last section never includes the bibliography
     * commands, an acknowledgements block, \appendix, or \end{document}.
     */
    _sectionRange(sections, target, content, scope = 'own') {
        this._assertScope(scope);

        const later = sections.filter(s => s.startIndex > target.startIndex);
        let next;
        if (scope === 'full') {
            const level = SECTION_LEVELS[target.type] ?? 99;
            next = later.find(s => (SECTION_LEVELS[s.type] ?? 99) <= level);
        } else {
            next = later[0];
        }

        const headingBoundary = next ? next.startIndex : content.length;
        const closingBoundary = this._closingIndex(content, target.startIndex);

        return { start: target.startIndex, end: Math.min(headingBoundary, closingBoundary) };
    }

    /**
     * Finds the one section a title refers to.
     *
     * Returns the section entry, or null if nothing matches. When parentTitle
     * is supplied, only sections nested inside a section with that title are
     * considered.
     *
     * Throws if more than one section matches. Picking the first match would
     * let a write land on a different section from the one the caller meant,
     * so an ambiguous title is refused with the candidates listed, in the same
     * way _findUniqueAnchor refuses an ambiguous anchor.
     */
    _resolveSection(sections, content, sectionTitle, parentTitle = null) {
        let candidates = sections.filter(s => s.title === sectionTitle);

        if (parentTitle) {
            const parentRanges = sections
                .filter(s => s.title === parentTitle)
                .map(parent => {
                    const level = SECTION_LEVELS[parent.type] ?? 99;
                    const next = sections.find(
                        s => s.startIndex > parent.startIndex && (SECTION_LEVELS[s.type] ?? 99) <= level
                    );
                    return { start: parent.startIndex, end: next ? next.startIndex : Infinity };
                });
            candidates = candidates.filter(c =>
                parentRanges.some(range => c.startIndex > range.start && c.startIndex < range.end)
            );
        }

        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        // Describe each candidate by its chain of ancestors and its line.
        const stack = [];
        const pathOf = new Map();
        for (const entry of sections) {
            const level = SECTION_LEVELS[entry.type] ?? 99;
            while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
            pathOf.set(entry, [...stack.map(item => item.entry.title), entry.title].join(' > '));
            stack.push({ entry, level });
        }
        const listing = candidates
            .map(c => `"${pathOf.get(c)}" (line ${this._lineOf(content, c.startIndex)})`)
            .join(', ');

        throw new Error(
            parentTitle
                ? `Section "${sectionTitle}" under parent "${parentTitle}" matches ${candidates.length} sections: ` +
                  `${listing}. A title must be unique under its parent to be addressed this way; ` +
                  `use str_replace with a unique anchor instead.`
                : `Section "${sectionTitle}" matches ${candidates.length} sections: ${listing}. ` +
                  `Supply parentTitle to select one.`
        );
    }

    /**
     * Checks replacement text for a section before it is written. Throws if
     * writing it would lose or duplicate structure:
     *
     *   - newContent must begin with a sectioning command (blank lines and
     *     comment lines may precede it). The heading is part of the range that
     *     is replaced, so text without one would delete the heading.
     *   - with scope "own", newContent must not repeat a nested subsection that
     *     stays in place below the range, since that would duplicate it.
     */
    _checkSectionReplacement(sections, target, content, newContent, scope = 'own') {
        this._assertScope(scope);
        if (typeof newContent !== 'string') {
            throw new Error('newContent must be a string');
        }

        const newHeadings = this._parseSections(newContent);
        const lead = newHeadings.length ? newContent.slice(0, newHeadings[0].startIndex) : newContent;
        const leadIsBlankOrComments = lead.split('\n').every(line => /^\s*(%.*)?$/.test(line));
        if (newHeadings.length === 0 || !leadIsBlankOrComments) {
            throw new Error(
                `newContent must begin with the section's heading line (for example ` +
                `"\\${target.type}{${target.title}}"): the heading is part of the text that is replaced. ` +
                `To change text without touching the heading, use str_replace.`
            );
        }

        if (scope !== 'own') return;

        const own = this._sectionRange(sections, target, content, 'own');
        const full = this._sectionRange(sections, target, content, 'full');
        const kept = sections.filter(s => s.startIndex >= own.end && s.startIndex < full.end);
        const repeated = newHeadings
            .slice(1)
            .find(h => kept.some(k => k.type === h.type && k.title === h.title));
        if (repeated) {
            throw new Error(
                `newContent contains the heading "\\${repeated.type}{${repeated.title}}", which already ` +
                `exists below "${target.title}" and is kept when scope is "own". Writing it would ` +
                `duplicate it. Leave nested subsections out of newContent, or pass scope "full" to ` +
                `replace the section together with its subsections.`
            );
        }
    }

    /**
     * Returns the section for a given title, or null if not found.
     *
     * The returned object's `content` is the section text for the requested
     * scope, heading line included. It is exactly the text that writeSection
     * replaces when called with the same title, parentTitle and scope.
     *
     * Options:
     *   scope — "own" (default) or "full"; see _sectionRange
     *
     * Throws if the title is ambiguous; see _resolveSection.
     */
    async getSection(filePath, sectionTitle, parentTitle = null, { scope = 'own' } = {}) {
        this._assertScope(scope);
        const content = await this.readFile(filePath);
        const sections = this._parseSections(content);

        const target = this._resolveSection(sections, content, sectionTitle, parentTitle);
        if (!target) return null;

        const { start, end } = this._sectionRange(sections, target, content, scope);
        return {
            type: target.type,
            title: target.title,
            startIndex: target.startIndex,
            scope,
            content: content.slice(start, end).trimEnd(),
            preview: target.preview,
        };
    }

    /**
     * Returns everything before the first sectioning command in a .tex file.
     * This is the document class declaration, package imports, and custom
     * command definitions. Returns the full file content if no sections exist.
     */
    async getPreamble(filePath) {
        const content = await this.readFile(filePath);
        const sections = this._parseSections(content);
        if (sections.length === 0) return content;
        return content.slice(0, sections[0].startIndex);
    }

    /**
     * Returns the document-level closing material: everything from the first
     * bibliography, acknowledgement or appendix construct that follows the last
     * section heading (or from \end{document} if there is none) to the end of
     * the file. Returns an empty string if the file has neither.
     *
     * This is the text that section ranges deliberately exclude, so that
     * rewriting the last section cannot remove the bibliography.
     */
    async getPostamble(filePath) {
        const content = await this.readFile(filePath);
        const sections = this._parseSections(content);
        const from = sections.length ? sections[sections.length - 1].startIndex : 0;
        const start = this._closingIndex(content, from);
        return start >= content.length ? '' : content.slice(start);
    }

    /**
     * Returns recent git commits for the project, optionally filtered by file path
     * and/or time range.
     *
     * Options:
     *   limit     — maximum commits to return (default 20, max 200)
     *   filePath  — restrict history to a single file path
     *   since     — git --since filter, e.g. "2.weeks" or "2025-01-01"
     *   until     — git --until filter
     */
    async listHistory({ limit = 20, filePath, since, until } = {}) {
        await this.cloneOrPull();

        const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 20));

        // Use null-byte (\x00) between fields and SOH (\x01) between commits.
        // This is safe regardless of commit message content.
        const args = [
            'log',
            `--max-count=${safeLimit}`,
            '--format=%x01%H%x00%as%x00%an%x00%s',
        ];
        // since/until are joined to their option name, so git cannot read them as
        // separate options. filePath comes after "--" and is also path-checked.
        if (since) args.push(`--since=${since}`);
        if (until) args.push(`--until=${until}`);
        if (filePath) {
            this._safePath(filePath);
            args.push('--', filePath);
        }

        const { stdout } = await this._git(args);

        return stdout
            .split('\x01')
            .filter(Boolean)
            .map(block => {
                const [hash, date, author, subject] = block.split('\x00');
                return {
                    hash: hash?.trim() ?? '',
                    date: date?.trim() ?? '',
                    author: author?.trim() ?? '',
                    subject: subject?.trim() ?? '',
                };
            });
    }

    /**
     * Returns a unified diff.
     *
     * Options:
     *   fromRef       — base ref; omit for "working tree vs HEAD"
     *   toRef         — target ref; omit for working tree
     *   filePaths     — array of paths to restrict the diff to
     *   contextLines  — lines of context around each hunk (default 3, max 10)
     *   maxOutputChars — truncate output to this many characters (default 120 000)
     *
     * Returns { diff: string, truncated: boolean }.
     */
    async getDiff({ fromRef, toRef, filePaths = [], contextLines = 3, maxOutputChars = 120000 } = {}) {
        await this.cloneOrPull();

        // Number.parseInt(...) || 3 would turn an explicit 0 into 3.
        const parsedContext = Number.parseInt(contextLines, 10);
        const safeContext = Math.min(10, Math.max(0, Number.isNaN(parsedContext) ? 3 : parsedContext));
        const args = ['diff', `--unified=${safeContext}`];

        // Refs are resolved to commit hashes first and only the hashes are passed
        // to `git diff`. A caller-supplied value such as "--output=/some/path"
        // would otherwise be parsed by git as an option and write a file.
        const from = fromRef ? await this._resolveRef(fromRef, 'fromRef') : null;
        const to = toRef ? await this._resolveRef(toRef, 'toRef') : null;

        if (from && to) {
            args.push(from, to);
        } else if (from) {
            args.push(from);
        } else if (to) {
            args.push('HEAD', to);
        } else {
            // Default: all changes since last commit (staged + unstaged vs HEAD).
            args.push('HEAD');
        }

        if (filePaths.length) {
            for (const filePath of filePaths) this._safePath(filePath);
            args.push('--', ...filePaths);
        }

        const { stdout } = await this._git(args);
        const safMax = Math.max(2000, maxOutputChars);
        const truncated = stdout.length > safMax;

        return {
            diff: truncated ? stdout.slice(0, safMax) : stdout,
            truncated,
        };
    }

    // ─── Public write API ────────────────────────────────────────────────────────

    /**
     * Reads a file from an absolute path and normalises CRLF to LF.
     * Used by all write methods after cloneOrPull() has already been called,
     * so they share the same line-ending contract as the public readFile() API
     * without triggering a second cloneOrPull().
     */
    async _readRaw(fullPath) {
        const content = await fs.readFile(fullPath, 'utf-8');
        return content.replace(/\r\n/g, '\n');
    }

    /**
     * Internal helper shared by strReplace, insertBefore, and insertAfter.
     * Finds the single occurrence of anchorStr in content and returns its index.
     *
     * Throws a descriptive error if the anchor appears zero or more than once,
     * with the occurrence count included so the LLM can self-correct.
     */
    _findUniqueAnchor(content, anchorStr, label = 'oldStr') {
        if (!anchorStr) throw new Error(`${label} must not be empty`);

        let index = -1;
        let count = 0;
        let searchFrom = 0;

        while (true) {
            const found = content.indexOf(anchorStr, searchFrom);
            if (found === -1) break;
            count++;
            index = found;
            searchFrom = found + 1;
            if (count > 1) break; // No need to count further.
        }

        if (count === 0) {
            throw new Error(`${label} not found in file. Check for whitespace or line-ending differences.`);
        }
        if (count > 1) {
            // Count all occurrences properly for the error message.
            let total = 0;
            let pos = 0;
            while ((pos = content.indexOf(anchorStr, pos)) !== -1) { total++; pos++; }
            throw new Error(
                `${label} matches ${total} locations — it must be unique. ` +
                `Add more surrounding context to make it unambiguous.`
            );
        }

        return index;
    }

    /**
     * Overwrites an entire file.
     *
     * Options:
     *   commitMessage  — defaults to "Update via Overleaf MCP"
     *   push           — defaults to true; set false to commit locally only
     *   dryRun         — if true, returns size info without touching any file
     */
    async writeFile(filePath, content, {
        commitMessage = 'Update via Overleaf MCP',
        push = true,
        dryRun = false,
    } = {}) {
        if (dryRun) {
            let existingSize = 0;
            try {
                const existing = await this.readFile(filePath);
                existingSize = existing.length;
            } catch { /* file may not exist yet */ }
            return { dryRun: true, existingSize, newSize: content.length };
        }

        await this.cloneOrPull();
        await fs.writeFile(this._safePath(filePath), content, 'utf-8');
        return this._commitAndPush(filePath, commitMessage, push);
    }

    /**
     * Replaces a single named section with newContent (which includes the
     * section heading).
     *
     * The range replaced is exactly the text getSection returns for the same
     * title, parentTitle and scope, so a section that was read can be written
     * back without touching anything the read did not show.
     *
     * Options: same as writeFile, plus:
     *   parentTitle — selects among sections that share a title
     *   scope       — "own" (default): the heading and the text up to the next
     *                 heading of any level; nested subsections are left in place.
     *                 "full": the heading and everything up to the next heading
     *                 of equal or higher level, replacing nested subsections too.
     *
     * Throws if the title is ambiguous; see _resolveSection.
     */
    async writeSection(filePath, sectionTitle, newContent, {
        commitMessage = 'Update section via Overleaf MCP',
        push = true,
        dryRun = false,
        parentTitle = null,
        scope = 'own',
    } = {}) {
        this._assertScope(scope);

        await this.cloneOrPull();
        const fullPath = this._safePath(filePath);

        // Read the file once and parse from the same string — no second cloneOrPull,
        // no risk of section offsets being computed from a newer version of the file.
        const fileContent = await this._readRaw(fullPath);
        const sections = this._parseSections(fileContent);

        const target = this._resolveSection(sections, fileContent, sectionTitle, parentTitle);
        if (!target) {
            throw new Error(
                `Section "${sectionTitle}" not found` + (parentTitle ? ` under parent "${parentTitle}"` : '')
            );
        }

        this._checkSectionReplacement(sections, target, fileContent, newContent, scope);

        const { start, end } = this._sectionRange(sections, target, fileContent, scope);
        const replaced = fileContent.slice(start, end);

        if (dryRun) {
            return {
                dryRun: true,
                sectionFound: true,
                scope,
                replacedSize: replaced.trimEnd().length,
                newContentSize: newContent.length,
            };
        }

        // Keep the whitespace that separated the old section from what follows,
        // so that writing back unchanged text leaves the file byte-identical.
        const separator = replaced.match(/\s*$/)[0] || (end < fileContent.length ? '\n\n' : '\n');

        const updated =
            fileContent.slice(0, start) +
            newContent.trimEnd() + separator +
            fileContent.slice(end);

        await fs.writeFile(fullPath, updated, 'utf-8');
        return this._commitAndPush(filePath, commitMessage, push);
    }

    /**
     * Replaces the single unique occurrence of oldStr with newStr in a file.
     *
     * oldStr must appear exactly once — if it appears zero or more than once,
     * an error is returned with the occurrence count so the caller can add
     * more surrounding context to make the anchor unambiguous.
     *
     * Options: same as writeFile.
     */
    async strReplace(filePath, oldStr, newStr, {
        commitMessage = 'Edit via Overleaf MCP',
        push = true,
        dryRun = false,
    } = {}) {
        await this.cloneOrPull();
        const fullPath = this._safePath(filePath);
        const fileContent = await this._readRaw(fullPath);

        const idx = this._findUniqueAnchor(fileContent, oldStr, 'oldStr');
        const updated = fileContent.slice(0, idx) + newStr + fileContent.slice(idx + oldStr.length);

        if (dryRun) {
            return {
                dryRun: true,
                anchorIndex: idx,
                oldSize: fileContent.length,
                newSize: updated.length,
            };
        }

        await fs.writeFile(fullPath, updated, 'utf-8');
        return this._commitAndPush(filePath, commitMessage, push);
    }

    /**
     * Inserts newContent immediately before the single unique occurrence of
     * anchorStr in a file.
     *
     * anchorStr must appear exactly once — same uniqueness rules as strReplace.
     *
     * Options: same as writeFile.
     */
    async insertBefore(filePath, anchorStr, newContent, {
        commitMessage = 'Edit via Overleaf MCP',
        push = true,
        dryRun = false,
    } = {}) {
        await this.cloneOrPull();
        const fullPath = this._safePath(filePath);
        const fileContent = await this._readRaw(fullPath);

        const idx = this._findUniqueAnchor(fileContent, anchorStr, 'anchorStr');
        const updated = fileContent.slice(0, idx) + newContent + fileContent.slice(idx);

        if (dryRun) {
            return { dryRun: true, anchorIndex: idx };
        }

        await fs.writeFile(fullPath, updated, 'utf-8');
        return this._commitAndPush(filePath, commitMessage, push);
    }

    /**
     * Inserts newContent immediately after the single unique occurrence of
     * anchorStr in a file.
     *
     * anchorStr must appear exactly once — same uniqueness rules as strReplace.
     *
     * Options: same as writeFile.
     */
    async insertAfter(filePath, anchorStr, newContent, {
        commitMessage = 'Edit via Overleaf MCP',
        push = true,
        dryRun = false,
    } = {}) {
        await this.cloneOrPull();
        const fullPath = this._safePath(filePath);
        const fileContent = await this._readRaw(fullPath);

        const idx = this._findUniqueAnchor(fileContent, anchorStr, 'anchorStr');
        const updated = fileContent.slice(0, idx + anchorStr.length) + newContent + fileContent.slice(idx + anchorStr.length);

        if (dryRun) {
            return { dryRun: true, anchorIndex: idx };
        }

        await fs.writeFile(fullPath, updated, 'utf-8');
        return this._commitAndPush(filePath, commitMessage, push);
    }

    // ─── BibTeX API ──────────────────────────────────────────────────────────────

    /**
     * Parses a .bib file string into an array of entry objects.
     * Each object contains:
     *   citeKey   — the citation key, e.g. "smith2024"
     *   entryType — the type without @, e.g. "article"
     *   raw       — the full raw BibTeX block including the @type{...} wrapper
     *   start     — byte offset of the @ in the source string
     *   end       — byte offset of the character after the closing }
     *
     * Handles arbitrarily nested braces inside field values.
     * Ignores @comment, @string, and @preamble meta-entries.
     */
    _parseBibEntries(content) {
        const entries = [];
        // Match the start of each entry: @type{ or @type(
        const entryStart = /@([A-Za-z]+)\s*[{(]/g;
        let match;

        while ((match = entryStart.exec(content)) !== null) {
            const type = match[1].toLowerCase();

            // Skip BibTeX meta-entries that are not citable.
            if (type === 'comment' || type === 'string' || type === 'preamble') continue;

            const openBraceIdx = match.index + match[0].length - 1;
            const openChar = content[openBraceIdx];
            const closeChar = openChar === '{' ? '}' : ')';

            // Walk forward tracking brace depth to find the matching close.
            let depth = 1;
            let i = openBraceIdx + 1;
            while (i < content.length && depth > 0) {
                if (content[i] === openChar) depth++;
                if (content[i] === closeChar) depth--;
                i++;
            }

            if (depth !== 0) continue; // Malformed entry, skip.

            const raw = content.slice(match.index, i);
            const end = i;

            // Extract cite key: first token after the opening brace/paren, up to a comma.
            const keyMatch = raw.match(/@[A-Za-z]+\s*[{(]\s*([^,\s]+)\s*,/);
            if (!keyMatch) continue;

            entries.push({
                citeKey: keyMatch[1],
                entryType: type,
                raw,
                start: match.index,
                end,
            });
        }

        return entries;
    }

    /**
     * Returns the raw BibTeX block for a given cite key, or null if not found.
     */
    async getBibEntry(filePath, citeKey) {
        const content = await this.readFile(filePath);
        const entries = this._parseBibEntries(content);
        return entries.find(e => e.citeKey === citeKey)?.raw ?? null;
    }

    /**
     * Appends a new BibTeX entry to a .bib file.
     *
     * entry must be a raw BibTeX string, e.g.:
     *   @article{smith2024, author = {Smith, John}, ... }
     *
     * Any valid BibTeX entry type is accepted (@article, @book,
     * @inproceedings, @misc, etc.). The cite key is extracted server-side
     * from the entry string. If the cite key already exists in the file,
     * an error is returned.
     *
     * Options: same as writeFile.
     */
    async addBibEntry(filePath, entry, {
        commitMessage = 'Add bib entry via Overleaf MCP',
        push = true,
        dryRun = false,
    } = {}) {
        await this.cloneOrPull();
        const fullPath = this._safePath(filePath);
        const fileContent = await this._readRaw(fullPath);
        const entries = this._parseBibEntries(fileContent);

        // Extract the cite key from the new entry.
        const keyMatch = entry.match(/@[A-Za-z]+\s*[{(]\s*([^,\s]+)\s*,/);
        if (!keyMatch) throw new Error('Could not extract cite key from entry. Ensure the entry is valid BibTeX.');
        const citeKey = keyMatch[1];

        if (entries.some(e => e.citeKey === citeKey)) {
            throw new Error(`Cite key "${citeKey}" already exists in "${filePath}". Use replace_bib_entry to update it.`);
        }

        if (dryRun) {
            return { dryRun: true, citeKey, action: 'add' };
        }

        // Always produce exactly one blank line between existing content and the
        // new entry. Handle the edge case of an empty or whitespace-only file.
        const updated = fileContent.trim()
            ? fileContent.trimEnd() + '\n\n' + entry.trim() + '\n'
            : entry.trim() + '\n';

        await fs.writeFile(fullPath, updated, 'utf-8');
        return this._commitAndPush(filePath, commitMessage, push);
    }

    /**
     * Replaces the entry with the given cite key with a new raw BibTeX block.
     *
     * The cite key is taken from the existing file entry being replaced —
     * the new entry may use a different cite key if desired.
     *
     * Options: same as writeFile.
     */
    async replaceBibEntry(filePath, citeKey, newEntry, {
        commitMessage = 'Update bib entry via Overleaf MCP',
        push = true,
        dryRun = false,
    } = {}) {
        await this.cloneOrPull();
        const fullPath = this._safePath(filePath);
        const fileContent = await this._readRaw(fullPath);
        const entries = this._parseBibEntries(fileContent);

        const target = entries.find(e => e.citeKey === citeKey);
        if (!target) throw new Error(`Cite key "${citeKey}" not found in "${filePath}".`);

        if (dryRun) {
            return { dryRun: true, citeKey, action: 'replace' };
        }

        const updated =
            fileContent.slice(0, target.start) +
            newEntry.trim() +
            fileContent.slice(target.end);

        await fs.writeFile(fullPath, updated, 'utf-8');
        return this._commitAndPush(filePath, commitMessage, push);
    }

    /**
     * Removes the entry with the given cite key from a .bib file.
     *
     * Trailing whitespace before the entry and leading whitespace after it are
     * both normalised so the surrounding entries remain separated by exactly one
     * blank line, preventing accumulation over repeated add/remove cycles.
     *
     * Options: same as writeFile.
     */
    async removeBibEntry(filePath, citeKey, {
        commitMessage = 'Remove bib entry via Overleaf MCP',
        push = true,
        dryRun = false,
    } = {}) {
        await this.cloneOrPull();
        const fullPath = this._safePath(filePath);
        const fileContent = await this._readRaw(fullPath);
        const entries = this._parseBibEntries(fileContent);

        const target = entries.find(e => e.citeKey === citeKey);
        if (!target) throw new Error(`Cite key "${citeKey}" not found in "${filePath}".`);

        if (dryRun) {
            return { dryRun: true, citeKey, action: 'remove' };
        }

        // Trim trailing newlines from before and leading newlines from after,
        // then rejoin. When after is empty (last entry removed), use a single
        // trailing newline rather than \n\n to avoid a blank line at end of file.
        const before = fileContent.slice(0, target.start).replace(/\n*$/, '');
        const after = fileContent.slice(target.end).replace(/^\n*/, '');
        const updated = before && after
            ? before + '\n\n' + after   // entries on both sides: one blank line between
            : (before || after) + '\n'; // only one side remains: clean trailing newline

        await fs.writeFile(fullPath, updated, 'utf-8');
        return this._commitAndPush(filePath, commitMessage, push);
    }
}