import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { serve } from "inngest/node";
import { z } from "zod";
import { env } from "./env.js";
import { sandcastleRun } from "./functions/run.js";
import { inngest, runRequested, runRequestedData } from "./inngest.js";
import { resolveProject } from "./projects.js";

const inngestHandler = serve({ client: inngest, functions: [sandcastleRun] });

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * Keyless Dispatch surface for callers on the Target (loopback) — the
 * harness holds the Inngest event key so dispatchers don't have to.
 * Reachability is the access control: compose publishes this port on Target
 * loopback and nowhere else. The same server also answers the Orchestrator,
 * which reaches it by service name over the compose network.
 */
const handleDispatch = async (req: IncomingMessage, res: ServerResponse) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "Request body must be JSON" });
  }
  const data = runRequestedData.safeParse(parsed);
  if (!data.success) {
    return json(res, 400, { error: z.prettifyError(data.error) });
  }
  // Resolve the Project up front so a dispatcher learns that a checkout is
  // missing or not Onboarded here, rather than having to go read a failed Run
  // in the Orchestrator. The Run resolves it again — this is a courtesy, not
  // the guard.
  try {
    await resolveProject(env.workspaceRoot, data.data.project);
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  const { ids } = await inngest.send(runRequested.create(data.data));
  return json(res, 202, { ids });
};

const handler = (req: IncomingMessage, res: ServerResponse): void => {
  if (req.url === "/dispatch") {
    if (req.method !== "POST") {
      return json(res, 405, { error: "Use POST" });
    }
    handleDispatch(req, res).catch((error) => {
      console.error("dispatch failed", error);
      json(res, 500, { error: "Dispatch failed" });
    });
    return;
  }
  inngestHandler(req, res);
};

// One listener. The Harness is a container: the Orchestrator reaches it by
// service name over the compose network, and the Target sees only what compose
// publishes — loopback (see `env.host`).
//
// No listen-error handler: the one this had existed to lose the dockerd boot
// race gracefully, and both the race and the systemd unit that restarted after
// it are gone. A bind failure now throws, and compose's restart policy is the
// supervisor.
createServer(handler).listen(env.port, env.host, () => {
  console.log(`sandcastle-vps harness listening on ${env.host}:${env.port}`);
});
