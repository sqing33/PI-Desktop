#!/usr/bin/env node
import { parseArgs, resolveConfig } from "./config.js";
import { startPiHost } from "./app.js";

/**
 * `pi-host [--data-dir <dir>] [--port <n>] [--pair] [--host-core <bin>] [--sidecar <entry>]`
 *
 * stdout carries exactly the lines a bootstrap script parses:
 *   PI_HOST_READY {"hostId":..,"port":..,"version":..}
 *   PI_HOST_PAIRING_TOKEN {"token":..,"expiresAt":..}   (with --pair)
 *   PI_HOST_WEB_READY {"host":..,"port":..}            (with --web)
 * Everything else is structured stderr.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write(
      [
        "pi-host — headless PI Agent Host (RACP-WS on loopback)",
        "",
        "  --data-dir <dir>          host data directory (default ~/.pi-desktop)",
        "  --port <n>                loopback port (default 0 = pick free)",
        "  --host <addr>             bind address; loopback only",
        "  --pair                    print a single-use pairing token at start",
        "  --pairing-lifetime-ms <n> pairing token lifetime (default 600000)",
        "  --host-core <path>        pi-desktop-host-core binary",
        "  --sidecar <path>          agent sidecar entry",
        "  --browse-root <dir>       folder-picker root (default home)",
        "  --log-level <level>       info | warn | error",
        "",
        "  --web                    serve the browser chat UI over HTTP",
        "  --web-host <addr>        web bind address (default 127.0.0.1)",
        "  --web-port <n>           web port (default 8080)",
        "  --web-root <dir>         web UI static assets (default: bundled dist-web)",
        "",
        "  The web channel authenticates with a cookie instead of a bearer header",
        "  because a browser WebSocket cannot set one. Reach it over Tailscale or",
        "  another private overlay, or put it behind a TLS reverse proxy.",
        "  --log-level <level>       info | warn | error",
        "",
      ].join("\n"),
    );
    return;
  }
  const config = resolveConfig(args);
  const app = await startPiHost(config);
  process.stdout.write(`PI_HOST_READY ${JSON.stringify({ hostId: app.hostId, host: app.address.host, port: app.address.port, version: (await import("@pi-desktop/shared")).APP_VERSION })}\n`);
  if (app.webAddress) {
    process.stdout.write(`PI_HOST_WEB_READY ${JSON.stringify(app.webAddress)}\n`);
  }
  if (config.pair) {
    const pairing = await app.issuePairingToken(config.pairingLifetimeMs);
    process.stdout.write(`PI_HOST_PAIRING_TOKEN ${JSON.stringify(pairing)}\n`);
  }
  const stop = (signal: string) => {
    app.log("info", "signal received", { signal });
    void app.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    app.log("error", "unhandled rejection", { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
  });
  process.on("uncaughtException", (error) => {
    app.log("error", "uncaught exception", { error: error.stack ?? error.message });
  });
}

main().catch((error) => {
  const code = (error as { errorCode?: string })?.errorCode ?? "INTERNAL";
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", channel: "pi-host", message: "pi-host failed to start", data: { code, error: error instanceof Error ? error.message : String(error) } })}\n`);
  process.stdout.write(`PI_HOST_FAILED ${JSON.stringify({ code })}\n`);
  process.exit(1);
});
