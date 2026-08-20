interface RetryOptions {
  maxRetries?: number;      // default 3
  baseDelayMs?: number;     // default 1000
  maxDelayMs?: number;      // default 10000
  jitter?: boolean;         // default true
  retryOn?: (status: number) => boolean;  // default: retry on 429, 500-599
}

export async function retryFetch(
  url: string,
  options: RequestInit = {},
  retryOptions: RetryOptions = {}
): Promise<Response> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    jitter = true,
    retryOn = (s) => s === 429 || s >= 500,
  } = retryOptions;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (attempt < maxRetries && retryOn(response.status)) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        const actualDelay = jitter ? delay * (0.5 + Math.random() * 0.5) : delay;
        await sleep(actualDelay);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        const actualDelay = jitter ? delay * (0.5 + Math.random() * 0.5) : delay;
        await sleep(actualDelay);
      }
    }
  }

  throw lastError || new Error(`Request failed after ${maxRetries} retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
