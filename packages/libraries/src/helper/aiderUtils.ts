import * as path from 'path';
import { promises as fsp } from 'fs';
import * as fs from 'fs';

// ============================================================================
// REGEX PATTERNS FOR PARSING SEARCH/REPLACE BLOCKS
// ============================================================================

const HEAD = /^<{5,9} SEARCH>?\s*$/;
const DIVIDER = /^={5,9}\s*$/;
const UPDATED = /^>{5,9} REPLACE\s*$/;

const DIVIDER_ERR = "=======";
const UPDATED_ERR = ">>>>>>> REPLACE";

const DEFAULT_FENCE: [string, string] = ["```", "```"];

const missing_filename_err = "Bad/missing filename. The filename must be alone on the line before the opening fence";

const triple_backticks = "```";

// ============================================================================
// FIND AND PARSE SEARCH/REPLACE BLOCKS FROM LLM RESPONSE
// ============================================================================

function stripFilename(filename: string, fence: [string, string]): string | null {
    filename = filename.trim();

    if (filename === "...") return null;

    const startFence = fence[0];
    if (filename.startsWith(startFence)) {
        const candidate = filename.slice(startFence.length);
        if (candidate && (candidate.includes(".") || candidate.includes("/"))) {
            return candidate;
        }
        return null;
    }

    if (filename.startsWith(triple_backticks)) {
        const candidate = filename.slice(triple_backticks.length);
        if (candidate && (candidate.includes(".") || candidate.includes("/"))) {
            return candidate;
        }
        return null;
    }

    filename = filename.replace(/:$/, "").replace(/^#/, "").trim();
    filename = filename.replace(/^`+|`+$/g, "").replace(/^\*+|\*+$/g, "");

    return filename ? filename : null;
}

function findFilename(lines: string[], fence: [string, string], validFnames: string[] = []): string | null {
    // Look back at up to 3 previous lines
    const lookback = lines.slice(-3).reverse();
    const filenames: string[] = [];

    for (const line of lookback) {
        const filename = stripFilename(line, fence);
        if (filename) filenames.push(filename);

        if (!line.startsWith(fence[0]) && !line.startsWith("```")) {
            break;
        }
    }

    if (filenames.length === 0) return null;

    // 1. Exact match
    for (const fname of filenames) {
        if (validFnames.includes(fname)) return fname;
    }

    // 2. Basename match
    for (const fname of filenames) {
        for (const vfn of validFnames) {
            if (fname === path.basename(vfn)) return vfn;
        }
    }

    // 3. Fallback: return first guessed filename
    return filenames[0];
}

export function* findOriginalUpdateBlocks(content: string, fence: [string, string] = DEFAULT_FENCE) {
    const lines = content.split(/\r?\n/).map(line => line + "\n");
    let i = 0;
    let currentFilename: string | null = null;

    while (i < len(lines)) {
        const line = lines[i].trim();

        if (HEAD.test(line)) {
            try {
                const prevLines = lines.slice(Math.max(0, i - 3), i).map(l => l.trim());
                let filename = findFilename(prevLines, fence);

                if (!filename) {
                    if (currentFilename) filename = currentFilename;
                    else throw new Error(missing_filename_err);
                }

                currentFilename = filename;
                const originalText: string[] = [];
                i++;

                while (i < lines.length && !DIVIDER.test(lines[i].trim())) {
                    originalText.push(lines[i]);
                    i++;
                }

                if (i >= lines.length || !DIVIDER.test(lines[i].trim())) {
                    throw new Error(`Expected \`${DIVIDER_ERR}\``);
                }

                const updatedText: string[] = [];
                i++;

                while (i < lines.length && !(UPDATED.test(lines[i].trim()) || DIVIDER.test(lines[i].trim()))) {
                    updatedText.push(lines[i]);
                    i++;
                }

                if (i >= lines.length || !(UPDATED.test(lines[i].trim()) || DIVIDER.test(lines[i].trim()))) {
                    throw new Error(`Expected \`${UPDATED_ERR}\``);
                }

                // console.log(`Found original text: ${originalText.join("")}`);
                // console.log(`Found updated text: ${updatedText.join("")}`);

                yield { filename, original: originalText.join(""), updated: updatedText.join("") };

            } catch (e: any) {
                const processed = lines.slice(0, i + 1).join("");
                throw new Error(`${processed}\n^^^ ${e.message}`);
            }
        }
        i++;
    }
}

// ============================================================================
// REPLACE LOGIC - FIND AND REPLACE TEXT IN FILES
// ============================================================================

function prep(content: string): [string, string[]] {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') {
            lines.push(content.slice(start, i + 1));
            start = i + 1;
        } else if (content[i] === '\r') {
            if (i + 1 < content.length && content[i + 1] === '\n') {
                lines.push(content.slice(start, i + 2));
                start = i + 2;
                i++;
            } else {
                lines.push(content.slice(start, i + 1));
                start = i + 1;
            }
        }
    }
    if (start < content.length) {
        lines.push(content.slice(start));
    }
    return [content, lines];
}

