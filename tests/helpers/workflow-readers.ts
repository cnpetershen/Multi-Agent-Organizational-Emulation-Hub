import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowSourceReader } from '@maoeh/workflow-engine';

export const workflowsRoot = fileURLToPath(new URL('../../workflows/', import.meta.url));

function toRelativePath(rootDirectory: string, filePath: string): string {
  return relative(rootDirectory, filePath).split('\\').join('/');
}

function isYamlFile(name: string): boolean {
  return name.endsWith('.yaml') || name.endsWith('.yml');
}

export function createMemoryWorkflowReader(
  files: Readonly<Record<string, string>>,
): WorkflowSourceReader {
  return {
    list(relativeDirectory) {
      const prefix = relativeDirectory === '' ? '' : `${relativeDirectory}/`;
      return Object.keys(files)
        .filter((path) => path.startsWith(prefix) && isYamlFile(path))
        .sort();
    },
    read(relativePath) {
      return files[relativePath] ?? null;
    },
  };
}

export function createNodeFsWorkflowReader(rootDirectory = workflowsRoot): WorkflowSourceReader {
  return {
    list(relativeDirectory) {
      const prefix = relativeDirectory === '' ? '' : `${relativeDirectory}/`;
      const baseDirectory =
        relativeDirectory === '' ? rootDirectory : join(rootDirectory, relativeDirectory);
      if (!existsSync(baseDirectory)) return [];
      const found: string[] = [];
      const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const fullPath = join(directory, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
            continue;
          }
          if (!isYamlFile(entry.name)) continue;
          const relativePath = toRelativePath(rootDirectory, fullPath);
          if (relativePath.startsWith(prefix)) found.push(relativePath);
        }
      };
      walk(baseDirectory);
      return found.sort();
    },
    read(relativePath) {
      const filePath = join(rootDirectory, relativePath);
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, 'utf8');
    },
  };
}
