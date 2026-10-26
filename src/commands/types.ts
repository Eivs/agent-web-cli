export interface CommandResult {
  stdout: string;
  /** Defaults to 0. */
  exitCode?: number;
}
