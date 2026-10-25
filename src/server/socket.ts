/** The model API on a unix socket, for clients that cannot reach folio's port, such as a container's. */

import fs from "node:fs";
import type http from "node:http";
import net from "node:net";

/** Listen on a socket path only its owner may open, replacing a socket no process answers on. */
export async function listenSocket(server: http.Server, socket: string): Promise<void> {
  if (fs.existsSync(socket)) {
    if (!fs.lstatSync(socket).isSocket()) {
      throw new Error(`${socket} is not a socket, so folio leaves it alone.`);
    }

    if (await answers(socket)) {
      throw new Error(`Socket ${socket} is already in use.`);
    }

    fs.rmSync(socket);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  fs.chmodSync(socket, 0o600);

  for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => fs.rmSync(socket, { force: true }));
  }
}

function answers(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socket);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}
