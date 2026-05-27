import { createApp } from './server.js';
import { config } from './config.js';

const { app } = createApp();

app.listen(config.port, config.host, () => {
  console.error(`[slushy-mcp] Streamable HTTP MCP on http://${config.host}:${config.port}/mcp`);
  console.error(`[slushy-mcp] HyPaper backend: ${config.hypaperHttpUrl} (ws ${config.hypaperWsUrl})`);
  console.error(`[slushy-mcp] supporter gate: ${config.supporterContract} @ ${config.arbitrumRpc}`);
});
