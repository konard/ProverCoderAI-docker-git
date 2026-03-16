#!/usr/bin/env node

/**
 * Session Backup to GitHub Gist
 *
 * This script backs up AI agent session files (~/.codex, ~/.claude) to a private GitHub Gist
 * and optionally posts a comment to the associated PR with the gist link.
 *
 * Usage:
 *   node scripts/session-backup-gist.js [options]
 *
 * Options:
 *   --session-dir <path>    Path to session directory (default: auto-detect ~/.codex or ~/.claude)
 *   --pr-number <number>    PR number to post comment to (optional, auto-detected from branch)
 *   --repo <owner/repo>     Repository (optional, auto-detected from git remote)
 *   --no-comment            Skip posting PR comment
 *   --dry-run               Show what would be uploaded without actually uploading
 *   --verbose               Enable verbose logging
 *
 * Environment:
 *   DOCKER_GIT_SKIP_SESSION_BACKUP=1  Skip session backup entirely
 *
 * @pure false - contains IO effects (file system, network, git commands)
 * @effect FileSystem, ProcessExec, GitHubGist
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync, spawnSync } = require("node:child_process");
const os = require("node:os");

// Configuration
const MAX_GIST_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file limit for gists
const SESSION_DIR_NAMES = [".codex", ".claude"];
const KNOWLEDGE_DIR_NAME = ".knowledge";

/**
 * Parse command line arguments
 * @returns {Object} Parsed arguments
 */
const parseArgs = () => {
  const args = process.argv.slice(2);
  const result = {
    sessionDir: null,
    prNumber: null,
    repo: null,
    postComment: true,
    dryRun: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--session-dir":
        result.sessionDir = args[++i];
        break;
      case "--pr-number":
        result.prNumber = parseInt(args[++i], 10);
        break;
      case "--repo":
        result.repo = args[++i];
        break;
      case "--no-comment":
        result.postComment = false;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--verbose":
        result.verbose = true;
        break;
      case "--help":
        console.log(`Usage: session-backup-gist.js [options]

Options:
  --session-dir <path>    Path to session directory
  --pr-number <number>    PR number to post comment to
  --repo <owner/repo>     Repository
  --no-comment            Skip posting PR comment
  --dry-run               Show what would be uploaded
  --verbose               Enable verbose logging
  --help                  Show this help message`);
        process.exit(0);
    }
  }

  return result;
};

/**
 * Log message if verbose mode is enabled
 * @param {boolean} verbose - Whether verbose mode is enabled
 * @param {string} message - Message to log
 */
const log = (verbose, message) => {
  if (verbose) {
    console.log(`[session-backup] ${message}`);
  }
};

/**
 * Execute shell command and return stdout
 * @param {string} command - Command to execute
 * @param {Object} options - Execution options
 * @returns {string|null} Command output or null on error
 */
const execCommand = (command, options = {}) => {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch {
    return null;
  }
};

/**
 * Get current git branch name
 * @returns {string|null} Branch name or null
 */
const getCurrentBranch = () => {
  return execCommand("git rev-parse --abbrev-ref HEAD");
};

/**
 * Get repository owner/name from git remote
 * @returns {string|null} Repository in owner/repo format or null
 */
const getRepoFromRemote = () => {
  const remoteUrl = execCommand("git remote get-url origin");
  if (!remoteUrl) return null;

  // Handle SSH format: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+\/[^.]+)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // Handle HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^/]+\/[^.]+)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return null;
};

/**
 * Get PR number from current branch
 * @param {string} repo - Repository in owner/repo format
 * @param {string} branch - Branch name
 * @returns {number|null} PR number or null
 */
const getPrNumberFromBranch = (repo, branch) => {
  const result = execCommand(
    `gh pr list --repo ${repo} --head ${branch} --json number --jq '.[0].number'`
  );
  if (result && !isNaN(parseInt(result, 10))) {
    return parseInt(result, 10);
  }
  return null;
};

