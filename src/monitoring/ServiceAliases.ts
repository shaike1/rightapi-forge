const SERVICE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ssh: ['sshd'],
  sshd: ['ssh'],
  cron: ['crond'],
  crond: ['cron'],
};

export function serviceCandidates(service: string): string[] {
  const normalized = service.trim().toLowerCase();
  if (!/^[a-z0-9_.@-]+$/.test(normalized)) return [];
  return [normalized, ...(SERVICE_ALIASES[normalized] || [])];
}
