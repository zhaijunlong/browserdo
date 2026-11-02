import net from "node:net";
import os from "node:os";

/**
 * One install of the browser at a time across BrowserDo processes: Claude Desktop starts the
 * server twice (a probe, then the real one), and two clients can start together. Run at the same
 * time, two installers fail each other (75075). The lock is a named pipe, so the system drops it
 * when its process dies, even when killed mid-download.
 */
export const INSTALL_LOCK_PIPE = `\\\\.\\pipe\\browserdo-install-${os.userInfo().username.replace(/[^\w.-]/g, "_")}`;

/**
 * Take the lock, or null when another process holds it; call release() when done. Whoever
 * connects to the pipe is sent describe(), so processes waiting can show the holder's progress.
 */
export function acquireInstallLock(
  describe: () => string = () => "",
  pipe = INSTALL_LOCK_PIPE,
): Promise<{ release(): void } | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.end(describe());
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen(pipe, () => {
      server.unref();
      resolve({ release: () => server.close() });
    });
  });
}

/** What the lock's holder sends, or null when nobody holds it or it does not answer within a second. */
export function readInstallLock(pipe = INSTALL_LOCK_PIPE): Promise<string | null> {
  return new Promise((resolve) => {
    let text = "";
    const socket = net.connect(pipe);
    socket.setTimeout(1_000, () => socket.destroy());
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => resolve(text));
    socket.on("error", () => resolve(null));
    socket.on("close", () => resolve(null));
  });
}
