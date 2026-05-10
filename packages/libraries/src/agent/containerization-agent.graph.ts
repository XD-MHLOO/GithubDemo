import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service.js';
import { containerizationAgentPrompt } from './prompts/containerization-agent.prompt.js';
import { WorkspaceService } from '../workspace/workspace.service.js';
import { DockerBuildService } from '../dockerBuild/dockerBuild.service.js';
import { DockerService } from '../docker/docker.service.js';
import { writeFile, readFile } from 'fs/promises';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import * as path from 'path';
import { StageRecord } from '../dockerBuild/dockerBuild.types.js';
import { DDGS } from '@phukon/duckduckgo-search';
import yaml from 'js-yaml';

const RESEARCH_ONLY_TOOLS = new Set([
    'add_ignore_glob', 'remove_ignore_glob',
    'add_retain_files', 'remove_retain_files',
    'add_retain_urls', 'remove_retain_urls',
    'add_req_files', 'add_req_urls',
    'switch_repo', 'clone_new_repo',
    'set_agent_status',
]);

const FIXING_TOOLS = new Set(['search_web']);

const AgentState = Annotation.Root({
    status: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0,
    }),
    phaseHistory: Annotation<Array<{ status: number; summary: string; timestamp: string }>>({
        reducer: (a, b) => [...a, ...b],  // Append, never replace
        default: () => [],
    }),

    messages: Annotation<BaseMessage[]>({
        reducer: (a, b) => [...a, ...b],
        default: () => [],
    }),
    currentRepo: Annotation<string>({
        reducer: (_, b) => b,
        default: () => '',
    }),
    deploymentRepo: Annotation<string>({
        reducer: (_, b) => b,
        default: () => '',
    }),
    retainedFiles: Annotation<Record<string, Record<string, string>>>({
        reducer: (a, b) => ({ ...a, ...b }),
        default: () => ({}),
    }),
    retainedUrls: Annotation<Record<string, string>>({
        reducer: (a, b) => ({ ...a, ...b }),
        default: () => ({}),
    }),
    requestedFiles: Annotation<Record<string, string[]>>({
        reducer: (_, b) => b,
        default: () => ({}),
    }),
    requestedUrls: Annotation<string[]>({
        reducer: (_, b) => b,
        default: () => [],
    }),
    ignoredGlobs: Annotation<Record<string, string[]>>({
        reducer: (a, b) => ({ ...a, ...b }),
        default: () => ({}),
    }),
    writtenFiles: Annotation<string[]>({
        reducer: (a, b) => [...new Set([...a, ...b])],
        default: () => [],
    }),
    repos: Annotation<string[]>({
        reducer: (a, b) => [...new Set([...a, ...b])],
        default: () => [],
    }),
    failureReason: Annotation<string>({
        reducer: (_, b) => b,
        default: () => '',
    }),
    isFixing: Annotation<boolean>({
        reducer: (_, b) => b,
        default: () => false,
    }),
    searchedUrls: Annotation<string[]>({
        reducer: (a, b) => [...new Set([...a, ...b])],
        default: () => [],
    }),
    searchCount: Annotation<number>({
        reducer: (a, b) => a + b,
        default: () => 0,
    }),

});

type AgentStateType = typeof AgentState.State;

@Injectable()
export class ContainerizationAgentGraph {
    private readonly logger = new Logger(ContainerizationAgentGraph.name);

    constructor(
        private readonly llmService: LlmService,
        private readonly workspaceService: WorkspaceService,
        private readonly dockerBuildService: DockerBuildService,
        private readonly dockerService: DockerService,
    ) {}