/**
 * Find session directories to backup
 * @param {string|null} explicitPath - Explicit session directory path
 * @param {boolean} verbose - Whether to log verbosely
 * @returns {Array<{name: string, path: string}>} List of session directories
 */
const findSessionDirs = (explicitPath, verbose) => {
  const dirs = [];

  if (explicitPath) {
    if (fs.existsSync(explicitPath)) {
      dirs.push({ name: path.basename(explicitPath), path: explicitPath });
    }
    return dirs;
  }

  // Check home directory for session directories
  const homeDir = os.homedir();
  for (const dirName of SESSION_DIR_NAMES) {
    const dirPath = path.join(homeDir, dirName);
    if (fs.existsSync(dirPath)) {
      log(verbose, `Found session directory: ${dirPath}`);
      dirs.push({ name: dirName, path: dirPath });
    }
  }

  // Check current working directory for .knowledge
  const cwd = process.cwd();
  const knowledgePath = path.join(cwd, KNOWLEDGE_DIR_NAME);
  if (fs.existsSync(knowledgePath)) {
    log(verbose, `Found knowledge directory: ${knowledgePath}`);
    dirs.push({ name: KNOWLEDGE_DIR_NAME, path: knowledgePath });
  }

  return dirs;
};

/**
 * Collect session files from a directory
 * @param {string} dirPath - Directory path
 * @param {string} baseName - Base name for the directory
 * @param {boolean} verbose - Whether to log verbosely
 * @returns {Array<{name: string, content: string}>} List of files with content
 */
const collectSessionFiles = (dirPath, baseName, verbose) => {
  const files = [];

  const walk = (currentPath, relativePath) => {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Skip certain directories
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        // Only include specific file types
        const ext = path.extname(entry.name).toLowerCase();
        const isSessionFile =
          ext === ".jsonl" ||
          ext === ".json" ||
          entry.name.endsWith(".part1") ||
          entry.name.endsWith(".part2") ||
          entry.name.endsWith(".part3") ||
          entry.name.endsWith(".chunks.json");

        if (isSessionFile) {
          try {
            const stats = fs.statSync(fullPath);
            if (stats.size <= MAX_GIST_FILE_SIZE) {
              const content = fs.readFileSync(fullPath, "utf8");
              const fileName = `${baseName}/${relPath}`.replace(/\//g, "_");
              files.push({ name: fileName, content });
              log(verbose, `Collected file: ${fileName} (${stats.size} bytes)`);
            } else {
              log(verbose, `Skipping large file: ${relPath} (${stats.size} bytes)`);
            }
          } catch (err) {
            log(verbose, `Error reading file ${fullPath}: ${err.message}`);
          }
        }
      }
    }
  };

  walk(dirPath, "");
  return files;
};

/**
 * Create a gist with the given files
 * @param {Array<{name: string, content: string}>} files - Files to upload
 * @param {string} description - Gist description
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {boolean} verbose - Whether to log verbosely
 * @returns {string|null} Gist URL or null on error
 */
