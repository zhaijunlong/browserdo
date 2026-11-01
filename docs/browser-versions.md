# Which Embiody each BrowserDo needs

Each BrowserDo release works with one Embiody version and everything newer. The minimum is
`MIN_EMBIODY_VERSION` in `src/browser_version.ts`; raise it, and add a row here, when BrowserDo
starts relying on something only a newer browser has.

| BrowserDo | Oldest Embiody |
| --- | --- |
| 0.9.0 | 0.9.0.3 |

## What happens with an older browser

BrowserDo reads the browser's version from `/json/version` (`Chrome/156.0.8078.12 Embiody/0.9.0.3`)
each time it connects. If it is older than the minimum, every tool call fails with an error that
names both versions. The first one also opens `chrome://settings/help` in the browser, where the
update is fetched. After updating, restart the browser and then the BrowserDo MCP server.

If the version cannot be read at all, for example because the browser is not Embiody, every tool
call fails with an error saying so, and no page is opened.
