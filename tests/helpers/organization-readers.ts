import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OrganizationSourceReader } from '@maoeh/organization-model';

export function createMemoryOrganizationReader(
  files: Readonly<Record<string, string>>,
): OrganizationSourceReader {
  return {
    list(relativeDirectory) {
      const prefix = `${relativeDirectory}/`;
      return Object.keys(files)
        .filter((path) => path.startsWith(prefix) && path.endsWith('.yaml'))
        .sort();
    },
    read(relativePath) {
      return files[relativePath] ?? null;
    },
  };
}

export function createNodeFsOrganizationReader(
  rootDirectory: string,
): OrganizationSourceReader {
  return {
    list(relativeDirectory) {
      const directory = join(rootDirectory, relativeDirectory);
      if (!existsSync(directory)) return [];
      return readdirSync(directory)
        .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .map((entry) => `${relativeDirectory}/${entry}`)
        .sort();
    },
    read(relativePath) {
      const filePath = join(rootDirectory, relativePath);
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, 'utf8');
    },
  };
}