    private buildTools(
        getState: () => AgentStateType,
        setState: (patch: Partial<AgentStateType>) => void,
        deploymentPath: string
    ) {
        const addIgnoreGlob = tool(
            async ({ globs }) => {
                const state = getState();
                const currentRepo = state.currentRepo;
                const current = state.ignoredGlobs;
                const existing = current[currentRepo] ?? [];
                setState({
                    ignoredGlobs: { ...current, [currentRepo]: [...new Set([...existing, ...globs])] },
                });
                return `Added ignore globs to ${currentRepo}: ${globs.join(', ')}`;
            },
            { name: 'add_ignore_glob', description: 'Hide irrelevant file paths from the current repo\'s directory tree permanently', schema: z.object({ globs: z.array(z.string()).describe('Glob patterns to ignore') }) },
        );

        const searchWeb = tool(
            async ({ query }) => {
                try {

                    const state = getState();
                    const MAXSEARCH = 30
                    // Limit total searches
                    if (state.searchCount >= MAXSEARCH) {
                        return JSON.stringify({ 
                            query, 
                            results: [], 
                            message: `Search limit reached (${MAXSEARCH} searches).` 
                        });
                    }
                    
                    setState({ searchCount: 1 });
                    
                    const cleanQuery = query.replace(/"/g, '');
                    const ddgs = new DDGS();
                    const results = await ddgs.text({ keywords: cleanQuery, maxResults: 50 });
                    
                    const seenUrls = new Set(state.searchedUrls);
                    
                    const newResults = results.filter(r => !seenUrls.has(r.href));
                    
                    if (newResults.length === 0) {
                        return JSON.stringify({ query: cleanQuery, results: [], message: 'All results already seen' });
                    }
                    
                    setState({ searchedUrls: newResults.map(r => r.href) });
                    
                    const crawled = await Promise.all(newResults.map(async (r) => {
                        try {
                            const res = await fetch('http://localhost:11235/crawl', {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ urls: [r.href] }),
                            });
                            const data = await res.json();
                            const rawMarkdown = data?.results?.[0]?.markdown?.raw_markdown || '';
                            return { url: r.href, title: r.title, snippet: r.body, rawContent: rawMarkdown };
                        } catch (e: any) {
                            return { url: r.href, title: r.title, snippet: r.body, rawContent: `[Error: ${e.message}]` };
                        }
                    }));
                    
                    const MAX_TOKENS = 180000;
                    const MAX_CHARS = Math.floor(MAX_TOKENS * 3.75);
                    let totalChars = 0;
                    const toProcess: typeof crawled = [];
                    
                    for (const c of crawled) {
                        const chars = c.rawContent.length;
                        if (totalChars + chars > MAX_CHARS) break;
                        totalChars += chars;
                        toProcess.push(c);
                    }
                    
                    if (toProcess.length === 0) {
                        return JSON.stringify({ query: cleanQuery, results: [] });
                    }
                                        
                    const systemPrompt = `You are a content filter. Given a search query and web pages, extract ONLY the parts that are directly relevant to the query.

                    Rules:
                    - Remove irrelevant content: navigation, ads, footers, sidebars, cookie notices
                    - Do give a detailed extraction retaining everything relevant from the webpage
                    - Keep ALL technical details: commands, configs, versions, URLs, code blocks, error messages, file paths, etc..
                    - Keep ALL installation steps, deployment instructions, configuration examples, etc.. 
                    - Keep everything that is relevant
                    - Keep the original wording - do not paraphrase or summarize
                    - If a section is not relevant at all, remove it completely
                    - Output as JSON array: [{url: "...", content: "..."}, ...]`;

                    const userPrompt = `Search query: "${cleanQuery}"

                    Web pages:
                    ${toProcess.map((c, i) => `[${i}] URL: ${c.url}\nTitle: ${c.title}\n\n${c.rawContent}`).join('\n\n---\n\n')}

                    Return JSON array with url and filtered content.`;

                    const llmResponse = await this.llmService.invoke([
                        new SystemMessage(systemPrompt),
                        new HumanMessage(userPrompt)
                    ]);
                    
                    let extracted: any[];
                    try {
                        const jsonMatch = llmResponse.match(/\[[\s\S]*\]/);
                        extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
                    } catch {
                        extracted = crawled.map(c => ({ url: c.url, content: c.rawContent.slice(0, 5000) }));
                    }
                    
                    if (extracted.length === 0) {
                        return JSON.stringify({ 
                            query: cleanQuery, 
                            results: [], 
                            message: 'No relevant results found for this query. Try different keywords.' 
                        });
                    }
                    return JSON.stringify({ query: cleanQuery, results: extracted }, null, 2);
                    
                } catch (error: any) {
                    return JSON.stringify({ error: error.message, query });
                }
            },
            { 
                name: 'search_web', 
                description: 'Search the web. Returns filtered content. Never shows same URL twice.',
                schema: z.object({ query: z.string().describe('Search query') }) 
            },
        );

        const removeIgnoreGlob = tool(
            async ({ globs }) => {
                const state = getState();
                const currentRepo = state.currentRepo;
                const current = state.ignoredGlobs;
                const existing = current[currentRepo] ?? [];
                setState({ ignoredGlobs: { ...current, [currentRepo]: existing.filter(g => !globs.includes(g)) } });
                return `Removed ignore globs from ${currentRepo}: ${globs.join(', ')}`;
            },
            { name: 'remove_ignore_glob', description: 'Restore previously ignored paths in the current repo.', schema: z.object({ globs: z.array(z.string()) }) },
        );

