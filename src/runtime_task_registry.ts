/**
 * Registry of running tasks (a per-process singleton).
 * browser_run_task registers a StopToken on start; browser_stop_task looks it up by taskId
 * and sets aborted plus the clean-up flags; the runtime checks aborted after its first
 * decision and at the start of each round, and exits gracefully.
 */

export interface StopToken {
  /** Once browser_stop_task sets this, the runtime stops at the start of the next round (a running round finishes first). */
  aborted: boolean;
  /** Whether to close the task's tab after stopping. */
  closeTab: boolean;
  /** Whether to close the task's browser window after stopping. */
  closeBrowserWindow: boolean;
}

const runningTasks = new Map<string, StopToken>();

export function registerTask(taskId: string): StopToken {
  const token: StopToken = {
    aborted: false,
    closeTab: false,
    closeBrowserWindow: false,
  };
  runningTasks.set(taskId, token);
  return token;
}

export function getTask(taskId: string): StopToken | undefined {
  return runningTasks.get(taskId);
}

export function unregisterTask(taskId: string): void {
  runningTasks.delete(taskId);
}
