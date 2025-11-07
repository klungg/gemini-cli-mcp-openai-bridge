/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  loadServerHierarchicalMemory,
  setGeminiMdFilename as setServerGeminiMdFilename,
  getCurrentGeminiMdFilename,
  ApprovalMode,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  FileDiscoveryService,
  TelemetryTarget,
  SimpleExtensionLoader,
  DEFAULT_FILE_FILTERING_OPTIONS,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
} from '@google/gemini-cli-core';
import type {
  FileFilteringOptions,
  GeminiCLIExtension,
} from '@google/gemini-cli-core';
import { Settings } from './settings.js';

import { Extension } from './extension.js';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSandboxConfig } from './sandboxConfig.js';

const GEMINI_DIR = '.gemini';

// Simple console logger for now - replace with actual logger if available
const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any[]) => console.debug('[DEBUG]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any[]) => console.error('[ERROR]', ...args),
};

// This function is now a thin wrapper around the server's implementation.
// It's kept in the CLI for now as App.tsx directly calls it for memory refresh.
// TODO: Consider if App.tsx should get memory via a server call or if Config should refresh itself.
export async function loadHierarchicalGeminiMemory(
  currentWorkingDirectory: string,
  includeDirectoriesToReadGemini: readonly string[],
  debugMode: boolean,
  fileService: FileDiscoveryService,
  extensionLoader: SimpleExtensionLoader,
  folderTrust: boolean,
  memoryImportFormat: 'flat' | 'tree',
  fileFilteringOptions: FileFilteringOptions,
): Promise<{ memoryContent: string; fileCount: number; filePaths: string[] }> {
  if (debugMode) {
    logger.debug(
      `CLI: Delegating hierarchical memory load to server for CWD: ${currentWorkingDirectory} (memoryImportFormat: ${memoryImportFormat})`,
    );
  }

  return loadServerHierarchicalMemory(
    currentWorkingDirectory,
    includeDirectoriesToReadGemini,
    debugMode,
    fileService,
    extensionLoader,
    folderTrust,
    memoryImportFormat,
    fileFilteringOptions,
  );
}