const createGist = (files, description, dryRun, verbose) => {
  if (files.length === 0) {
    log(verbose, "No files to upload");
    return null;
  }

  if (dryRun) {
    console.log(`[dry-run] Would create gist with ${files.length} files:`);
    for (const file of files) {
      console.log(`  - ${file.name} (${file.content.length} bytes)`);
    }
    return "https://gist.github.com/dry-run/example";
  }

  // Create temporary directory for files
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-backup-"));

  try {
    // Write files to temp directory
    const filePaths = [];
    for (const file of files) {
      const filePath = path.join(tmpDir, file.name);
      fs.writeFileSync(filePath, file.content, "utf8");
      filePaths.push(filePath);
    }

    // Create gist using gh CLI
    const fileArgs = filePaths.map(f => `"${f}"`).join(" ");
    const command = `gh gist create ${fileArgs} --desc "${description}"`;

    log(verbose, `Creating gist: ${command}`);

    const result = spawnSync("gh", ["gist", "create", ...filePaths, "--desc", description], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (result.status !== 0) {
      console.error(`[session-backup] Failed to create gist: ${result.stderr}`);
      return null;
    }

    const gistUrl = result.stdout.trim();
    log(verbose, `Created gist: ${gistUrl}`);
    return gistUrl;
  } finally {
    // Cleanup temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

/**
 * Post a comment to a PR with the gist link
 * @param {string} repo - Repository in owner/repo format
 * @param {number} prNumber - PR number
 * @param {string} gistUrl - Gist URL
 * @param {boolean} dryRun - Whether to perform a dry run
 * @param {boolean} verbose - Whether to log verbosely
 * @returns {boolean} Whether the comment was posted successfully
 */
const postPrComment = (repo, prNumber, gistUrl, dryRun, verbose) => {
  const timestamp = new Date().toISOString();
  const comment = `## AI Session Backup

A snapshot of the AI agent session has been saved to a private gist:

**Gist URL:** ${gistUrl}

To resume this session, you can use:
\`\`\`bash
# For Codex
codex resume <session-id>

# For Claude
claude --resume <session-id>
\`\`\`

---
*Backup created at: ${timestamp}*`;

  if (dryRun) {
    console.log(`[dry-run] Would post comment to PR #${prNumber} in ${repo}:`);
    console.log(comment);
    return true;
  }

  log(verbose, `Posting comment to PR #${prNumber}`);

  const result = spawnSync(
    "gh",
    ["pr", "comment", prNumber.toString(), "--repo", repo, "--body", comment],
    {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  if (result.status !== 0) {
    console.error(`[session-backup] Failed to post PR comment: ${result.stderr}`);
    return false;
  }

  log(verbose, "Comment posted successfully");
  return true;
};

/**
 * Main function
 */
const main = () => {
  // Check if backup is disabled
  if (process.env.DOCKER_GIT_SKIP_SESSION_BACKUP === "1") {
    console.log("[session-backup] Skipped (DOCKER_GIT_SKIP_SESSION_BACKUP=1)");
    return;
  }

  const args = parseArgs();
  const verbose = args.verbose;

  log(verbose, "Starting session backup...");

  // Get repository info
  const repo = args.repo || getRepoFromRemote();
  if (!repo) {
    console.error("[session-backup] Could not determine repository. Use --repo option.");
    process.exit(1);
  }
  log(verbose, `Repository: ${repo}`);

  // Get current branch
  const branch = getCurrentBranch();
  if (!branch) {
    console.error("[session-backup] Could not determine current branch.");
    process.exit(1);
  }
  log(verbose, `Branch: ${branch}`);

  // Get PR number
  let prNumber = args.prNumber;
  if (!prNumber && args.postComment) {
    prNumber = getPrNumberFromBranch(repo, branch);
    if (!prNumber) {
      log(verbose, "No PR found for current branch, skipping comment");
    }
  }
  if (prNumber) {
    log(verbose, `PR number: ${prNumber}`);
  }

  // Find session directories
  const sessionDirs = findSessionDirs(args.sessionDir, verbose);
  if (sessionDirs.length === 0) {
    log(verbose, "No session directories found");
    return;
  }

  // Collect all session files
  const allFiles = [];
  for (const dir of sessionDirs) {
    const files = collectSessionFiles(dir.path, dir.name, verbose);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    log(verbose, "No session files found to backup");
    return;
  }

  log(verbose, `Total files to backup: ${allFiles.length}`);

  // Create gist
  const description = `AI Session Backup - ${repo} - ${branch} - ${new Date().toISOString()}`;
  const gistUrl = createGist(allFiles, description, args.dryRun, verbose);

  if (!gistUrl) {
    console.error("[session-backup] Failed to create gist");
    process.exit(1);
  }

  console.log(`[session-backup] Created gist: ${gistUrl}`);

  // Post PR comment
  if (args.postComment && prNumber) {
    postPrComment(repo, prNumber, gistUrl, args.dryRun, verbose);
  }

  console.log("[session-backup] Session backup complete");
};

main();
