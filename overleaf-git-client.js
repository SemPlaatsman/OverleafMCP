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

    /** Returns the section object for a given title, or null if not found. */
    async getSection(filePath, sectionTitle) {
        const sections = await this.getSections(filePath);
        return sections.find(s => s.title === sectionTitle) ?? null;
    }

    // ─── Public write API ────────────────────────────────────────────────────────

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
}