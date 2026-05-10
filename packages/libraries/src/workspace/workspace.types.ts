export type RepoIngestResult = {
  // Statistics
  totalFiles: number;
  totalCharacters: number;
  totalTokens: number;
  
  // Maps for quick lookups
  fileCharCounts: Record<string, number>;
  fileTokenCounts: Record<string, number>;

  // Core Data
  processedFiles: Array<{
    path: string;
    content: string;
  }>;

  // Metadata
  directoryStructure: string;
  safeFilePaths: string[];
  skippedFiles: Array<{
    path: string;
    reason: string;
  }>;

  // Git Info (optional based on your JSON)
  gitDiffTokenCount?: number;
  gitLogTokenCount?: number;
};
