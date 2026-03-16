#!/usr/bin/env node

/**
 * List AI Session Backups from GitHub Gists
 *
 * This script lists all AI agent session backup gists created by session-backup-gist.js
 * and allows downloading/restoring them.
 *
 * Usage:
 *   node scripts/session-list-gists.js [command] [options]
 *
 * Commands:
 *   list                    List all session backup gists (default)
 *   view <gist-id>          View contents of a specific gist
 *   download <gist-id>      Download gist contents to local directory
 *
 * Options:
 *   --limit <number>        Maximum number of gists to list (default: 20)
 *   --repo <owner/repo>     Filter by repository
 *   --output <path>         Output directory for download (default: ./.session-restore)
 *   --verbose               Enable verbose logging
 *
 * @pure false - contains IO effects (network, file system)
 * @effect GitHubGist, FileSystem
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * Parse command line arguments
 * @returns {Object} Parsed arguments
 */
const parseArgs = () => {
  const args = process.argv.slice(2);
  const result = {
    command: "list",
    gistId: null,
    limit: 20,
    repo: null,
    output: "./.session-restore",
    verbose: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      switch (arg) {
        case "--limit":
          result.limit = parseInt(args[++i], 10);
          break;
        case "--repo":
          result.repo = args[++i];
          break;
        case "--output":
          result.output = args[++i];
          break;
        case "--verbose":
          result.verbose = true;
          break;
        case "--help":
          console.log(`Usage: session-list-gists.js [command] [options]

Commands:
  list                    List all session backup gists (default)
  view <gist-id>          View contents of a specific gist
  download <gist-id>      Download gist contents to local directory

Options:
  --limit <number>        Maximum number of gists to list (default: 20)
  --repo <owner/repo>     Filter by repository
  --output <path>         Output directory for download (default: ./.session-restore)
  --verbose               Enable verbose logging
  --help                  Show this help message`);
          process.exit(0);
      }
    } else if (!result.command || result.command === "list") {
      // First non-flag argument is the command
      if (arg === "list" || arg === "view" || arg === "download") {
        result.command = arg;
      } else if (result.command !== "list") {
        result.gistId = arg;
      }
    } else if (!result.gistId) {
      result.gistId = arg;
    }
    i++;
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
    console.log(`[session-gists] ${message}`);
  }
};

/**
 * Execute gh CLI command and return result
 * @param {string[]} args - Command arguments
 * @returns {{success: boolean, stdout: string, stderr: string}}
 */
const ghCommand = (args) => {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    success: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
};

/**
 * List session backup gists
 * @param {number} limit - Maximum number of gists to list
 * @param {string|null} repoFilter - Repository filter
 * @param {boolean} verbose - Whether to log verbosely
 */
const listGists = (limit, repoFilter, verbose) => {
  log(verbose, `Fetching gists (limit: ${limit})`);

  const result = ghCommand([
    "gist",
    "list",
    "--limit",
    limit.toString(),
  ]);

  if (!result.success) {
    console.error(`Failed to list gists: ${result.stderr}`);
    process.exit(1);
  }

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const sessionBackups = [];

  for (const line of lines) {
    // Parse gist list output: ID  DESCRIPTION  FILES  VISIBILITY  UPDATED
    const parts = line.split("\t");
    if (parts.length < 2) continue;

    const [id, description] = parts;

    // Filter for session backups
    if (description && description.includes("AI Session Backup")) {
      // Check repo filter if specified
      if (repoFilter && !description.includes(repoFilter)) {
        continue;
      }

      sessionBackups.push({
        id: id.trim(),
        description: description.trim(),
        raw: line,
      });
    }
  }

  if (sessionBackups.length === 0) {
    console.log("No session backup gists found.");
    if (repoFilter) {
      console.log(`(Filtered by repo: ${repoFilter})`);
    }
    return;
  }

  console.log("Session Backup Gists:\n");
  console.log("ID\t\t\t\t\tDescription");
  console.log("-".repeat(80));

  for (const gist of sessionBackups) {
    console.log(`${gist.id}\t${gist.description}`);
  }

  console.log(`\nTotal: ${sessionBackups.length} session backup(s)`);
  console.log("\nTo view a gist: node scripts/session-list-gists.js view <gist-id>");
  console.log("To download: node scripts/session-list-gists.js download <gist-id>");
};

/**
 * View contents of a gist
 * @param {string} gistId - Gist ID
 * @param {boolean} verbose - Whether to log verbosely
 */
const viewGist = (gistId, verbose) => {
  if (!gistId) {
    console.error("Error: gist-id is required for view command");
    process.exit(1);
  }

  log(verbose, `Viewing gist: ${gistId}`);

  const result = ghCommand(["gist", "view", gistId]);

  if (!result.success) {
    console.error(`Failed to view gist: ${result.stderr}`);
    process.exit(1);
  }

  console.log(result.stdout);
};

/**
 * Download gist contents to local directory
 * @param {string} gistId - Gist ID
 * @param {string} outputDir - Output directory
 * @param {boolean} verbose - Whether to log verbosely
 */
const downloadGist = (gistId, outputDir, verbose) => {
  if (!gistId) {
    console.error("Error: gist-id is required for download command");
    process.exit(1);
  }

  log(verbose, `Downloading gist ${gistId} to ${outputDir}`);

  // Create output directory
  const outputPath = path.resolve(outputDir, gistId);
  fs.mkdirSync(outputPath, { recursive: true });

  // Clone gist
  const result = ghCommand(["gist", "clone", gistId, outputPath]);

  if (!result.success) {
    console.error(`Failed to download gist: ${result.stderr}`);
    process.exit(1);
  }

  console.log(`Downloaded gist to: ${outputPath}`);

  // List downloaded files
  const files = fs.readdirSync(outputPath).filter(f => !f.startsWith("."));
  console.log(`\nFiles (${files.length}):`);
  for (const file of files) {
    const stats = fs.statSync(path.join(outputPath, file));
    console.log(`  - ${file} (${stats.size} bytes)`);
  }

  console.log("\nTo restore session files, copy them to the appropriate location:");
  console.log("  - .codex/* files -> ~/.codex/");
  console.log("  - .claude/* files -> ~/.claude/");
  console.log("  - .knowledge/* files -> ./.knowledge/");
};

/**
 * Main function
 */
const main = () => {
  const args = parseArgs();
  const verbose = args.verbose;

  // Check gh CLI availability
  const authResult = ghCommand(["auth", "status"]);
  if (!authResult.success) {
    console.error("Error: GitHub CLI (gh) is not authenticated.");
    console.error("Run 'gh auth login' to authenticate.");
    process.exit(1);
  }

  switch (args.command) {
    case "list":
      listGists(args.limit, args.repo, verbose);
      break;
    case "view":
      viewGist(args.gistId, verbose);
      break;
    case "download":
      downloadGist(args.gistId, args.output, verbose);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      process.exit(1);
  }
};

main();
