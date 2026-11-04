export interface OrganizationSourceReader {
  list(relativeDirectory: string): readonly string[];
  read(relativePath: string): string | null;
}
