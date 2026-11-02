// Builds the Claude Desktop extension: one bundled server file, a manifest and the license,
// packed into mcpb/browserdo-mcp-<version>.mcpb. Run after `npm run build` (the tool list is read
// from dist/). Claude Desktop runs it with its own Node.js, so users need none.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "mcpb");
const stage = path.join(out, "stage");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(stage, "server"), { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "index.ts")],
  outfile: path.join(stage, "server", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // The bundled CommonJS dependencies (express, ws) call require.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // Installs from Claude Desktop are counted as their own channel.
  define: { "process.env.BROWSERDO_CHANNEL": '"CLDD"' },
  logLevel: "warning",
});

const tools = await listTools();

const manifest = {
  manifest_version: "0.3",
  name: "browserdo",
  display_name: "BrowserDo",
  version: pkg.version,
  description: "Lets your AI agent read pages and act in Embiody, a Windows browser, while you keep using your PC.",
  long_description:
    "BrowserDo connects Claude to Embiody, a Windows browser built for AI agents. The agent works in its own " +
    "tabs in the background while you keep using your PC, and you can watch or take over at any time. " +
    "On first use BrowserDo downloads and installs the Embiody browser (about 140 MB).",
  author: { name: "Embiody Studio", email: "connect@embiody.com", url: "https://embiody.com" },
  repository: { type: "git", url: "https://github.com/zhaijunlong/browserdo" },
  homepage: "https://github.com/zhaijunlong/browserdo",
  documentation: "https://github.com/zhaijunlong/browserdo#readme",
  support: "https://github.com/zhaijunlong/browserdo/issues",
  license: pkg.license,
  keywords: ["browser", "browser-automation", "web", "windows", "embiody"],
  icon: "icon.png",
  privacy_policies: ["https://embiody.com/privacy"],
  server: {
    type: "node",
    entry_point: "server/index.mjs",
    mcp_config: { command: "node", args: ["${__dirname}/server/index.mjs"] },
  },
  tools,
  tools_generated: false,
  compatibility: { platforms: ["win32"], runtimes: { node: ">=20.0.0" } },
};
writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
copyFileSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
copyFileSync(path.join(root, "assets", "icon.png"), path.join(stage, "icon.png"));

const file = path.join(out, `browserdo-mcp-${pkg.version}.mcpb`);
const cli = path.join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
execFileSync(process.execPath, [cli, "validate", path.join(stage, "manifest.json")], { stdio: "inherit" });
execFileSync(process.execPath, [cli, "pack", stage, file], { stdio: "inherit" });

/** The tools the server registers, with the first sentence of each description. */
async function listTools() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createMcpServer } = await import(new URL("../dist/server.js", import.meta.url).href);
  const server = createMcpServer({}, "all", false);
  const client = new Client({ name: "build-mcpb", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => ({ name: t.name, description: (t.description ?? "").split(/(?<=\.)\s/)[0] }));
}
