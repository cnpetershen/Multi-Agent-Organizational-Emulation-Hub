export interface AgentDefinitionSourceReader {
  list(relativeDirectory: string): Promise<readonly string[]>;
  read(relativePath: string): Promise<unknown>;
}
