export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Rejects with a TimeoutError if the operation has not settled within the timeout.
 * The timer is always cleared, so a pending probe can never keep the process alive.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message = `Operation timed out after ${timeoutMs}ms`,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
