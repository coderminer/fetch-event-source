'use strict';
/**
 * Fails when fragments of automation tool-payloads (editing-tool command
 * remnants that surface as stray comments or pseudo-markup) are found in the
 * shipped sources/docs. Runs as `posttest` so CI's plain `npm test` — and the
 * `prepublishOnly` gate, which runs the test — both enforce the scan:
 */
const fs = require('fs');
const path = require('path');

const markers = [
    // editing-tool payload markers:
    'tool_call', 'tool result', 'function_calls', 'function_results',
    'antml:', 'invoke_name', 'arg_key', 'arg_value', 'new_string',
    'old_string', 'parameter>',
    // actual fragments that leaked into this repo before (do not re-add):
    'dominate the', '<code tool_call>',
];

// markers that are wrong specifically in code files (README/CHANGELOG/AGENTS
// legitimately contain them, e.g. fenced code blocks):
const codeOnlyMarkers = ['```'];

const targets = [
    'src/parse.ts',
    'src/parse.spec.ts',
    'src/fetch.ts',
    'src/fetch.spec.ts',
    'src/index.ts',
    'README.md',
    'CHANGELOG.md',
    'AGENTS.md',
    'CONTRIBUTING.md',
    'package.json',
];

let problems = 0;
for (const rel of targets) {
    const abs = path.join(__dirname, '..', rel);
    const isCode = /\.[cm]?[jt]s$/.test(rel);
    let text;
    try {
        text = fs.readFileSync(abs, 'utf8');
    } catch {
        continue; // optional file, skip
    }
    text.split(/\r?\n/).forEach((line, i) => {
        const low = line.toLowerCase();
        for (const marker of markers) {
            if (low.includes(marker.toLowerCase())) {
                problems += 1;
                console.error(`${rel}:${i + 1}: leaked tool fragment "${marker}" in: ${line.trim().slice(0, 80)}`);
                break; // one report per line is enough
            }
        }
        if (isCode) {
            for (const marker of codeOnlyMarkers) {
                if (line.includes(marker)) {
                    problems += 1;
                    console.error(`${rel}:${i + 1}: misplaced "${marker}" fence in code: ${line.trim().slice(0, 80)}`);
                    break;
                }
            }
        }
    });
}

if (problems) {
    console.error(`\ntool-fragment scan: ${problems} hit(s). Remove the remnants before committing.`);
    process.exit(1);
}
console.log('tool-fragment scan: clean');
