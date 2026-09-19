import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PiHostConfig = {
  dataDir: string;
  /** Loopback bind address; `pi-host` refuses anything else. */
  host: string;
  /** `0` picks a free port and prints it. */
  port: number;
  hostCoreBinary: string;
  sidecarEntry: string;
  /** The Node executable used for the sidecar; defaults to this process's. */
  nodeBinary: string;
  /** Print a fresh single-use pairing token at start and exit once it is consumed or expired. */
  pair: boolean;
  pairingLifetimeMs: number;
  /** Where the folder picker may browse; defaults to the user's home. */
  browseRoot: string;

  /**
   * Serve the browser chat UI over HTTP. Off by default: without this flag
   * pi-host behaves exactly as before and opens no network listener. The web
   * channel authenticates with a cookie instead of a bearer header because a
   * browser `WebSocket` cannot set one.
   */
  web: boolean;
  webHost: string;
  webPort: number;
  /** Static assets for the web UI; resolved against the bundle when omitted. */
  webRoot: string | null;
  logLevel: "info" | "warn" | "error";
  /** Non-fatal configuration advisories the host logs once at startup. */
  warnings: string[];
};

const DEFAULT_PORT = 0;
const DEFAULT_PAIRING_LIFETIME_MS = 10 * 60 * 1000;
/**
 * Web UI port. Deliberately distinct from the loopback RACP-WS port so both
 * channels can run at once; the web channel is the one a browser reaches.
 */
const DEFAULT_WEB_PORT = 8080;
const DEFAULT_WEB_HOST = "127.0.0.1";

/** Where a bundle or a source checkout keeps the built web UI, first hit wins. */
export function webRootCandidates(root = here()): string[] {
  return [
    process.env.PI_HOST_WEB_ROOT ?? "",
    join(root, "dist-web"),
    join(root, "../dist-web"),
    join(root, "../../../apps/web/dist"),
  ].filter(Boolean);
}

function firstExistingDirectory(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(resolve(candidate))) return resolve(candidate);
  }
  return null;
}

function here(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Locations the bundle and a source checkout keep host-core in, first hit wins. */
export function hostCoreCandidates(root = here()): string[] {
  const exe = process.platform === "win32" ? ".exe" : "";
  return [
    process.env.PI_HOST_CORE_BIN ?? "",
    process.env.PI_DESKTOP_HOST_BIN ?? "",
    join(root, `bin/pi-desktop-host-core${exe}`),
    join(root, `../bin/pi-desktop-host-core${exe}`),
    join(root, `../../../target/release/pi-desktop-host-core${exe}`),
    join(root, `../../../target/debug/pi-desktop-host-core${exe}`),
  ].filter(Boolean);
}

export function sidecarCandidates(root = here()): string[] {
  return [
    process.env.PI_HOST_SIDECAR ?? "",
    join(root, "agent-runtime/sidecar.js"),
    join(root, "../agent-runtime/sidecar.js"),
    join(root, "../../../packages/agent-runtime/dist-bundle/sidecar.js"),
    join(root, "../../../packages/agent-runtime/dist/sidecar.js"),
  ].filter(Boolean);
}

function firstExisting(candidates: string[], what: string): string {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return resolve(candidate);
  }
  throw Object.assign(new Error(`${what} not found; tried ${candidates.join(", ")}`), { errorCode: "HOST_BOOTSTRAP_FAILED" });
}

export type CliArgs = Record<string, string | boolean>;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[arg.slice(2)] = next;
      index += 1;
    } else {
      args[arg.slice(2)] = true;
    }
  }
  return args;
}

export function resolveConfig(args: CliArgs, env: NodeJS.ProcessEnv = process.env): PiHostConfig {
  const dataDir = resolve(String(args["data-dir"] ?? env.PI_DESKTOP_DATA_DIR ?? join(homedir(), ".pi-desktop")));
  const port = Number(args.port ?? env.PI_HOST_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw Object.assign(new Error(`invalid port ${String(args.port ?? env.PI_HOST_PORT)}`), { errorCode: "INVALID_ARGUMENT" });
  }
  const level = String(args["log-level"] ?? env.PI_HOST_LOG_LEVEL ?? "info");
  const web = args.web === true || args.web === "true" || env.PI_HOST_WEB === "true";
  const webPort = Number(args["web-port"] ?? env.PI_HOST_WEB_PORT ?? DEFAULT_WEB_PORT);
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) {
    throw Object.assign(new Error(`invalid web port ${String(args["web-port"] ?? env.PI_HOST_WEB_PORT)}`), { errorCode: "INVALID_ARGUMENT" });
  }
  const webHost = String(args["web-host"] ?? env.PI_HOST_WEB_HOST ?? DEFAULT_WEB_HOST);
  const webRootArg = args["web-root"] ?? env.PI_HOST_WEB_ROOT;
  const webRoot = webRootArg ? resolve(String(webRootArg)) : firstExistingDirectory(webRootCandidates());
  // Warnings surface through app.ts, which owns the logger; resolveConfig stays
  // pure so it stays testable and free of I/O side effects.
  const warnings: string[] = [];
  if (web && !webRoot) warnings.push("web mode has no static assets; the API is reachable but / will 404");
  if (web && webHost !== "127.0.0.1" && webHost !== "localhost" && webHost !== "::1") {
    warnings.push(`web mode binds the non-loopback address ${webHost}; put it behind TLS or a private overlay network`);
  }
  return {
    dataDir,
    host: String(args.host ?? env.PI_HOST_BIND ?? "127.0.0.1"),
    port,
    hostCoreBinary: args["host-core"] ? resolve(String(args["host-core"])) : firstExisting(hostCoreCandidates(), "host-core binary"),
    sidecarEntry: args.sidecar ? resolve(String(args.sidecar)) : firstExisting(sidecarCandidates(), "agent sidecar entry"),
    nodeBinary: String(args.node ?? env.PI_HOST_NODE ?? process.execPath),
    pair: args.pair === true || args.pair === "true",
    pairingLifetimeMs: Number(args["pairing-lifetime-ms"] ?? DEFAULT_PAIRING_LIFETIME_MS),
    browseRoot: resolve(String(args["browse-root"] ?? env.PI_HOST_BROWSE_ROOT ?? homedir())),
    logLevel: level === "warn" || level === "error" ? level : "info",
    web,
    webHost,
    webPort,
    webRoot,
    warnings,
  };
}
