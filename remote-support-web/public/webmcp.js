async function provideRemoteSupportContext() {
  const modelContext = navigator.modelContext;
  if (!modelContext?.provideContext) return;

  async function publicBaseUrl() {
    try {
      const response = await fetch('/api/config', { credentials: 'same-origin' });
      if (response.ok) {
        const config = await response.json();
        if (config.publicBaseUrl) return String(config.publicBaseUrl).replace(/\/+$/, '');
      }
    } catch {
      // Fall back to the deployment default below.
    }
    return location.origin;
  }

  await modelContext.provideContext({
    tools: [
      {
        name: 'get_remote_support_status',
        description: 'Return the remote support service health status and public entrypoints.',
        inputSchema: {
          type: 'object',
          properties: {
            includeLinks: {
              type: 'boolean',
              description: 'Include customer and technician URLs in the response.'
            }
          },
          additionalProperties: false
        },
        execute: async ({ includeLinks = true } = {}) => {
          const response = await fetch('/health', { credentials: 'same-origin' });
          const health = await response.json();
          const baseUrl = await publicBaseUrl();
          return {
            ok: Boolean(health.ok),
            links: includeLinks ? {
              technician: `${baseUrl}/`,
              customerJoin: `${baseUrl}/customer.html`,
              auth: `${baseUrl}/auth.md`
            } : undefined
          };
        }
      },
      {
        name: 'open_customer_join_page',
        description: 'Open the customer join page for a human-supervised support session.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const url = `${await publicBaseUrl()}/customer.html`;
          window.open(url, '_blank', 'noopener,noreferrer');
          return { opened: true, url };
        }
      }
    ]
  });
}

provideRemoteSupportContext().catch(() => {});
