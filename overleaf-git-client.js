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

export class OverleafGitClient {
    constructor(projectId, gitToken, tempDir) {
        this.projectId = projectId;
        this.localPath = path.join(tempDir, projectId);

        // NOTE: the token is embedded in the remote URL and will be visible in `ps aux`
        // during the initial clone (passed as a CLI argument to git). A future improvement
        // is to use a GIT_ASKPASS helper script written to a temp file so the token never
        // appears in the process list at all. For now the risk is limited to local process
        // inspection on a single-user machine.
        this._repoUrl = `https://git:${gitToken}@git.overleaf.com/${projectId}`;
    }

    // ─── Internal helpers ───────────────────────────────────────────────────────

    /** Resolve filePath relative to the local repo, rejecting path traversal. */
    _safePath(filePath) {
        const base = path.resolve(this.localPath);
        const resolved = path.resolve(this.localPath, filePath);
        if (resolved !== base && !resolved.startsWith(base + path.sep)) {
            throw new Error(`Invalid path "${filePath}": must stay within the repository directory`);
        }
        return resolved;
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
        return execFile('git', ['-C', this.localPath, ...args], { env: this._gitEnv() });
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
        let porcelain;
        try {
            ({ stdout: porcelain } = await this._git(['status', '--porcelain']));
        } catch {
            return null; // Repo may not exist yet; that is fine.
        }

        if (!porcelain.trim()) return null;

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
            const msg = `Dirty working tree detected (unstaged changes in tracked files): ${unstagedFiles.trim()}`;
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
                const output = (err.stdout ?? '') + (err.stderr ?? '');
                if (output.includes('CONFLICT') || output.includes('conflict')) {
                    throw new Error('Rebase conflict detected. Resolve conflicts in Overleaf, then retry.');
                }
                throw err;
            }
        } else {
            await fs.mkdir(path.dirname(this.localPath), { recursive: true });
            // execFile is used here too so the token in _repoUrl is passed as a plain
            // argument and never interpreted by a shell.
            await execFile('git', ['clone', this._repoUrl, this.localPath], { env: this._gitEnv() });
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
        return fs.readFile(this._safePath(filePath), 'utf-8');
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
            entry.preview = entry.content.substring(0, 100).replace(/\s+/g, ' ');
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
            const node = { ...entry, children: [] };

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

    /**
     * Returns the section object for a given title, or null if not found.
     *
     * When parentTitle is supplied, only sections that fall within that parent's
     * range are considered. This disambiguates documents where the same subsection
     * title appears under multiple top-level sections.
     */
    async getSection(filePath, sectionTitle, parentTitle = null) {
        const sections = await this.getSections(filePath);

        if (!parentTitle) {
            return sections.find(s => s.title === sectionTitle) ?? null;
        }

        const parent = sections.find(s => s.title === parentTitle);
        if (!parent) return null;

        // Determine the end of the parent's range: the next section of equal or
        // higher level, or end of file if there is none.
        const parentLevel = SECTION_LEVELS[parent.type] ?? 99;
        const nextSameLevel = sections.find(
            s => s.startIndex > parent.startIndex && (SECTION_LEVELS[s.type] ?? 99) <= parentLevel
        );
        const parentEnd = nextSameLevel ? nextSameLevel.startIndex : Infinity;

        return sections.find(
            s => s.title === sectionTitle &&
                s.startIndex > parent.startIndex &&
                s.startIndex < parentEnd
        ) ?? null;
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
     * Returns everything from \end{document} (inclusive) to the end of the file.
     * In a standard .tex file this is \end{document} plus any trailing whitespace.
     * Returns an empty string if \end{document} is not present (e.g. \input'd files).
     *
     * Note: bibliography commands (\bibliography{}, \bibliographystyle{},
     * \printbibliography) typically appear before \end{document} and are therefore
     * captured within the last section's content range. Use str_replace to edit them.
     */
    async getPostamble(filePath) {
        const content = await this.readFile(filePath);
        const endDocIdx = content.lastIndexOf('\\end{document}');
        if (endDocIdx === -1) return '';
        return content.slice(endDocIdx);
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
        if (since) args.push(`--since=${since}`);
        if (until) args.push(`--until=${until}`);
        if (filePath) args.push('--', filePath);

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

        const safeContext = Math.min(10, Math.max(0, Number.parseInt(contextLines, 10) || 3));
        const args = ['diff', `--unified=${safeContext}`];

        if (fromRef && toRef) {
            args.push(fromRef, toRef);
        } else if (fromRef) {
            args.push(fromRef);
        } else {
            // Default: all changes since last commit (staged + unstaged vs HEAD).
            args.push('HEAD');
        }

        if (filePaths.length) args.push('--', ...filePaths);

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
     * Replaces the content of a single named section.
     * The boundary is level-aware: the section ends where the next command of
     * equal or higher level begins (or at \end{document} if there is none).
     *
     * Options: same as writeFile.
     */
    async writeSection(filePath, sectionTitle, newContent, {
        commitMessage = 'Update section via Overleaf MCP',
        push = true,
        dryRun = false,
    } = {}) {
        if (dryRun) {
            const section = await this.getSection(filePath, sectionTitle);
            if (!section) throw new Error(`Section "${sectionTitle}" not found`);
            return { dryRun: true, sectionFound: true, newContentSize: newContent.length };
        }

        await this.cloneOrPull();
        const fullPath = this._safePath(filePath);

        // Read the file once and parse from the same string — no second cloneOrPull,
        // no risk of section offsets being computed from a newer version of the file.
        const fileContent = await fs.readFile(fullPath, 'utf-8');
        const sections = this._parseSections(fileContent);

        const target = sections.find(s => s.title === sectionTitle);
        if (!target) throw new Error(`Section "${sectionTitle}" not found`);

        const targetLevel = SECTION_LEVELS[target.type] ?? 99;
        const next = sections.find(
            s => s.startIndex > target.startIndex && (SECTION_LEVELS[s.type] ?? 99) <= targetLevel
        );

        // \end{document} fallback: if absent (e.g. a file that is \input'd into main.tex),
        // lastIndexOf returns -1 and slice(-1) would corrupt the file. Use length instead.
        const endDocIdx = fileContent.lastIndexOf('\\end{document}');
        const endIdx = next
            ? next.startIndex
            : (endDocIdx !== -1 ? endDocIdx : fileContent.length);

        const updated =
            fileContent.slice(0, target.startIndex) +
            newContent.trimEnd() + '\n\n' +
            fileContent.slice(endIdx);

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
        const fileContent = await fs.readFile(fullPath, 'utf-8');

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
        const fileContent = await fs.readFile(fullPath, 'utf-8');

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
        const fileContent = await fs.readFile(fullPath, 'utf-8');

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
        const fileContent = await fs.readFile(fullPath, 'utf-8');
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
        const fileContent = await fs.readFile(fullPath, 'utf-8');
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
        const fileContent = await fs.readFile(fullPath, 'utf-8');
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