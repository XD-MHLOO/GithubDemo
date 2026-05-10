import { Injectable, Logger } from '@nestjs/common';
import { runCli, type CliOptions } from 'repomix';
import { RepoIngestResult } from './workspace.types.js'
import { readFile, writeFile, mkdir } from 'fs/promises';
import * as path from 'path';
import { loadFilesForPrompt, findOriginalUpdateBlocks, applyEdits } from '../helper/aiderUtils.js';
import yaml from 'js-yaml';
import * as git from 'isomorphic-git';
import * as fs from 'fs';
import http from 'isomorphic-git/http/node';
import micromatch from 'micromatch';

@Injectable()
export class WorkspaceService {
    private readonly logger = new Logger(WorkspaceService.name);

    async createDeploymentDirectories(deploymentPath: string): Promise<void> {
        try {
            const subDirs = ['build', 'log', 'analysis', 'analysis/repos', 'repos'];
            await Promise.all(
                subDirs.map(dir =>
                    fs.promises.mkdir(path.join(deploymentPath, dir), { recursive: true })
                )
            );
        } catch (err: any) {
            this.logger.error(`Failed to create deployment directories at ${deploymentPath}: ${err.message}`);
            throw err;
        }
    }

    repoUrlToDirName(url: string): string {
        return url
            .replace(/^https?:\/\//, '')
            .replace(/\.git$/, '')
            .replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    private sanitizeFileName(name: string): string {
        return name
            .replace(/[/\\]/g, '_')
            .replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    private resolveSafe(rootPath: string, inputPath: string): string {
        const resolvedRoot = path.resolve(rootPath);
        const absPath = path.isAbsolute(inputPath)
            ? inputPath
            : path.resolve(rootPath, inputPath);

        const isInside = absPath === resolvedRoot || absPath.startsWith(resolvedRoot + path.sep);

        if (!isInside) {
            throw new Error(`Path traversal detected: ${inputPath}`);
        }

        return absPath;
    }

    getBuildDir(deploymentPath: string): string {
        return path.join(deploymentPath, 'build');
    }

    getLogDir(deploymentPath: string): string {
        return path.join(deploymentPath, 'log');
    }

    getAnalysisDir(deploymentPath: string): string {
        return path.join(deploymentPath, 'analysis');
    }

    getRepoDir(deploymentPath: string, url: string): string {
        return path.join(deploymentPath, 'repos', this.repoUrlToDirName(url));
    }

    getRepoAnalysisDir(deploymentPath: string, url: string): string {
        return path.join(deploymentPath, 'analysis', 'repos', this.repoUrlToDirName(url));
    }

    getRepoAnalysisFilePath(deploymentPath: string, repoUrl: string, filePath: string): string {
        const root = path.join(deploymentPath, 'analysis', 'repos', this.repoUrlToDirName(repoUrl));
        return this.resolveSafe(root, this.sanitizeFileName(filePath));
    }

    async getRepoFilePath(deploymentPath: string, repoUrl: string, filePath: string): Promise<string> {
        const root = this.getRepoDir(deploymentPath, repoUrl);
        const fullPath = this.resolveSafe(root, filePath);
        await mkdir(path.dirname(fullPath), { recursive: true });
        return fullPath;
    }

    getBuildFilePath(deploymentPath: string, filePath: string) {
        const root = path.join(deploymentPath, 'build');
        return this.resolveSafe(root, this.sanitizeFileName(filePath));
    }

    getLogFilePath(deploymentPath: string, filePath: string) {
        const root = path.join(deploymentPath, 'log');
        return this.resolveSafe(root, this.sanitizeFileName(filePath));
    }

    private _getRepoDataPath(deploymentPath: string, url: string): string {
        return path.join(deploymentPath, 'analysis', 'repos', this.repoUrlToDirName(url), 'result.json');
    }

    private async _getRepoData(deploymentPath: string, url: string): Promise<RepoIngestResult> {
        const dataPath = this._getRepoDataPath(deploymentPath, url);
        const raw = await readFile(dataPath, 'utf8');
        return JSON.parse(raw) as RepoIngestResult;
    }

    async cloneRepo(url: string, deploymentPath: string, ref?: string) {
        const localPath = this.getRepoDir(deploymentPath, url);
        try {
            await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
            await git.clone({
                fs,
                http,
                dir: localPath,
                url,
                ref,
                singleBranch: true,
                depth: 1,
            });
            this.logger.log(`Cloned ${url} to ${localPath}`);
            return localPath;
        } catch (err: any) {
            this.logger.error(`Failed to clone ${url}: ${err.message}`);
            try { await fs.promises.rm(localPath, { recursive: true, force: true }); } catch {}
            throw err;
        }
    }
async ingestRepo(deploymentPath: string, url: string): Promise<void> {
    const repoPath = this.getRepoDir(deploymentPath, url);
    const dataPath = this._getRepoDataPath(deploymentPath, url);
    
    try {
        // Debug: Show exact storage path
        // this.logger.log(`📁 Ingest data path: ${dataPath}`);
        // this.logger.log(`📁 Repo path: ${repoPath}`);
        
        // Ensure parent directory exists
        await fs.promises.mkdir(path.dirname(dataPath), { recursive: true });
        
        const options: CliOptions = {
            output: dataPath + '.tmp',
            style: 'json',
            quiet: true,
            compress: false,
            securityCheck: false,
            defaultPatterns: false
        };

        const result = await runCli(['.'], repoPath, options);

        if (!result || !result.packResult) {
            throw new Error('Repomix failed to generate results');
        }

        const repoData = result.packResult as unknown as RepoIngestResult;
        await writeFile(dataPath, JSON.stringify(repoData, null, 2), 'utf8');
        
        this.logger.log(`Ingested repo ${url} → ${dataPath}`);
    } catch (err: any) {
        this.logger.error(` Failed to ingest repo ${url}: ${err.message}`);
        this.logger.error(`   Path was: ${dataPath}`);
        try { await fs.promises.rm(dataPath, { force: true }); } catch {}
        try { await fs.promises.rm(dataPath + '.tmp', { force: true }); } catch {}
        throw err;
    }
}

    async getRepoTree(deploymentPath: string, url: string, ignore: string[] = []): Promise<string> {
        const repoData = await this._getRepoData(deploymentPath, url);
        const paths = repoData.processedFiles
            .filter(file => !this._matchAnyGlob(file.path.replace(/\\/g, '/'), ignore))
            .map(f => f.path)
            .sort();
        return paths.join('\n');
    }

    private _matchAnyGlob(filePath: string, patterns: string[]): boolean {
        if (!patterns || patterns.length === 0) return false;
        const normalizedPath = filePath.replace(/\\/g, '/');
        return micromatch.isMatch(normalizedPath, patterns, {
            dot: true,
            nocase: false,
        });
    }

    private _filterFiles(
        repo: RepoIngestResult,
        includePatterns: string[],
        ignorePatterns: string[] = []
    ) {
        const hasInclude = includePatterns && includePatterns.length > 0;
        return repo.processedFiles.filter(file => {
            const fp = file.path.replace(/\\/g, '/');
            if (hasInclude && !this._matchAnyGlob(fp, includePatterns)) return false;
            if (this._matchAnyGlob(fp, ignorePatterns)) return false;
            return true;
        });
    }

    private _chunkFiles(
        files: Array<{ path: string; content: string }>,
        repo: RepoIngestResult,
        maxTokens: number
    ): any[] {
        const chunks: any[] = [];
        let currentFiles: string[] = [];
        let currentChunk: string[] = [];
        let currentTokens = 0;
        const safeLimit = Math.floor(maxTokens * 0.9);

        for (const file of files) {
            const fileBlock = [
                "================",
                `File: ${file.path}`,
                "================",
                file.content
            ].join("\n");

            const blockTokens = repo.fileTokenCounts[file.path] || 0;

            if (blockTokens > safeLimit) {
                if (currentChunk.length > 0) {
                    chunks.push({ files: [...currentFiles], content: currentChunk.join("\n\n") });
                    currentChunk = [];
                    currentFiles = [];
                    currentTokens = 0;
                }
                chunks.push({ files: [file.path], content: fileBlock });
                continue;
            }

            if (currentTokens + blockTokens > safeLimit) {
                chunks.push({ files: [...currentFiles], content: currentChunk.join("\n\n") });
                currentChunk = [fileBlock];
                currentFiles = [file.path];
                currentTokens = blockTokens;
            } else {
                currentFiles.push(file.path);
                currentChunk.push(fileBlock);
                currentTokens += blockTokens;
            }
        }

        if (currentChunk.length > 0) {
            chunks.push({ files: [...currentFiles], content: currentChunk.join("\n\n") });
        }

        return chunks;
    }

    async getRepoFilesChunk(deploymentPath: string, url: string, includePatterns: string[], max_token = 180000) {
        const repoData = await this._getRepoData(deploymentPath, url);
        const filtered = this._filterFiles(repoData, includePatterns);
        const chunks = this._chunkFiles(filtered, repoData, max_token);
        return { chunks };
    }

    async getFilesForPrompt(root: string, filesToInclude: string[]): Promise<string> {
        return await loadFilesForPrompt(filesToInclude, root);
    }

    // async applyLlmEdits(deploymentPath: string, repoUrl: string, llmRawText: string) {
    //     const repoEdits: [string, string, string][] = [];
    //     const analysisEdits: [string, string, string][] = [];

    //     for (const block of findOriginalUpdateBlocks(llmRawText)) {
    //         if (block.filename.endsWith('summary.yml') || block.filename.endsWith('summary.yaml')) {
    //             analysisEdits.push([
    //                 block.filename.replace('summary.yaml', 'summary.yml'),
    //                 block.original,
    //                 block.updated
    //             ]);
    //         } else {
    //             repoEdits.push([block.filename, block.original, block.updated]);
    //         }
    //     }

    //     const repoRoot = this.getRepoDir(deploymentPath, repoUrl);
    //     const repoResults = await applyEdits(repoEdits, repoRoot);
    //     const analysisResults = await applyEdits(analysisEdits, this.getAnalysisDir(deploymentPath));

    //     const addedFiles = repoResults.passed.map(p => p.file);
    //     return addedFiles;
    // }

    async getRepoSummaryData(deploymentPath: string) {
        const summaryPath = path.join(this.getAnalysisDir(deploymentPath), 'summary.yml');
        const summaryContent = await readFile(summaryPath, 'utf8');
        return yaml.load(summaryContent) as any;
    }
}