function perfectReplace(wholeLines: string[], partLines: string[], replaceLines: string[]): string | null {
    const partLen = partLines.length;

    for (let i = 0; i <= wholeLines.length - partLen; i++) {
        const segment = wholeLines.slice(i, i + partLen);
        if (segment.every((line, index) => line === partLines[index])) {
            const res = [...wholeLines.slice(0, i), ...replaceLines, ...wholeLines.slice(i + partLen)];
            return res.join("");
        }
    }
    return null;
}

function replacePartWithMissingLeadingWhitespace(wholeLines: string[], partLines: string[], replaceLines: string[]): string | null {
    const getLeading = (line: string) => line.length - line.trimStart().length;

    const leading = [...partLines, ...replaceLines]
        .filter(p => p.trim())
        .map(getLeading);   

    if (leading.length > 0 && Math.min(...leading) > 0) {
        const numLeading = Math.min(...leading);
        partLines = partLines.map(p => p.trim() ? p.slice(numLeading) : p);
        replaceLines = replaceLines.map(p => p.trim() ? p.slice(numLeading) : p);
    }

    const numPartLines = partLines.length;

    for (let i = 0; i <= wholeLines.length - numPartLines; i++) {
        const matches = partLines.every((pLine, j) => wholeLines[i + j].trimStart() === pLine.trimStart());

        if (!matches) continue;

        let leadingWs = "";
        for (let j = 0; j < numPartLines; j++) {
            if (wholeLines[i + j].trim()) {
                leadingWs = wholeLines[i + j].slice(0, getLeading(wholeLines[i + j]));
                break;
            }
        }

        const indentedReplace = replaceLines.map(rline => rline.trim() ? leadingWs + rline : rline);
        const finalLines = [...wholeLines.slice(0, i), ...indentedReplace, ...wholeLines.slice(i + numPartLines)];
        return finalLines.join("");
    }

    return null;
}

// Helper for .length parity with Python logic
function len(arr: any[]): number { return arr.length; }


/**
 * Handle ... (ellipsis) in SEARCH/REPLACE blocks.
 */
function tryDotDotDots(whole: string, part: string, replace: string): string | null {
    // Matches "..." on its own line, preserving indentation
    const dotsRe = /^([ \t]*\.\.\.\n)/gm;

    const partPieces = part.split(dotsRe);
    const replacePieces = replace.split(dotsRe);

    if (partPieces.length !== replacePieces.length) return null;
    if (partPieces.length === 1) return null;

    // Check that ellipsis patterns (odd indexes) match exactly (e.g. same indentation)
    for (let i = 1; i < partPieces.length; i += 2) {
        if (partPieces[i] !== replacePieces[i]) return null;
    }

    // Extract the content pieces (even indexes)
    const partContent = partPieces.filter((_, i) => i % 2 === 0);
    const replaceContent = replacePieces.filter((_, i) => i % 2 === 0);

    let result = whole;

    for (let i = 0; i < partContent.length; i++) {
        const pPiece = partContent[i];
        const rPiece = replaceContent[i];

        if (!pPiece && !rPiece) continue;

        if (!pPiece && rPiece) {
            if (!result.endsWith("\n")) result += "\n";
            result += rPiece;
            continue;
        }

        // Python's .count(sub) != 1 check
        const occurrences = result.split(pPiece).length - 1;
        if (occurrences !== 1) return null;

        result = result.replace(pPiece, rPiece);
    }

    return result;
}

/**
 * Best efforts to find `part` in `whole` and replace with `replace`.
 */
function replaceMostSimilarChunk(whole: string, part: string, replace: string): string | null {
    const [wStr, wLines] = prep(whole);
    const [pStr, pLines] = prep(part);
    const [rStr, rLines] = prep(replace);
    // Try 1: Perfect match
    let res = perfectReplace(wLines, pLines, rLines);
    if (res) return res;

    // Try 2: Flexible whitespace matching
    res = replacePartWithMissingLeadingWhitespace(wLines, pLines, rLines);
    if (res) return res;

    // Try 3: Handle ellipsis (...)
    try {
        res = tryDotDotDots(wStr, pStr, rStr);
        if (res) return res;
    } catch (e) {
        // Fall through
    }

    return null;
}