export async function loadServerConfig(
  settings: Settings,
  extensions: Extension[],
  sessionId: string,
  debugMode: boolean,
  loadInternalPrompt: boolean,
  toolsModel?: string, // <-- New parameter
  targetDir?: string,
): Promise<Config> {
  loadEnvironment();

  // Set the context filename in the server's memoryTool module BEFORE loading memory
  // TODO(b/343434939): This is a bit of a hack. The contextFileName should ideally be passed
  // directly to the Config constructor in core, and have core handle setGeminiMdFilename.
  // However, loadHierarchicalGeminiMemory is called *before* createServerConfig.
  if (settings.contextFileName) {
    setServerGeminiMdFilename(settings.contextFileName);
  } else {
    // Reset to default if not provided in settings.
    setServerGeminiMdFilename(getCurrentGeminiMdFilename());
  }

  const resolvedTargetDir = targetDir || process.cwd();

  const geminiExtensions = toGeminiExtensions(extensions);
  const extensionLoader = new SimpleExtensionLoader(geminiExtensions);
  const includeDirectories: string[] = [];
  const folderTrust = true;
  const trustedFolder = true;
  const memoryImportFormat: 'flat' | 'tree' = 'tree';

  const memoryFileFiltering: FileFilteringOptions = {
    respectGitIgnore:
      settings.fileFiltering?.respectGitIgnore ??
      DEFAULT_MEMORY_FILE_FILTERING_OPTIONS.respectGitIgnore,
    respectGeminiIgnore: DEFAULT_MEMORY_FILE_FILTERING_OPTIONS.respectGeminiIgnore,
  };

  const fileService = new FileDiscoveryService(resolvedTargetDir);
  // Call the (now wrapper) loadHierarchicalGeminiMemory which calls the server's version
  let memoryContent = '';
  let fileCount = 0;
  let memoryFilePaths: string[] = [];

  if (loadInternalPrompt) {
    const memoryResult = await loadHierarchicalGeminiMemory(
      resolvedTargetDir,
      includeDirectories,
      debugMode,
      fileService,
      extensionLoader,
      folderTrust,
      memoryImportFormat,
      memoryFileFiltering,
    );
    memoryContent = memoryResult.memoryContent;
    fileCount = memoryResult.fileCount;
    memoryFilePaths = memoryResult.filePaths;
  }

  const mcpServers = mergeMcpServers(settings, extensions);

  const sandboxConfig = await loadSandboxConfig(settings, {});

  // Priority: CLI arg > env var > fallback env var > default
  const model =
    toolsModel ||
    process.env.GEMINI_TOOLS_DEFAULT_MODEL ||
    process.env.GEMINI_MODEL ||
    DEFAULT_GEMINI_FLASH_MODEL;

  return new Config({
    sessionId,
    embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
    sandbox: sandboxConfig,
    targetDir: resolvedTargetDir,
    includeDirectories,
    loadMemoryFromIncludeDirectories: false,
    debugMode,
    coreTools: settings.coreTools || undefined,
    excludeTools: settings.excludeTools || undefined,
    toolDiscoveryCommand: settings.toolDiscoveryCommand,
    toolCallCommand: settings.toolCallCommand,
    mcpServerCommand: settings.mcpServerCommand,
    mcpServers,
    userMemory: memoryContent,
    geminiMdFileCount: fileCount,
    geminiMdFilePaths: memoryFilePaths,
    approvalMode: ApprovalMode.YOLO,
    showMemoryUsage: settings.showMemoryUsage || false,
    accessibility: settings.accessibility,
    telemetry: {
      enabled: settings.telemetry?.enabled,
      target: settings.telemetry?.target as TelemetryTarget,
      otlpEndpoint:
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
        settings.telemetry?.otlpEndpoint,
      logPrompts: settings.telemetry?.logPrompts,
    },
    usageStatisticsEnabled: settings.usageStatisticsEnabled ?? true,
    // Git-aware file filtering settings
    fileFiltering: {
      respectGitIgnore: settings.fileFiltering?.respectGitIgnore,
      respectGeminiIgnore: DEFAULT_FILE_FILTERING_OPTIONS.respectGeminiIgnore,
      enableRecursiveFileSearch:
        settings.fileFiltering?.enableRecursiveFileSearch,
    },
    checkpointing: settings.checkpointing?.enabled,
    proxy:
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy,
    cwd: resolvedTargetDir,
    fileDiscoveryService: fileService,
    bugCommand: settings.bugCommand,
    model: model, // <-- Use the new model selection logic
    extensionLoader,
    folderTrust,
    trustedFolder,
    useRipgrep: true,
  });
}

function mergeMcpServers(settings: Settings, extensions: Extension[]) {
  const mcpServers = { ...(settings.mcpServers || {}) };
  for (const extension of extensions) {
    Object.entries(extension.config.mcpServers || {}).forEach(
      ([key, server]) => {
        if (mcpServers[key]) {
          logger.warn(
            `Skipping extension MCP config for server with key "${key}" as it already exists.`,
          );
          return;
        }
        mcpServers[key] = server;
      },
    );
  }
  return mcpServers;
}

function toGeminiExtensions(extensions: Extension[]): GeminiCLIExtension[] {
  return extensions.map((extension, index) => ({
    name: extension.config.name,
    version: extension.config.version,
    isActive: true,
    path: extension.rootDir,
    contextFiles: extension.contextFiles,
    mcpServers: extension.config.mcpServers,
    excludeTools: [],
    id: `${extension.config.name}-${index}`,
  }));
}
function findEnvFile(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  while (true) {
    // prefer gemini-specific .env under GEMINI_DIR
    const geminiEnvPath = path.join(currentDir, GEMINI_DIR, '.env');
    if (fs.existsSync(geminiEnvPath)) {
      return geminiEnvPath;
    }
    const envPath = path.join(currentDir, '.env');
    if (fs.existsSync(envPath)) {
      return envPath;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !parentDir) {
      // check .env under home as fallback, again preferring gemini-specific .env
      const homeGeminiEnvPath = path.join(os.homedir(), GEMINI_DIR, '.env');
      if (fs.existsSync(homeGeminiEnvPath)) {
        return homeGeminiEnvPath;
      }
      const homeEnvPath = path.join(os.homedir(), '.env');
      if (fs.existsSync(homeEnvPath)) {
        return homeEnvPath;
      }
      return null;
    }
    currentDir = parentDir;
  }
}

export function loadEnvironment(): void {
  const envFilePath = findEnvFile(process.cwd());
  if (envFilePath) {
    dotenv.config({ path: envFilePath, quiet: true });
  }
}
