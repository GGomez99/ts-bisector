#!/usr/bin/env node
/* eslint-disable no-console */

// dd repo: Datadog frontend monorepo
// ts repo: Typescript official repo

// Time TS
// Once a commit of TS is built:
// 1. Build TypeScript using npx hereby commands and npm pack
// 2. Install the resulting .tgz file in dd repo
// 3. Run yarn typecheck:packages
// 4. Run yarn tsc -b tsconfig.turbo.json --extendedDiagnostics
// 5. Get the hash of the commit
// 6. Record the timing in individual files

// Bisect TS using git bisect
// git bisect start
// git bisect good v5.5.4
// git bisect bad v5.8.2
// Time TS (cf above)
// if the timing is closer to 5.5.4 then mark the commit as good
// if the timing is closer to 5.8.2 then mark the commit as bad
// repeat until the bisector finds the commit

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Configuration
const TS_REPO_PATH = process.env.TS_REPO_PATH;
const DD_REPO_PATH = process.env.DD_REPO_PATH;
const TIMINGS_DIR = path.join(DD_REPO_PATH, 'ts-bisector/tsc-timings');
const SUMMARY_FILE = path.join(TIMINGS_DIR, 'summary.txt');

const BISECT_REPLAY_PATH = path.join(TIMINGS_DIR, 'bisect-replay.log');

// Reference timings for good and bad versions (hardcoded)
// These values should be replaced with actual measurements for your specific setup
const GOOD_VERSION_TIMING = 300; // for good version (5.5.4)
const BAD_VERSION_TIMING = 600; // for bad version (5.8.2)

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
        console.error(`${getTimestamp()} Error executing command: ${command}`);
        console.error(error.message);
        return error.message;
    }
}

/**
 * Build TypeScript and create a tarball
 * @returns {string} Path to the created TypeScript tarball
 */
function buildTypeScriptTarball(version = undefined) {
    logWithTime('Building TypeScript tarball...');

    const tsPackageJson = JSON.parse(
        fs.readFileSync(path.join(TS_REPO_PATH, 'package.json')),
    );

    let previousVersion;
    if (version) {
        logWithTime(
            `-1. Downgrade typescript version from ${tsPackageJson.version} to ${version}`,
        );
        previousVersion = tsPackageJson.version;
        tsPackageJson.version = version;
        fs.writeFileSync(
            path.join(TS_REPO_PATH, 'package.json'),
            JSON.stringify(tsPackageJson, null, 4),
        );

        const splitVersion = version.split('.');

        const corePublicFile = path.join(
            TS_REPO_PATH,
            'src/compiler/corePublic.ts',
        );
        const corePublicFileContent = fs.readFileSync(corePublicFile, 'utf8');
        fs.writeFileSync(
            corePublicFile,
            corePublicFileContent.replace(
                /export const versionMajorMinor = ".*";/,
                `export const versionMajorMinor = "${splitVersion[0]}.${splitVersion[1]}";`,
            ),
        );

        const testApiDeclarationFile = path.join(
            TS_REPO_PATH,
            'tests/baselines/reference/api/typescript.d.ts',
        );
        const testApiDeclarationFileContent = fs.readFileSync(
            testApiDeclarationFile,
            'utf8',
        );
        fs.writeFileSync(
            testApiDeclarationFile,
            testApiDeclarationFileContent.replace(
                /const versionMajorMinor = ".*";/,
                `const versionMajorMinor = "${splitVersion[0]}.${splitVersion[1]}";`,
            ),
        );
    }

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
        console.error('Could not find TypeScript tarball after npm pack');
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
        console.error(
            `${getTimestamp()} Error renaming tarball: ${error.message}`,
        );
        process.exit(1);
    }

    return {
        renamedTarballPath,
        previousVersion,
    };
}

/**
 * Measures TypeScript build timing for the current commit
 * @returns {number} Build time in seconds
 */