        const addRetainFiles = tool(
            async ({ files }) => {
                const state = getState();
                const currentRepo = state.currentRepo;
                const existing = state.retainedFiles[currentRepo] ?? {};
                const newFiles: Record<string, string> = {};
                for (const f of files) newFiles[f.file_path] = f.content ?? '';
                setState({ retainedFiles: { ...state.retainedFiles, [currentRepo]: { ...existing, ...newFiles } } });
                return `Retained ${files.length} file(s) from ${currentRepo}`;
            },
            { name: 'add_retain_files', description: 'Store curated file content in context.', schema: z.object({ files: z.array(z.object({ file_path: z.string(), content: z.string().optional().describe('Curated content. Omit to retain the full raw file.') })) }) },
        );

        const removeRetainFiles = tool(
            async ({ files }) => {
                const state = getState();
                const currentRepo = state.currentRepo;
                const existing = state.retainedFiles[currentRepo] ?? {};
                const filtered: Record<string, string> = {};
                for (const path of Object.keys(existing)) { if (!files.includes(path)) filtered[path] = existing[path]; }
                setState({ retainedFiles: { ...state.retainedFiles, [currentRepo]: filtered } });
                return `Removed retained files from ${currentRepo}: ${files.join(', ')}`;
            },
            { name: 'remove_retain_files', description: 'Drop retained files no longer needed from the current repo.', schema: z.object({ files: z.array(z.string()) }) },
        );

        const addRetainUrls = tool(
            async ({ urls }) => {
                const current = getState().retainedUrls;
                const newUrls: Record<string, string> = {};
                for (const u of urls) newUrls[u.url] = u.content ?? '';
                setState({ retainedUrls: { ...current, ...newUrls } });
                return `Retained ${urls.length} URL(s)`;
            },
            { name: 'add_retain_urls', schema: z.object({ urls: z.array(z.object({ url: z.string(), content: z.string().optional().describe('Curated content. Omit to crawl and keep full raw content.') })) }) },
        );

        const removeRetainUrls = tool(
            async ({ urls }) => {
                const current = getState().retainedUrls;
                const filtered: Record<string, string> = {};
                for (const [url, content] of Object.entries(current)) { if (!urls.includes(url)) filtered[url] = content; }
                setState({ retainedUrls: filtered });
                return `Removed retained URLs: ${urls.join(', ')}`;
            },
            { name: 'remove_retain_urls', schema: z.object({ urls: z.array(z.string()) }) },
        );

        const addReqFiles = tool(
            async ({ files }) => {
                const state = getState();
                const MAX_FILES = 10;
                
                if (files.length > MAX_FILES) {
                    const accepted = files.slice(0, MAX_FILES);
                    const rejected = files.slice(MAX_FILES);
                    setState({ requestedFiles: { [state.currentRepo]: accepted } });
                    return `Requested ${accepted.length} file(s) for next turn from ${state.currentRepo}:\n${accepted.map(f => `  [ACCEPTED] ${f}`).join('\n')}\n\n${rejected.length} file(s) exceeded the ${MAX_FILES} limit and were NOT requested:\n${rejected.map(f => `  [REJECTED] ${f}`).join('\n')}\n\nPlease request the remaining files in another turn.`;
                }
                
                setState({ requestedFiles: { [state.currentRepo]: files } });
                return `Requested ${files.length} file(s) for next turn from ${state.currentRepo}:\n${files.map(f => `  [ACCEPTED] ${f}`).join('\n')}`;
            },
            { 
                name: 'add_req_files', 
                description: `Request files to read next turn from the current repo — shown once then cleared unless retained. Maximum 10 files per call.`,
                schema: z.object({ 
                    files: z.array(z.string()).describe('File paths to request (max 10 per call)') 
                }) 
            },
        );

        const addReqUrls = tool(
            async ({ urls }) => {
                setState({ requestedUrls: urls });
                return `Requested URLs for next turn: ${urls.join(', ')}`;
            },
            { name: 'add_req_urls', description: 'Request URLs to fetch next turn — shown once then cleared unless retained.', schema: z.object({ urls: z.array(z.string()) }) },
        );

        const switchRepo = tool(
            async ({ githubUrl }) => {
                const state = getState();
                if (!state.repos.includes(githubUrl)) return `Error: ${githubUrl} is not a known repository. Use clone_new_repo first.`;
                setState({ currentRepo: githubUrl });
                return `Switched browsing view to: ${githubUrl}`;
            },
            { name: 'switch_repo', description: 'Switch the active browsing view to another known repository.', schema: z.object({ githubUrl: z.string() }) },
        );

