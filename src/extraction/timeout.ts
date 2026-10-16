export const extractionTimeoutMs = 15000;

/** Stop waiting for a page; late read-only extraction results are ignored. */
export async function withExtractionTimeout<T>(
  operation: () => Promise<T>,
  context: () => string = () => 'Waiting for the extension worker response.',
  timeoutMs = extractionTimeoutMs,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Extraction timed out after ${timeoutMs / 1000} seconds. ${context()}`,
              ),
            ),
          timeoutMs,
        );
      }),
      Promise.resolve().then(operation),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