function measureTSBuildTime({
    runTypecheckPackages = true,
    versionOverride = undefined,
}) {
    logWithTime('Measuring build time for current TypeScript commit...');

    // Step 1: Build TypeScript and rename tarball to typescript.tgz
    buildTypeScriptTarball(versionOverride);

    // Step 2: Install in dd repo
    logWithTime('5. Installing TypeScript in dd repo...');
    const installResult = runCommand('yarn install', DD_REPO_PATH);

    let selectedVersionOverride;
    let previousVersion;
    if (installResult.includes('Command failed') && !versionOverride) {
        logWithTime('Unable to compile TypeScript, trying to downgrade...');
        const versionsToTry = ['5.5.0', '5.5.2', '5.6.2'];
        for (const version of versionsToTry) {
            runCommand('git restore .', TS_REPO_PATH);
            logWithTime(`Trying to downgrade to ${version}...`);
            const { previousVersion: previousVersionOverride } =
                buildTypeScriptTarball(version);
            previousVersion = previousVersionOverride;

            const versionInstallResult = runCommand(
                'yarn install',
                DD_REPO_PATH,
            );
            if (!versionInstallResult.includes('Command failed')) {
                logWithTime(`Successfully downgraded to ${version}`);
                selectedVersionOverride = version;
                break;
            } else {
                logWithTime(`Failed to downgrade to ${version}`);
            }
        }
    }

    // Get the TypeScript version
    logWithTime('Getting TypeScript version...');
    let tsVersion;
    if (versionOverride) {
        tsVersion = `${versionOverride}-override`;
    } else {
        const tsVersionOutput = runCommand('yarn tsc -v', DD_REPO_PATH);
        tsVersion = `${tsVersionOutput
            .split('\n')
            .pop()
            .replace('Version ', '')}${
            selectedVersionOverride ? `<-${previousVersion}` : ''
        }`;
    }
    logWithTime(`TypeScript version: ${tsVersion}`);

    let typecheckTime = 'skipped';
    if (runTypecheckPackages) {
        // Step 3: Run typecheck:packages with timing
        logWithTime('6. Running typecheck:packages with timing...');
        const typecheckStartTime = Date.now();

        // Run typecheck:packages using direct execSync with a single command
        try {
            logWithTime('Running: yarn typecheck:packages');
            const cmdStartTime = Date.now();

            execSync('yarn typecheck:packages', {
                cwd: DD_REPO_PATH,
                stdio: ['ignore', 'ignore', 'pipe'],
                encoding: 'utf-8',
            });

            const cmdDuration = ((Date.now() - cmdStartTime) / 1000).toFixed(2);
            logWithTime(`Command completed in ${cmdDuration}s`);
        } catch (error) {
            console.error(
                `${getTimestamp()} Error executing typecheck:packages`,
            );
            console.error(error.message);

            if (
                error.message.includes(
                    "File 'dd/tsconfig.focus.json' not found",
                )
            ) {
                logWithTime(
                    'Skipping this commit as tsconfig.focus.json is missing',
                );
                return null;
            }

            process.exit(1);
        }

        const typecheckEndTime = Date.now();
        typecheckTime = (
            (typecheckEndTime - typecheckStartTime) /
            1000
        ).toFixed(2);
        logWithTime(`typecheck:packages time: ${typecheckTime}s`);
    }

    // Step 4: Run tsc with extended diagnostics and capture timing
    logWithTime('7. Running tsc with extended diagnostics...');

    // Delete tsbuildinfo to ensure a clean build
    const tsBuildInfoPath = path.join(
        DD_REPO_PATH,
        'tsconfig.turbo.tsbuildinfo',
    );
    try {
        if (fs.existsSync(tsBuildInfoPath)) {
            logWithTime(`Deleting ${tsBuildInfoPath} for clean build...`);
            fs.unlinkSync(tsBuildInfoPath);
        }
    } catch (error) {
        logWithTime(
            `Warning: Could not delete ${tsBuildInfoPath}: ${error.message}`,
        );
    }

    const tscOutput = runCommand(
        'yarn tsc -b tsconfig.turbo.json --extendedDiagnostics',
        DD_REPO_PATH,
    );

    // Step 5: Get the current TS commit hash
    const commitHash = runCommand('git rev-parse HEAD', TS_REPO_PATH);

    // Parse the timing from the output (looking for line like "Build time:                            601.60s")
    const timeMatch = tscOutput.match(/Build time:\s+(\d+\.\d+)s/);
    const buildTime = timeMatch ? parseFloat(timeMatch[1]) : null;

    if (!buildTime) {
        console.error('Could not determine build time from tsc output');
        console.error('tsc output snippet:');
        // Print the last few lines of output to help debug
        const outputLines = tscOutput.split('\n');
        const lastLines = outputLines.slice(-20); // Last 20 lines
        console.error(lastLines.join('\n'));
        process.exit(1);
    }

    // Step 6: Create a unique filename with tsVersion
    const shortHash = commitHash.substring(0, 8);
    const fileName = `${tsVersion}-${shortHash}.txt`;
    const filePath = path.join(TIMINGS_DIR, fileName);

    // Ensure timings directory exists
    if (!fs.existsSync(TIMINGS_DIR)) {
        fs.mkdirSync(TIMINGS_DIR, { recursive: true });
    }

    // Write timing details to a new file (including the full tsc output for reference)
    const fullDetails = `Commit: ${commitHash}\nTypeScript Version: ${tsVersion}\nBuild Time: ${buildTime}s\ntypecheck:packages Time: ${typecheckTime}s\n\n--- TSC Output ---\n${tscOutput}`;
    fs.writeFileSync(filePath, fullDetails);

    // Also append a summary entry to the summary file
    const summaryEntry = `${getTimestamp()},${commitHash},${tsVersion},${typecheckTime},${buildTime}`;
    fs.appendFileSync(SUMMARY_FILE, `${summaryEntry}\n`);

    logWithTime(`Build time: ${buildTime}s for commit ${commitHash}`);
    logWithTime(`typecheck:packages time: ${typecheckTime}s`);
    logWithTime(`TypeScript version: ${tsVersion}`);
    logWithTime(`Details saved to: ${filePath}`);

    return buildTime;
}

