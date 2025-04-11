#!/usr/bin/env node
/* eslint-disable no-console */

// A script to bisect TypeScript versions to find when a breaking change occurred
// This script only checks if yarn install is successful in dd repo with the selected TypeScript version

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Configuration
const TS_REPO_PATH = process.env.TS_REPO_PATH;
const DD_REPO_PATH = process.env.DD_REPO_PATH;
const LOGS_DIR = path.join(DD_REPO_PATH, 'ts-bisector/install-logs');
const LOG_FILE = path.join(LOGS_DIR, 'bisect-results.txt');
const BISECT_REPLAY_PATH = path.join(LOGS_DIR, 'bisect-replay.log');

/**
 * Returns a formatted timestamp for logging
 * @returns {string} Formatted timestamp [YYYY-MM-DD, HH:MM:SS]
 */
function getTimestamp() {
    const now = new Date();
    return `[${now.toLocaleString()}]`;
}

/**
 * Logs a message with timestamp
 * @param {string} message - Message to log
 */
function logWithTime(message) {
    console.log(`${getTimestamp()} ${message}`);
}

/**
 * Executes a command and returns its output
 * @param {string} command - Command to execute
 * @param {string} cwd - Working directory
 * @returns {string} Command output
 */
function runCommand(command, cwd) {
    try {
        logWithTime(`Running: ${command} (in ${cwd})`);
        const startTime = Date.now();
        const result = execSync(command, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
        })
            .toString()
            .trim();
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logWithTime(`Command completed in ${duration}s`);
        return result;
    } catch (error) {
        logWithTime(`Error executing command: ${command}`);
        logWithTime(error.message);

        // We don't exit here because we want to handle errors during yarn install
        throw error;
    }
}

/**
 * Build TypeScript and create a tarball
 * @returns {string} Path to the created TypeScript tarball
 */
function buildTypeScriptTarball() {
    logWithTime('Building TypeScript tarball...');

    // Step 1: Build TypeScript
    logWithTime('0. Running npm ci...');
    runCommand('npm ci', TS_REPO_PATH);

    logWithTime('1. Running npx hereby LKG...');
    runCommand('npx hereby LKG', TS_REPO_PATH);

    logWithTime('2. Running npx hereby clean...');
    runCommand('npx hereby clean', TS_REPO_PATH);

    logWithTime('3. Adding Git head to package.json...');
    runCommand(
        'node ./scripts/addPackageJsonGitHead.mjs package.json',
        TS_REPO_PATH,
    );

    logWithTime('4. Creating npm package...');
    runCommand('npm pack', TS_REPO_PATH);

    // Step 5: Find the created tarball using fs.readdirSync instead of glob
    const files = fs
        .readdirSync(TS_REPO_PATH)
        .filter(
            (file) => file.startsWith('typescript-') && file.endsWith('.tgz'),
        )
        // Sort by creation time, newest first
        .map((file) => {
            const filePath = path.join(TS_REPO_PATH, file);
            return {
                name: file,
                path: filePath,
                ctime: fs.statSync(filePath).ctime,
            };
        })
        .sort((a, b) => b.ctime - a.ctime)
        .map((file) => file.name);

    if (files.length === 0) {
        logWithTime('Could not find TypeScript tarball after npm pack');
        process.exit(1);
    }

    // Get the path to the most recently created tarball
    const originalTarballPath = path.join(TS_REPO_PATH, files[0]);

    // Rename it to a consistent name
    const renamedTarballPath = path.join(TS_REPO_PATH, 'typescript.tgz');

    // Remove any existing typescript.tgz first
    try {
        if (fs.existsSync(renamedTarballPath)) {
            fs.unlinkSync(renamedTarballPath);
        }

        // Rename the file
        fs.renameSync(originalTarballPath, renamedTarballPath);
        logWithTime(`Renamed tarball to: ${renamedTarballPath}`);
    } catch (error) {
        logWithTime(`Error renaming tarball: ${error.message}`);
        process.exit(1);
    }

    return renamedTarballPath;
}

/**
 * Tests if the TypeScript installation is successful
 * @returns {boolean} True if installation succeeds, false otherwise
 */
function testTypeScriptInstall() {
    logWithTime('Testing TypeScript installation...');

    // Step 1: Build TypeScript and rename tarball to typescript.tgz
    try {
        buildTypeScriptTarball();
    } catch (error) {
        logWithTime('Failed to build TypeScript tarball');
        return false;
    }

    // Step 2: Install in dd repo
    logWithTime('Installing TypeScript in dd repo...');

    let tsVersion = 'unknown';
    let installSuccessful = false;
    let errorMessage = '';

    try {
        // Run yarn install
        runCommand('yarn install', DD_REPO_PATH);

        // Get the TypeScript version to log
        const tsVersionOutput = runCommand('yarn tsc -v', DD_REPO_PATH);
        tsVersion =
            tsVersionOutput.split('\n').pop().replace('Version ', '') ||
            'unknown';

        // If we get here, installation was successful
        installSuccessful = true;
        logWithTime(`TypeScript version ${tsVersion} installed successfully`);
    } catch (error) {
        errorMessage = error.message;
        logWithTime(
            `TypeScript installation failed with error: ${errorMessage}`,
        );
    }

    // Get the current TS commit hash
    const commitHash = runCommand('git rev-parse HEAD', TS_REPO_PATH);
    const shortHash = commitHash.substring(0, 8);

    // Ensure logs directory exists
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    // Create a log file for this run
    const fileName = `${tsVersion}-${shortHash}-${
        installSuccessful ? 'success' : 'fail'
    }.txt`;
    const filePath = path.join(LOGS_DIR, fileName);

    // Write result details to a file
    const details = `Commit: ${commitHash}
TypeScript Version: ${tsVersion}
Installation: ${installSuccessful ? 'Success' : 'Failure'}
${!installSuccessful ? `Error: ${errorMessage}` : ''}`;

    fs.writeFileSync(filePath, details);

    // Also append a summary entry to the log file
    const summaryEntry = `${getTimestamp()},${commitHash},${tsVersion},${
        installSuccessful ? 'success' : 'failure'
    }`;
    fs.appendFileSync(LOG_FILE, `${summaryEntry}\n`);

    logWithTime(`Test result: ${installSuccessful ? 'SUCCESS' : 'FAILURE'}`);
    logWithTime(`Details saved to: ${filePath}`);

    return installSuccessful;
}

