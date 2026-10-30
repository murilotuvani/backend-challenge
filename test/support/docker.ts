import { env } from './env';

/** Docker Engine API pelo socket unix (montado no container de testes): reinicia/mata instâncias reais. */
async function engine(method: string, path: string): Promise<Response> {
  const res = await fetch(`http://localhost${path}`, { method, unix: env.dockerSocket } as RequestInit);
  if (res.status >= 400) {
    throw new Error(`docker ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

export const containerName = (service: string) => `${env.composeProject}-${service}-1`;

export async function restart(service: string, timeoutSeconds = 10): Promise<void> {
  await engine('POST', `/containers/${containerName(service)}/restart?t=${timeoutSeconds}`);
}

export async function kill(service: string): Promise<void> {
  await engine('POST', `/containers/${containerName(service)}/kill?signal=SIGKILL`);
}

export async function start(service: string): Promise<void> {
  await engine('POST', `/containers/${containerName(service)}/start`);
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await engine('GET', '/_ping');
    return true;
  } catch {
    return false;
  }
}

/** Espera a instância responder /health/ready. */
export async function waitReady(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health/ready`);
      if (res.ok) return;
    } catch {
      /* ainda subindo */
    }
    await Bun.sleep(500);
  }
  throw new Error(`${url} not ready after ${timeoutMs}ms`);
}