        const cloneNewRepo = tool(
            async ({ githubUrl, ref }) => {
                const state = getState();
                if (state.repos.includes(githubUrl)) return `Repository ${githubUrl} is already known. Use switch_repo to browse it.`;
                await this.workspaceService.cloneRepo(githubUrl, deploymentPath, ref);
                await this.workspaceService.ingestRepo(deploymentPath, githubUrl);
                setState({ repos: [...state.repos, githubUrl], currentRepo: githubUrl });
                return `Cloned ${githubUrl} and switched to it.`;
            },
            { name: 'clone_new_repo', description: 'Clone a new repository discovered from references.', schema: z.object({ githubUrl: z.string(), ref: z.string().optional() }) },
        );

        const setDeploymentRepo = tool(
            async ({ githubUrl }) => {
                const state = getState();
                if (!state.repos.includes(githubUrl)) return `Error: ${githubUrl} is not a known repository.`;
                setState({ deploymentRepo: githubUrl, status: 1 });
                return `Deployment target locked: ${githubUrl}. You are now in WRITING phase. All files will be written here.`;
            },
            { name: 'set_deployment_repo', description: 'Designate ONE repository as the deployment target after sufficient research. Automatically advances to WRITING phase.', schema: z.object({ githubUrl: z.string() }) },
        );