/**
 * Runs the TypeScript bisection process checking installation success
 */
async function bisectTypeScript() {
    // Prepare logs directory
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    // Ensure we're in the TypeScript repo for bisection
    process.chdir(TS_REPO_PATH);

    // Check if a bisect is already in progress
    logWithTime('Checking if a bisection is in progress...');
    let bisectInProgress = false;

    try {
        const logOutput = runCommand('git bisect log', TS_REPO_PATH);

        // If we get output and it has a bisect start, a bisection has been initiated
        if (logOutput) {
            bisectInProgress = true;
            logWithTime('Current bisection state:');
            logWithTime(logOutput);
        } else {
            logWithTime('No bisection in progress.');
        }
    } catch (error) {
        logWithTime('No bisection in progress.');
    }

    // Create or continue with log file
    if (!fs.existsSync(LOG_FILE)) {
        fs.writeFileSync(LOG_FILE, 'timestamp,commit,ts_version,result\n');
        logWithTime(`Created new log file at ${LOG_FILE}`);
    } else if (bisectInProgress) {
        logWithTime(`Continuing with existing log file at ${LOG_FILE}`);
    } else {
        // Reset log file when starting a new bisection
        fs.writeFileSync(LOG_FILE, 'timestamp,commit,ts_version,result\n');
        logWithTime(`Reset log file at ${LOG_FILE}`);
    }

    // Start bisection if not already in progress
    if (!bisectInProgress) {
        logWithTime(
            '\n=== Starting new TypeScript bisection for install test ===',
        );
        runCommand('git bisect start', TS_REPO_PATH);

        // You should adjust these versions to match your specific good/bad points
        runCommand('git bisect bad v5.6.2', TS_REPO_PATH);
        runCommand(
            'git bisect good 15f67e0b482faf9f6a3ab9965f3c11196bf3e99b',
            TS_REPO_PATH,
        );
    }

    let bisectComplete = false;

    // Continue bisection until complete
    while (!bisectComplete) {
        // Test installation success for current commit
        const installSuccessful = testTypeScriptInstall();

        // Mark the commit as good if install succeeds, bad if it fails
        const verdict = installSuccessful ? 'bad' : 'good';

        // Reset changes in ts repo before marking the commit
        runCommand('git restore .', TS_REPO_PATH);

        // Mark the commit
        logWithTime(`\nMarking current commit as ${verdict}...`);
        const result = runCommand(`git bisect ${verdict}`, TS_REPO_PATH);
        logWithTime(result);

        // Check if bisection is complete
        if (result.includes('is the first bad commit')) {
            logWithTime('\n=== Bisection Complete ===');
            bisectComplete = true;

            // Extract culprit commit hash
            const commitHashMatch = result.match(
                /^([a-f0-9]{40}) is the first bad commit/,
            );
            const culpritCommit = commitHashMatch
                ? commitHashMatch[1]
                : 'unknown';

            // Capture the full bisect log before resetting
            logWithTime('Saving bisect log for future replay...');
            try {
                const bisectLog = runCommand('git bisect log', TS_REPO_PATH);

                // Ensure the directory exists
                const replayDir = path.dirname(BISECT_REPLAY_PATH);
                if (!fs.existsSync(replayDir)) {
                    fs.mkdirSync(replayDir, { recursive: true });
                }

                // Write the bisect log
                fs.writeFileSync(BISECT_REPLAY_PATH, bisectLog);
                logWithTime(`Bisect log saved to: ${BISECT_REPLAY_PATH}`);
            } catch (error) {
                logWithTime(
                    `Warning: Could not save bisect log: ${error.message}`,
                );
            }

            // Add final entry to log file
            fs.appendFileSync(
                LOG_FILE,
                `\nBreaking change introduced in commit: ${culpritCommit}\n`,
            );

            logWithTime(
                '\nThe bisection process has identified the commit that introduced the breaking change.',
            );
            logWithTime(`See ${LOG_FILE} for all results.`);

            // Reset bisect when done
            runCommand('git bisect reset', TS_REPO_PATH);
        }
        // Check if we've hit a merge base or any other special case
        else if (result.includes('a merge base must be tested')) {
            logWithTime('\n=== Bisection Needs More Information ===');
            logWithTime('Skipping problematic commit...');
            const skipResult = runCommand('git bisect skip', TS_REPO_PATH);
            logWithTime(skipResult);
        }
    }
}

// Run the bisection process
bisectTypeScript().catch((err) => {
    logWithTime(`Error during bisection: ${err.message}`);
    // Make sure to reset bisect even if there's an error
    try {
        runCommand('git bisect reset', TS_REPO_PATH);
    } catch (resetErr) {
        logWithTime(`Error resetting bisect: ${resetErr.message}`);
    }
    process.exit(1);
});
