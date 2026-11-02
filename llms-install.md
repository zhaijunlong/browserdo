# Installing BrowserDo (for AI agents)

You are adding BrowserDo, an MCP server, to the client you are running in. It is published on npm
as `browserdo-mcp` and runs through `npx`.

## Do

1. Check the requirements: Windows 10 or 11, 64-bit, and Node.js 20 or newer (`node -v`).
   If Node.js is missing or older, ask the user to run `winget install OpenJS.NodeJS.LTS` and restart
   the client, then continue.
2. Add one local (stdio) MCP server to **your own** MCP settings, with command `npx` and arguments
   `-y browserdo-mcp`:

   ```json
   {
     "mcpServers": {
       "browserdo": {
         "command": "npx",
         "args": ["-y", "browserdo-mcp"]
       }
     }
   }
   ```

   No API key or environment variable is needed.
3. Once the server is connected, call `browser_status`. On first use BrowserDo downloads and installs
   the Embiody browser by itself (about 140 MB, a few minutes). Until it is ready, `browser_status`
   and every other tool reply with the progress; call `browser_status` again every half minute or so.
4. When it says the browser is ready or installed, verify with `browser_read_pages` on one page,
   for example `{"urls": ["https://example.com/"]}`. Reading its title means the setup is done.

## Do not

- Do not change the MCP settings of other clients (Claude Code, Claude Desktop, Cursor, VS Code and
  so on). The README lists them for their own users.
- Do not clone the repository or build it: the npm package is all that is needed.
- Do not install the browser yourself or look in its folders to see whether it is installed.
  `browser_status` tells you.

## If you are Cline

Add the server through MCP Servers → Configure (Edit configuration) and edit the file it opens;
that is the file Cline reads. Running `npx -y browserdo-mcp` in a terminal does not install it for
you; only the config entry does. Don't install the package with `npm -g`, and don't stop node
processes.

## If something fails

If installing the browser fails, `browser_status` says why and gives a download link the user can
install from by hand; BrowserDo picks it up on the next call.