/**
 * Remove code fence wrapping around content.
 */
function stripQuotedWrapping(res: string, fname?: string, fence: [string, string] = DEFAULT_FENCE): string {
    if (!res) return res;

    let lines = res.split(/\r?\n/);

    // If first line ends with the filename, strip it
    if (fname && lines.length > 0 && lines[0].trim().endsWith(path.basename(fname))) {
        lines = lines.slice(1);
    }

    // If wrapped in fences, strip them
    if (lines.length >= 2 && lines[0].startsWith(fence[0]) && lines[lines.length - 1].startsWith(fence[1])) {
        lines = lines.slice(1, -1);
    }

    let finalRes = lines.join("\n");
    if (finalRes && !finalRes.endsWith("\n")) {
        finalRes += "\n";
    }

    return finalRes;
}

/**
 * Apply a single SEARCH/REPLACE block to file content.
 */
function doReplace(fname: string, content: string | null, beforeText: string, afterText: string, fence: [string, string] = DEFAULT_FENCE): string | null {
    const cleanBefore = stripQuotedWrapping(beforeText, fname, fence);
    const cleanAfter = stripQuotedWrapping(afterText, fname, fence);
    
    if (content === null) return null;

    // Create new file if it doesn't exist and SEARCH is empty
    if (!fs.existsSync(fname) && !cleanBefore.trim()) {
        const dir = path.dirname(fname);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fname, "");
        return cleanAfter;
    }

    if (!cleanBefore.trim()) {
        // Append to file
        return content + cleanAfter;
    } else {
        // Replace in file
        return replaceMostSimilarChunk(content, cleanBefore, cleanAfter);
    }
}

/**
 * Apply SEARCH/REPLACE edits to files.
 */
export async function applyEdits(edits: [string, string, string][], basePath: string = ".", fence: [string, string] = DEFAULT_FENCE) {
    const results = {
        passed: [] as any[],
        failed: [] as any[],
        errors: [] as any[]
    };
    for (const [filename, original, updated] of edits) {
        try {
            const fullPath = path.resolve(basePath, filename);

            // path traversal check
            const resolvedBase = path.resolve(basePath);
            if (!fullPath.startsWith(resolvedBase + path.sep) && fullPath !== resolvedBase) {
                results.errors.push({
                    file: filename,
                    error: 'File is not within the base path'
                });
                // console.log("skipped?")
                continue;
            }

            let content = "";

            try {
                content = await fsp.readFile(fullPath, 'utf-8');
            } catch {
                // file doesn't exist
                // console.log("File not exist")
            }

            const newContent = doReplace(fullPath, content, original, updated, fence);

            if (newContent === null) {
                results.failed.push({
                    file: filename,
                    reason: 'SEARCH block did not match file content'
                });
                continue;
            }
            // Write to file
            const dir = path.dirname(fullPath);
            await fsp.mkdir(dir, { recursive: true });
            await fsp.writeFile(fullPath, newContent, 'utf-8');

            results.passed.push({
                file: filename,
                lines_changed: newContent.split('\n').length - content.split('\n').length
            });

        } catch (e: any) {
            results.errors.push({
                file: filename,
                error: e.message
            });
        }
    }

    return results;
}
/**
 * Load files and format them as a prompt.
 */
export async function loadFilesForPrompt(filePaths: string[], rootPath: string = "."): Promise<string> {
    let prompt = "";
    const fenceOpen = "```";
    const fenceClose = "```";

    for (const filePath of filePaths) {
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(rootPath, filePath);

        // check after resolving absPath
        const resolvedRoot = path.resolve(rootPath);
        if (!absPath.startsWith(resolvedRoot + path.sep) && absPath !== resolvedRoot) {
            console.warn(`Warning: ${filePath} is outside root path, skipping`);
            continue;
        }

        try {
            await fsp.access(absPath);
        } catch {
            // console.warn(`Warning: ${filePath} does not exist, skipping`);
            continue;
        }

        try {
            const content = await fsp.readFile(absPath, 'utf-8');
            const relPath = path.relative(rootPath, absPath);
            
            prompt += `\n${relPath}\n${fenceOpen}\n${content}\n${fenceClose}\n`;
        } catch (e: any) {
            console.error(`Error reading ${filePath}: ${e.message}`);
            continue;
        }
    }

    return prompt;
}