        const writeFiles = tool(
            async ({ files }) => {
                const state = getState();
                const deployment = state.deploymentRepo;
                if (!deployment) return "Error: No deployment repository set. Use set_deployment_repo first.";
                if (state.status !== 1) return "Error: You must use set_deployment_repo first to enter WRITING mode (status 1) before writing files.";

                const summaryFile = files.find(f => f.path === 'summary.yml');
                const repoFiles = files.filter(f => f.path !== 'summary.yml');

                // Write repo files immediately — no validation needed
                for (const file of repoFiles) {
                    const filePath = await this.workspaceService.getRepoFilePath(deploymentPath, deployment, file.path);
                    await writeFile(filePath, file.content, 'utf8');
                }

                if (repoFiles.length > 0) {
                    const current = state.writtenFiles;
                    setState({ writtenFiles: [...new Set([...current, ...repoFiles.map(f => f.path)])] });
                }

                let summaryResult = '';

                // Validate summary.yml before writing
                if (summaryFile) {
                    try {
                        const parsed = yaml.load(summaryFile.content) as any;
                        
                        if (!parsed || typeof parsed !== 'object' || !parsed.compose_files || !Array.isArray(parsed.compose_files)) {
                            summaryResult = `\n\n summary.yml REJECTED — incorrect structure. You wrote it as flat key-value pairs, but it MUST have a top-level "compose_files" array. The required format is:

        \`\`\`yaml
        compose_files:
        - path: "docker-compose.yml"
            env_path: ".env"
            images:
            - image: "myapp-service"
                need_build: true
                dockerfile_path: "path/to/Dockerfile"
                build_args:
                ARG_NAME: "value"
            - image: "postgres:15"
                need_build: false
        \`\`\`

        Do NOT write summary.yml as flat keys like "image:", "need_build:", etc. at the top level. Those go inside "images:" under "compose_files:". Rewrite summary.yml correctly and call write_files again with ONLY the corrected summary.yml.`;
                        } else {
                            for (let i = 0; i < parsed.compose_files.length; i++) {
                                const cf = parsed.compose_files[i];
                                if (!cf.path) {
                                    summaryResult = `\n\n summary.yml REJECTED — compose_files[${i}] missing required "path" field. Fix and try again.`;
                                    break;
                                }
                                if (!cf.images || !Array.isArray(cf.images)) {
                                    summaryResult = `\n\n summary.yml REJECTED — compose_files[${i}] (${cf.path}) missing required "images" array. Fix and try again.`;
                                    break;
                                }
                                for (let j = 0; j < cf.images.length; j++) {
                                    const img = cf.images[j];
                                    if (!img.image) {
                                        summaryResult = `\n\n summary.yml REJECTED — compose_files[${i}].images[${j}] missing required "image" field. Fix and try again.`;
                                        break;
                                    }
                                    if (img.need_build === undefined) {
                                        summaryResult = `\n\n summary.yml REJECTED — compose_files[${i}].images[${j}] (${img.image}) missing required "need_build" (true or false). Fix and try again.`;
                                        break;
                                    }
                                    if (img.need_build === true && !img.dockerfile_path) {
                                        summaryResult = `\n\n summary.yml REJECTED — compose_files[${i}].images[${j}] (${img.image}) has need_build:true but missing dockerfile_path. Fix and try again.`;
                                        break;
                                    }
                                }
                                if (summaryResult) break;
                            }

                            // Only write if no errors found
                            if (!summaryResult) {
                                const summaryPath = path.join(this.workspaceService.getAnalysisDir(deploymentPath), 'summary.yml');
                                await writeFile(summaryPath, summaryFile.content, 'utf8');
                                summaryResult = '\n\n summary.yml validated and written.';
                            }
                        }
                    } catch (e: any) {
                        summaryResult = `\n\n summary.yml REJECTED — not valid YAML. Parse error: ${e.message}. Rewrite it in the correct format with a top-level "compose_files" array.`;
                    }
                }

                const writtenList = repoFiles.map(f => ` ${f}`);
                
                return `Written to ${deployment}:\n${writtenList.join('\n')}${summaryResult}`;
            },
            { name: 'write_files', description: 'Write files to the deployment repository. Only available after set_deployment_repo and status ≥ WRITING.', schema: z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })) }) },
        );

       const setAgentStatus = tool(
            async ({ status, summary }) => {
                setState({ 
                    status,
                    phaseHistory: [{ 
                        status, 
                        summary, 
                        timestamp: new Date().toISOString() 
                    }]
                });
                this.logger.log(`Agent phase ${status}: ${summary}`);
                return `Agent status set to ${status}. Summary: ${summary}`;
            },
            { 
                name: 'set_agent_status', 
                description: 'Transition to a new phase. -1 = FAILED, 0 = PLANNING, 1 = WRITING, 2 = DONE. Provide a summary of what was accomplished.',
                schema: z.object({ 
                    status: z.number().int().min(-1).max(2),
                    summary: z.string().describe('Detailed summary of everything accomplished in this phase')
                }) 
            },
        );

        return [
            addIgnoreGlob, removeIgnoreGlob,
            addRetainFiles, removeRetainFiles,
            addRetainUrls, removeRetainUrls,
            addReqFiles, addReqUrls,
            switchRepo, writeFiles,
            cloneNewRepo, setDeploymentRepo,
            setAgentStatus,
            searchWeb
        ];
    }

    async buildGraph(deploymentPath: string) {
        let statePatch: Partial<AgentStateType> = {};
        let currentState: AgentStateType;
        const getState = () => currentState;
        const setState = (patch: Partial<AgentStateType>) => { statePatch = { ...statePatch, ...patch }; };
        const tools = this.buildTools(getState, setState, deploymentPath);

        const agentNode = async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
            currentState = state;
            statePatch = {};
            const freshState: Partial<AgentStateType> = { requestedFiles: {}, requestedUrls: [] };
            const currentRepo = state.currentRepo;

            let retainedFilesContent = '';
            for (const repoUrl of Object.keys(state.retainedFiles)) {
                const files = state.retainedFiles[repoUrl];
                if (Object.keys(files).length === 0) continue;
                retainedFilesContent += `\n## Retained files from ${repoUrl}\n`;
                for (const filePath of Object.keys(files)) {
                    if (files[filePath]) {
                        retainedFilesContent += `\n=== ${filePath} (curated) ===\n${files[filePath]}\n`;
                    } else {
                        const repoRoot = this.workspaceService.getRepoDir(deploymentPath, repoUrl);
                        retainedFilesContent += await this.workspaceService.getFilesForPrompt(repoRoot, [filePath]);
                    }
                }
            }

            let requestedFilesContent = '';
            for (const [repoUrl, filePaths] of Object.entries(state.requestedFiles)) {
                if (filePaths.length === 0) continue;
                const repoRoot = this.workspaceService.getRepoDir(deploymentPath, repoUrl);
                requestedFilesContent += `\n## Requested files from ${repoUrl}\n`;
                requestedFilesContent += await this.workspaceService.getFilesForPrompt(repoRoot, filePaths);
            }

            let retainedUrlsContent = '';
            for (const url of Object.keys(state.retainedUrls)) {
                if (state.retainedUrls[url]) {
                    retainedUrlsContent += `\n## ${url} (curated)\n\n${state.retainedUrls[url]}\n`;
                } else {
                    try {
                        const res = await fetch('http://localhost:11235/crawl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: [url] }) });
                        const data = await res.json();
                        const md = data?.results?.[0]?.markdown?.raw_markdown;
                        if (md) retainedUrlsContent += `\n## ${url}\n\n${md}\n`;
                    } catch { retainedUrlsContent += `\n## ${url}\n\n[Failed to fetch]\n`; }
                }
            }

            let requestedUrlsContent = '';
            for (const url of state.requestedUrls) {
                try {
                    const res = await fetch('http://localhost:11235/crawl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: [url] }) });
                    const data = await res.json();
                    const md = data?.results?.[0]?.markdown?.raw_markdown;
                    if (md) requestedUrlsContent += `\n## URL: ${url}\n\n${md}\n`;
                } catch {}
            }

            let writtenFilesContent = '';
            if (state.writtenFiles.length > 0) {
                const deploymentRepoDir = this.workspaceService.getRepoDir(deploymentPath, state.deploymentRepo);
                writtenFilesContent = await this.workspaceService.getFilesForPrompt(deploymentRepoDir, state.writtenFiles);
            }

            let summaryYmlContent = '';
            try {
                const analysisDir = this.workspaceService.getAnalysisDir(deploymentPath);
                summaryYmlContent = await this.workspaceService.getFilesForPrompt(analysisDir, ['summary.yml']);
            } catch {}

            const systemPrompt = containerizationAgentPrompt({
                status: state.status,
                deploymentRepo: state.deploymentRepo,
                repos: state.repos,
                currentRepo: state.currentRepo,
                directoryTree: await this.workspaceService.getRepoTree(deploymentPath, currentRepo, state.ignoredGlobs[currentRepo] ?? []),
                ignoredGlobs: state.ignoredGlobs[currentRepo] ?? [],
                retainedFilesContent,
                retainedUrlsContent,
                requestedFilesContent,
                requestedUrlsContent,
                writtenFilesContent,
                summaryYmlContent,
                phaseHistory: state.phaseHistory || [],
                isFixng: state.isFixing,
            });

            const messages: BaseMessage[] = [new SystemMessage(systemPrompt), ...state.messages];

            let availableTools = tools;
            if (state.status === 0) {
                if (state.isFixing) {
                    availableTools = tools.filter(t => RESEARCH_ONLY_TOOLS.has(t.name) || FIXING_TOOLS.has(t.name));
                } else {
                    availableTools = tools.filter(t => RESEARCH_ONLY_TOOLS.has(t.name));
                }
            }
            const response = await this.llmService.invokeWithTools(messages, availableTools);
            const content = typeof response.content === 'string' 
                ? response.content 
                : Array.isArray(response.content) 
                    ? response.content.map((c: any) => c.text || '').join('') 
                    : '';
            
            if (!content.trim() && (!response.tool_calls || response.tool_calls.length === 0)) {
                this.logger.warn('AI returned empty response, prompting to continue');
                return { 
                    ...freshState,
                    messages: [response, new HumanMessage('It seems you had nothing to say. Please analyze the current state and decide your next action or use set_agent_status to end.')] 
                };
            }
            return { ...freshState, messages: [response] };
        };

        const toolNodeWrapper = async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
            currentState = state;
            statePatch = {};
            const lastMessage = state.messages.at(-1) as AIMessage;
            const toolCalls = lastMessage.tool_calls ?? [];
            const toolMessages: ToolMessage[] = [];

            for (const toolCall of toolCalls) {
                const matchedTool = tools.find(t => t.name === toolCall.name);
                if (!matchedTool) {
                    // Return error for unknown tools
                    toolMessages.push(new ToolMessage({
                        tool_call_id: toolCall.id!,
                        content: `Error: Tool "${toolCall.name}" not available.`,
                    }));
                    continue;
                }

                try {
                    currentState = { ...state, ...statePatch };
                    const result = await (matchedTool as any).invoke(toolCall.args);
                    toolMessages.push(new ToolMessage({
                        tool_call_id: toolCall.id!,
                        content: typeof result === 'string' ? result : JSON.stringify(result),
                    }));
                } catch (err: any) {
                    // Catch Zod validation errors and return to LLM
                    toolMessages.push(new ToolMessage({
                        tool_call_id: toolCall.id!,
                        content: `Error calling ${toolCall.name}: ${err.message}`,
                    }));
                }

                if (statePatch.status === 2 || statePatch.status === -1) break;
            }

            return { messages: toolMessages, ...statePatch };
        };

        const shouldContinue = (state: AgentStateType): 'tools' | 'agent' | typeof END => {
            if (state.status === 2) return END;
            if (state.status === -1) return END;
            const last = state.messages.at(-1);
            if (!last) return END;
            if ('tool_calls' in last && (last as AIMessage).tool_calls?.length) return 'tools';
            if (last instanceof ToolMessage) return 'agent';
            if (last instanceof AIMessage) return 'agent';
            return END;
        };

        const graph = new StateGraph(AgentState)
            .addNode('agent', agentNode)
            .addNode('tools', toolNodeWrapper)
            .addEdge(START, 'agent')
            .addConditionalEdges('agent', shouldContinue, { tools: 'tools', agent: 'agent', [END]: END })
            .addConditionalEdges('tools', shouldContinue, { agent: 'agent', [END]: END });

        const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!, { schema: "agent" });
        await checkpointer.setup();
        return graph.compile({ checkpointer });
    }

    async run(input: { deploymentId: string; deploymentPath: string; currentRepo: string }) {
        try {
            this.logger.log(`Starting containerization agent for ${input.deploymentId}`);
            
            const graph = await this.buildGraph(input.deploymentPath);
            const config = { configurable: { thread_id: input.deploymentId }, recursionLimit: 100 };

            const result = await graph.invoke(
                {
                    messages: [new HumanMessage('Begin containerization analysis.')],
                    repos: [input.currentRepo],
                    currentRepo: input.currentRepo,
                },
                config,
            );

            return {
                status: result.status,
                failureReason: result.failureReason ?? '',
                repoUrl: result.deploymentRepo,
                state: {
                    currentRepo: result.currentRepo,
                    deploymentRepo: result.deploymentRepo,
                    retainedFiles: result.retainedFiles,
                    retainedUrls: result.retainedUrls,
                    ignoredGlobs: result.ignoredGlobs,
                    writtenFiles: result.writtenFiles,
                    repos: result.repos,
                    phaseHistory: result.phaseHistory || [],
                    searchedUrls: result.searchedUrls || [],
                }
            };
        } catch (err: any) {
            this.logger.error(`Agent run failed for ${input.deploymentId}: ${err.message}`);
            const message = err.message || '';
            const isTransient = 
                message.includes('500') || 
                message.includes('Internal Server Error') ||
                message.includes('503') || 
                message.includes('429') ||
                message.includes('rate limit') ||
                message.includes('timeout') ||
                message.includes('ECONNRESET') ||
                message.includes('ETIMEDOUT') ||
                message.includes('Too Many Requests');
            
            if (isTransient) {
                // Re-throw as regular Error so Temporal retries
                throw new Error(`Agent LLM error (retryable): ${err.message}`);
            }
            
            // Non-transient failures (bad repo, unsupported project, etc.)
            
            return {
                status: -1,
                failureReason: err.message,
                repoUrl: '',
                state: {}
                
            };
        }
    }
    async resume(input: {
        deploymentId: string;
        deploymentPath: string;
        repoUrl: string;
        mode: 1 | 2 | 3 | 4 | 5;
        stageHistory: StageRecord[];
        state?: any;
        logPath?: string;
        composePaths?: string | string[];
        connectivityResults?: { service: string; port: number; url: string; reachable: boolean; status: number | null; body: string; error: string | null }[];
    }) {
        try {
            this.logger.log(`Resuming containerization agent for ${input.deploymentId}, mode ${input.mode}`);
            
            const graph = await this.buildGraph(input.deploymentPath);

            const savedState = await graph.getState({ configurable: { thread_id: input.deploymentId } });
            if (!savedState.values) {
                throw new Error(`No saved state found for deployment ${input.deploymentId}`);
            }

            const stageHistoryText = this.dockerBuildService.formatStageHistory(input.stageHistory);

            // Gather compose logs for modes 2-5
            const paths = Array.isArray(input.composePaths) ? input.composePaths : (input.composePaths ? [input.composePaths] : []);
            let dockerPs = '';
            let dockerLogs = '';
            for (const composePath of paths) {
                const composeFilePath = await this.workspaceService.getRepoFilePath(input.deploymentPath, input.repoUrl, composePath);
                const { logs: ps } = await this.dockerService.composePs({ projectName: input.deploymentId, composeFile: composeFilePath, all: true });
                const { logs: logs } = await this.dockerService.composeLogs({ projectName: input.deploymentId, composeFile: composeFilePath });
                dockerPs += ps + '\n';
                dockerLogs += logs + '\n';
            }

            let composeLog = '';
            if (input.logPath?.trim()) {
                const rawContent = await readFile(input.logPath, 'utf8');
                composeLog = rawContent.split('\n').slice(-1000).join('\n');
            }

            const logsSection = composeLog?.trim()
                ? `====================\nCOMPOSE LOGS\n====================\n${composeLog}\n`
                : '';

            let userMessage = '';

            if (input.mode === 1) {
                userMessage = `
    A Docker BUILD error occurred. Fix the relevant Dockerfile(s).

    ===== STAGE HISTORY =====
    ${stageHistoryText}

    ====================
    BUILD LOGS
    ====================
    ${composeLog}
    `.trim();

            } else if (input.mode === 4) {
                const connectivitySection = input.connectivityResults?.map(r =>
                    `${r.service}:${r.port} (${r.url}) — ${r.reachable ? 'OK' : 'FAILED'} | HTTP ${r.status ?? 'no response'} | ${r.error ?? ''}\nBody: ${r.body}`
                ).join('\n\n') ?? 'No connectivity results provided';

                userMessage = `
    The application is running but cannot be reached via HTTP or has errors. Fix the routing configuration.

    ===== STAGE HISTORY =====
    ${stageHistoryText}

    ====================
    DOCKER CONTAINERS (ps)
    ====================
    ${dockerPs}

    ====================
    DOCKER LOGS
    ====================
    ${dockerLogs}

    ====================
    CONNECTIVITY RESULTS
    ====================
    ${connectivitySection}
    `.trim();

            } else {
                const modeHeaders = [
                    '',
                    '',
                    'A Docker Compose RUN error occurred. Fix the relevant docker-compose or config files.',
                    'All services started successfully via docker compose up, but one or more containers are unhealthy or have exited unexpectedly after startup.',
                    'The application is running but cannot be reached via HTTP. Fix the routing configuration (Caddyfile, nginx config, or compose ports).',
                    'The application is already deployed but users report errors. Analyze the logs below. Only attempt fixes if you find actual errors (exceptions, crashes, connection failures, etc.). If the logs show normal operation with no errors, respond with fixable: false and with reason.',
                ];

                userMessage = `
    ${modeHeaders[input.mode]}

    ===== STAGE HISTORY =====
    ${stageHistoryText}

    ${logsSection}
    ====================
    DOCKER CONTAINERS (ps)
    ====================
    ${dockerPs}

    ====================
    DOCKER LOGS
    ====================
    ${dockerLogs}
    `.trim();
            }

            const old = input.state || {};

            const result = await graph.invoke(
                {
                    currentRepo: old.currentRepo || '',
                    deploymentRepo: old.deploymentRepo || '',
                    retainedFiles: old.retainedFiles || {},
                    retainedUrls: old.retainedUrls || {},
                    ignoredGlobs: old.ignoredGlobs || {},
                    writtenFiles: old.writtenFiles || [],
                    repos: old.repos || [],
                    phaseHistory: old.phaseHistory || [],
                    searchCount: old.searchCount || 0,
                    searchedUrls: old.searchedUrls || [],
                    messages: [new HumanMessage(userMessage)],
                    status: 0,
                    isFixing: true,
                },
                {
                    configurable: { thread_id: `${input.deploymentId}-fix-${Date.now()}` },
                    recursionLimit: 200,
                },
            );

            return {
                status: result.status,
                failureReason: result.failureReason ?? '',
                state: {
                    currentRepo: result.currentRepo,
                    deploymentRepo: result.deploymentRepo,
                    retainedFiles: result.retainedFiles,
                    retainedUrls: result.retainedUrls,
                    ignoredGlobs: result.ignoredGlobs,
                    writtenFiles: result.writtenFiles,
                    repos: result.repos,
                    phaseHistory: result.phaseHistory || [],
                    searchedUrls: result.searchedUrls || [],
                    searchCount: result.searchCount || 0,
                },
            };
        } catch (err: any) {
            this.logger.error(`Agent resume failed for ${input.deploymentId}: ${err.message}`);
            const message = err.message || '';
            const isTransient = 
                message.includes('500') || 
                message.includes('Internal Server Error') ||
                message.includes('503') || 
                message.includes('429') ||
                message.includes('rate limit') ||
                message.includes('timeout') ||
                message.includes('ECONNRESET') ||
                message.includes('ETIMEDOUT') ||
                message.includes('Too Many Requests');
            
            if (isTransient) {
                // Re-throw as regular Error so Temporal retries
                throw new Error(`Agent LLM error (retryable): ${err.message}`);
            }
            
            // Non-transient failures (bad repo, unsupported project, etc.)
            return {
                status: -1,
                failureReason: err.message,
                state: {},
            };
        }
    }
}