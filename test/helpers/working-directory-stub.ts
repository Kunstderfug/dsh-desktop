/**
 * Minimal `workingDirectory` service for subagent fixtures.
 *
 * Harness 0.2.1 makes `SubagentRuntime` inject `workingDirectory`, whose real
 * provider in turn needs `fs`, `sessionProjections`, and `systemPrompt`. The
 * multitask tests exercise the subagent and plugin seams, not directory
 * changes, so they mount this fixed-directory stub instead of the full chain.
 *
 * @module test/helpers/working-directory-stub
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/**
 * One working directory shared by every session in a fixture.
 *
 * `get`/`ensure` answer the configured directory; `set` keeps an absolute
 * request and resolves a relative one against it, matching the real service's
 * contract closely enough for spawn and claim paths.
 */
export class StubWorkingDirectory extends Service {
  constructor(ctx: Context, private readonly directory: string) {
    super(ctx, 'workingDirectory')
  }

  /**
   * Read the committed directory.
   * @returns the fixture directory.
   */
  get(): string {
    return this.directory
  }

  /**
   * Validate the directory before a child starts.
   * @returns the fixture directory.
   */
  async ensure(): Promise<string> {
    return this.directory
  }

  /**
   * Change one session's directory.
   * @param _agent - owning agent, unused by the fixed directory.
   * @param next - absolute directory or a path relative to the fixture one.
   * @returns the resulting directory.
   */
  async set(_agent: unknown, next: string): Promise<string> {
    return next.startsWith('/') ? next : `${this.directory}/${next}`
  }
}