/**
 * Decides if the current version is good or bad based on timing comparison
 * @param {number} currentTiming - Current build timing in seconds
 * @returns {string} 'good' or 'bad'
 */
function determineIfGoodOrBad(currentTiming) {
    if (currentTiming === null) {
        // Skip this commit as dd/tsconfig.focus.json is not resolvable
        return 'skip';
    }

    // Calculate midpoint timing and distance from current timing to good/bad
    const midpointTiming = (GOOD_VERSION_TIMING + BAD_VERSION_TIMING) / 2;

    if (currentTiming <= midpointTiming) {
        logWithTime(
            `Current timing (${currentTiming}s) is closer to good version timing (${GOOD_VERSION_TIMING}s)`,
        );
        return 'good';
    } else {
        logWithTime(
            `Current timing (${currentTiming}s) is closer to bad version timing (${BAD_VERSION_TIMING}s)`,
        );
        return 'bad';
    }
}

/**
 * Runs the TypeScript bisection process
 */
async function bisectTypeScript() {
    // Prepare timings directory and summary file
    if (!fs.existsSync(TIMINGS_DIR)) {
        fs.mkdirSync(TIMINGS_DIR, { recursive: true });
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

            // Display the log to show the current state
            logWithTime('Current bisection state:');
            logWithTime(logOutput);
        } else {
            logWithTime('No bisection in progress.');
        }
    } catch (error) {
        // If log command fails, no bisect is in progress
        logWithTime('No bisection in progress.');
    }

    // Handle summary file
    const summaryFileExists = fs.existsSync(SUMMARY_FILE);

    // Create summary file if it doesn't exist
    if (!summaryFileExists) {
        fs.writeFileSync(
            SUMMARY_FILE,
            'timestamp,commit,ts_version,typecheck_packages_time_s,build_time_s\n',
        );
        logWithTime(`Created new summary file at ${SUMMARY_FILE}`);
    } else if (bisectInProgress) {
        logWithTime(`Continuing with existing summary file at ${SUMMARY_FILE}`);
    } else {
        // Reset summary file when starting a new bisection
        fs.writeFileSync(
            SUMMARY_FILE,
            'timestamp,commit,ts_version,typecheck_packages_time_s,build_time_s\n',
        );
        logWithTime(`Reset summary file at ${SUMMARY_FILE}`);
    }

    // Start bisection if not already in progress
    if (!bisectInProgress) {
        logWithTime('\n=== Starting new TypeScript bisection with git ===');
        runCommand('git bisect start', TS_REPO_PATH);
        runCommand('git bisect good v5.5.4', TS_REPO_PATH);
        runCommand('git bisect bad v5.8.2', TS_REPO_PATH);
    }

    let bisectComplete = false;

    // Continue bisection until complete
    while (!bisectComplete) {
        // Measure current commit
        const currentTiming = measureTSBuildTime({
            runTypecheckPackages: true,
        });

        // Determine if current commit is good or bad
        const verdict = determineIfGoodOrBad(currentTiming);

        // Reset changes in ts repo before marking the commit as good or bad
        runCommand('git restore .', TS_REPO_PATH);

        // Mark the commit as good or bad
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

            // Add final entry to summary file
            fs.appendFileSync(
                SUMMARY_FILE,
                `\nCulprit commit: ${culpritCommit}\n`,
            );

            logWithTime(
                '\nThe bisection process has identified the culprit commit.',
            );
            logWithTime(`See ${SUMMARY_FILE} for all timing data.`);

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

const COMMITS_JSON_PATH = path.join(
    DD_REPO_PATH,
    'ts-bisector/commits-to-time.json',
);
const SUMMARY_FILE_PATH = path.join(TIMINGS_DIR, 'summary-commits-to-time.txt');
const COMMIT_SKIP_SIZE = 1;

async function timeTSCommitRange() {
    const commits = JSON.parse(
        fs.readFileSync(COMMITS_JSON_PATH, 'utf8'),
    ).reverse();
    let i = 0;
    while (i < commits.length) {
        const commitHash = commits[i];
        logWithTime(`Timing commit ${commitHash} (${i + 1}/${commits.length})`);
        runCommand('git restore .', TS_REPO_PATH);
        runCommand(`git checkout ${commitHash}`, TS_REPO_PATH);
        const buildTime = measureTSBuildTime({
            runTypecheckPackages: false,
            versionOverride: '5.5.0',
        });

        if (buildTime !== null) {
            logWithTime(`Build time for ${commitHash}: ${buildTime}s`);

            if (!fs.existsSync(SUMMARY_FILE_PATH)) {
                fs.writeFileSync(SUMMARY_FILE_PATH, 'commit,build_time_s\n');
            }
            fs.appendFileSync(
                SUMMARY_FILE_PATH,
                `${commitHash},${buildTime}\n`,
            );
            logWithTime(`Saved to ${SUMMARY_FILE_PATH}`);
        }

        if (i !== commits.length - 1) {
            i = Math.min(i + COMMIT_SKIP_SIZE, commits.length - 1);
        } else {
            i = commits.length;
        }
    }
}

// Parse command line arguments to determine which function to run
function showUsage() {
    console.log(`
Usage: node bisector.js <command>

Commands:
  bisect      Run TypeScript bisection to find regression
  time        Time a range of TypeScript commits
  help        Show this help message

Examples:
  TS_REPO_PATH=~/dev/typescript DD_REPO_PATH=~/dev/dd node bisector.js bisect
  TS_REPO_PATH=~/dev/typescript DD_REPO_PATH=~/dev/dd node bisector.js time
`);
}

// Get the command from arguments
const command = process.argv[2];

// Run the appropriate function based on the command
if (command === 'bisect') {
    bisectTypeScript().catch((err) => {
        console.error(`${getTimestamp()} Error during bisection:`, err);
        // Make sure to reset bisect even if there's an error
        try {
            runCommand('git bisect reset', TS_REPO_PATH);
        } catch (resetErr) {
            console.error(`${getTimestamp()} Error resetting bisect:`, resetErr);
        }
        process.exit(1);
    });
} else if (command === 'time') {
    timeTSCommitRange().catch((err) => {
        console.error(`${getTimestamp()} Error during commit timing:`, err);
        process.exit(1);
    });
} else {
    showUsage();
    if (command !== 'help') {
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
}
