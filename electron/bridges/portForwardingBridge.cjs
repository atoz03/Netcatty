/**
 * Port Forwarding Bridge - Handles SSH port forwarding tunnels
 * Extracted from main.cjs for single responsibility
 */

const net = require("node:net");
require("./boringSslDhCompat.cjs").installBoringSslDhCompat();
const { Client: SSHClient } = require("ssh2");
const { NetcattyAgent } = require("./netcattyAgent.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const { connectThroughChain, buildAlgorithms } = require("./sshBridge.cjs");
const hostKeyVerifier = require("./hostKeyVerifier.cjs");
const { createProxySocket } = require("./proxyUtils.cjs");
const { 
  buildAuthHandler, 
  createKeyboardInteractiveHandler, 
  applyAuthToConnOpts,
  findAllDefaultPrivateKeys: findAllDefaultPrivateKeysFromHelper,
  preparePrivateKeyForAuth,
  loadFirstIdentityFileForAuth,
  isPassphraseCancelledError,
} = require("./sshAuthHelper.cjs");

// Active port forwarding tunnels
const portForwardingTunnels = new Map();
const portForwardOperationChains = new Map();

function cleanupChainConnections(connections) {
  if (!Array.isArray(connections)) return;
  for (const chainConn of connections) {
    try { chainConn.end(); } catch { /* ignore */ }
  }
}

function isTunnelCancelled(tunnelState) {
  return Boolean(tunnelState?.cancelled);
}

function getLocalPortOperationKey({ type, localPort }) {
  if ((type !== 'local' && type !== 'dynamic') || !localPort) return null;
  return `tcp:${localPort}`;
}

function getRemotePortOperationKey({ type, localPort, bindAddress, hostname, port }) {
  if (type !== 'remote' || !localPort || !hostname) return null;
  return `remote:${hostname}:${port || 22}:${bindAddress || '127.0.0.1'}:${localPort}`;
}

function getRuleOperationKey(ruleId) {
  return ruleId ? `rule:${ruleId}` : null;
}

function getTunnelLocalPortOperationKey(tunnel) {
  if (!tunnel) return null;
  return getLocalPortOperationKey(tunnel);
}

function compactOperationKeys(keys) {
  return Array.from(new Set(keys.filter(Boolean))).sort();
}

function getStartOperationKeys(payload) {
  const keys = [
    getRuleOperationKey(payload.ruleId),
    getLocalPortOperationKey(payload),
    getRemotePortOperationKey(payload),
  ];
  for (const tunnel of portForwardingTunnels.values()) {
    if (tunnel.ruleId === payload.ruleId) {
      keys.push(getTunnelLocalPortOperationKey(tunnel));
    }
  }
  return compactOperationKeys(keys);
}

function enqueuePortForwardOperation(keys, operation) {
  const operationKeys = compactOperationKeys(Array.isArray(keys) ? keys : [keys]);
  if (operationKeys.length === 0) {
    return operation();
  }

  const previous = Promise.all(
    operationKeys.map((key) => portForwardOperationChains.get(key) || Promise.resolve()),
  );
  const current = previous.catch(() => {}).then(operation);
  const tracked = current.catch(() => {}).finally(() => {
    for (const key of operationKeys) {
      if (portForwardOperationChains.get(key) === tracked) {
        portForwardOperationChains.delete(key);
      }
    }
  });
  for (const key of operationKeys) {
    portForwardOperationChains.set(key, tracked);
  }
  return current;
}

function createLocalPortInUseError({ localPort, bindAddress, tunnelId }) {
  const error = new Error(`Local port ${localPort} is already used by another Netcatty tunnel (${tunnelId})`);
  error.code = 'EADDRINUSE';
  error.address = bindAddress;
  error.port = localPort;
  return error;
}

function findConflictingLocalTunnel({ type, localPort, bindAddress, ruleId, tunnelId }) {
  if ((type !== 'local' && type !== 'dynamic') || !localPort) return null;
  for (const [existingTunnelId, tunnel] of portForwardingTunnels) {
    if (existingTunnelId === tunnelId || tunnel.cancelled) continue;
    if (tunnel.ruleId === ruleId) continue;
    if (tunnel.localPort === localPort && (tunnel.type === 'local' || tunnel.type === 'dynamic')) {
      return createLocalPortInUseError({ localPort, bindAddress, tunnelId: existingTunnelId });
    }
  }
  return null;
}

function closeTunnelServer(tunnel) {
  if (!tunnel?.server) return Promise.resolve();
  if (tunnel.serverClosePromise) return tunnel.serverClosePromise;

  // server.close() 只是开始关闭；必须等 close 回调/事件完成后，
  // 同一个本地端口才确定可以重新 bind。
  tunnel.serverClosePromise = new Promise((resolve) => {
    const server = tunnel.server;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      server.off?.('close', finish);
      resolve();
    };

    server.once('close', finish);
    try {
      server.close((err) => {
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
          console.warn('[PortForward] Failed while closing local listener:', err.message);
        }
        finish();
      });
    } catch (err) {
      if (err?.code !== 'ERR_SERVER_NOT_RUNNING') {
        console.warn('[PortForward] Failed to close local listener:', err?.message || err);
      }
      finish();
    }
  });

  return tunnel.serverClosePromise;
}

function destroyAcceptedSockets(tunnel) {
  if (!tunnel?.acceptedSockets) return;
  for (const socket of tunnel.acceptedSockets) {
    try { socket.destroy(); } catch { /* ignore */ }
  }
  tunnel.acceptedSockets.clear();
}

async function cancelTunnel(tunnelId, tunnel, sendStatus, { deleteEntry = false } = {}) {
  if (!tunnel) return;
  tunnel.cancelled = true;
  tunnel.status = 'inactive';
  const serverClosed = closeTunnelServer(tunnel);
  // 主动销毁已接收的连接，否则 server.close() 会等这些连接自然结束，
  // 本地端口在这段时间内仍可能保持占用。
  destroyAcceptedSockets(tunnel);
  if (tunnel.passphraseAbortController && !tunnel.passphraseAbortController.signal.aborted) {
    try { tunnel.passphraseAbortController.abort(); } catch { /* ignore */ }
  }
  if (tunnel.pendingConn) {
    try { tunnel.pendingConn.end(); } catch { /* ignore */ }
  }
  cleanupChainConnections(tunnel.chainConnections);
  if (tunnel.conn) {
    try { tunnel.conn.end(); } catch { /* ignore */ }
  }
  sendStatus?.('inactive');
  await serverClosed;
  if (deleteEntry) {
    portForwardingTunnels.delete(tunnelId);
  }
}

async function cancelExistingRuleTunnels(ruleId, nextTunnelId) {
  if (!ruleId) return;

  const staleTunnels = Array.from(portForwardingTunnels.entries())
    .filter(([tunnelId, tunnel]) => tunnelId !== nextTunnelId && tunnel.ruleId === ruleId);
  await Promise.all(staleTunnels.map(([tunnelId, tunnel]) =>
    cancelTunnel(tunnelId, tunnel, null, { deleteEntry: true })
  ));
}

function createLocalForwardServer({ conn, tunnelState, bindAddress, localPort, remoteHost, remotePort }) {
  return net.createServer((socket) => {
    if (tunnelState.status !== 'active') {
      socket.destroy();
      return;
    }

    tunnelState.acceptedSockets.add(socket);
    socket.on('close', () => tunnelState.acceptedSockets.delete(socket));
    conn.forwardOut(
      bindAddress,
      localPort,
      remoteHost,
      remotePort,
      (err, stream) => {
        if (err) {
          console.error(`[PortForward] Forward error:`, err.message);
          socket.end();
          return;
        }
        socket.pipe(stream).pipe(socket);

        socket.on('error', (e) => console.warn('[PortForward] Socket error:', e.message));
        stream.on('error', (e) => console.warn('[PortForward] Stream error:', e.message));
      }
    );
  });
}

function createDynamicForwardServer({ conn, tunnelState, bindAddress }) {
  return net.createServer((socket) => {
    if (tunnelState.status !== 'active') {
      socket.destroy();
      return;
    }

    tunnelState.acceptedSockets.add(socket);
    socket.on('close', () => tunnelState.acceptedSockets.delete(socket));
    // Simple SOCKS5 handshake
    socket.once('data', (data) => {
      if (data[0] !== 0x05) {
        socket.end();
        return;
      }

      // Reply: version, no auth required
      socket.write(Buffer.from([0x05, 0x00]));

      // Wait for connection request
      socket.once('data', (request) => {
        if (request[0] !== 0x05 || request[1] !== 0x01) {
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }

        let targetHost, targetPort;
        const addressType = request[3];

        if (addressType === 0x01) {
          // IPv4
          targetHost = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
          targetPort = request.readUInt16BE(8);
        } else if (addressType === 0x03) {
          // Domain name
          const domainLength = request[4];
          targetHost = request.slice(5, 5 + domainLength).toString();
          targetPort = request.readUInt16BE(5 + domainLength);
        } else if (addressType === 0x04) {
          // IPv6 - simplified handling
          socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        } else {
          socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }

        // Forward through SSH tunnel
        conn.forwardOut(
          bindAddress,
          0,
          targetHost,
          targetPort,
          (err, stream) => {
            if (err) {
              socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              socket.end();
              return;
            }

            // Success reply
            const reply = Buffer.alloc(10);
            reply[0] = 0x05;
            reply[1] = 0x00;
            reply[2] = 0x00;
            reply[3] = 0x01;
            reply.writeUInt16BE(0, 8);
            socket.write(reply);

            socket.pipe(stream).pipe(socket);

            socket.on('error', () => stream.end());
            stream.on('error', () => socket.end());
          }
        );
      });
    });
  });
}

function listenOnLocalServer(server, localPort, bindAddress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (err) => {
      if (settled) return;
      settled = true;
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      if (settled) return;
      settled = true;
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(localPort, bindAddress);
  });
}

async function reserveLocalListener({ type, conn, tunnelState, tunnelId, bindAddress, localPort, remoteHost, remotePort }) {
  const conflict = findConflictingLocalTunnel({ type, localPort, bindAddress, ruleId: tunnelState.ruleId, tunnelId });
  if (conflict) throw conflict;

  const server = type === 'local'
    ? createLocalForwardServer({ conn, tunnelState, bindAddress, localPort, remoteHost, remotePort })
    : createDynamicForwardServer({ conn, tunnelState, bindAddress });
  tunnelState.server = server;
  await listenOnLocalServer(server, localPort, bindAddress);
  return server;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function execRemoteText(conn, command, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let streamRef = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { streamRef?.close?.(); } catch { /* ignore */ }
      reject(new Error("Remote command timed out"));
    }, timeoutMs);

    conn.exec(`sh -lc ${shellQuote(command)}`, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        settled = true;
        reject(err);
        return;
      }
      streamRef = stream;
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code, signal });
      });
    });
  });
}

function parseRemoteReleaseOutput(output) {
  const result = {
    owners: [],
    staleSshdOwners: [],
    killed: [],
    killErrors: [],
    raw: output || "",
  };
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line) continue;
    const [kind, pidText, comm = "", ...argsParts] = line.split("\t");
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const owner = { pid, command: comm, args: argsParts.join("\t") };
    if (kind === "owner") result.owners.push(owner);
    if (kind === "stale") result.staleSshdOwners.push(owner);
    if (kind === "killed") result.killed.push(owner);
    if (kind === "kill_error") result.killErrors.push(owner);
  }
  return result;
}

function isLikelyRemoteBindConflictError(err) {
  const text = `${err?.code || ""} ${err?.message || err || ""}`;
  return /\bEADDRINUSE\b|address\s+already\s+in\s+use|already\s+in\s+use|unable\s+to\s+bind|bind\s+failed|listen\s+failed/i.test(text);
}

function buildRemoteReleaseScript({ localPort, bindAddress, kill }) {
  const killFlag = kill ? "1" : "0";
  return `
PORT=${shellQuote(localPort)}
BIND_ADDRESS=${shellQuote(bindAddress || "127.0.0.1")}
KILL=${shellQuote(killFlag)}
matches_bind_address() {
  local_addr="$1"
  host="\${local_addr%:$PORT}"
  host="\${host#[}"
  host="\${host%]}"
  case "$BIND_ADDRESS" in
    ""|"*"|"0.0.0.0"|"::")
      case "$host" in ""|"*"|"0.0.0.0"|"::") return 0 ;; esac
      ;;
    "localhost")
      case "$host" in "localhost"|"127.0.0.1"|"::1") return 0 ;; esac
      ;;
    *)
      [ "$host" = "$BIND_ADDRESS" ] && return 0
      ;;
  esac
  return 1
}
collect_candidates() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $2, $(NF - 1) }'
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltnp 2>/dev/null | awk -v port=":$PORT" '$4 ~ port "$" { line=$0; while (match(line, /pid=[0-9]+/)) { print substr(line, RSTART + 4, RLENGTH - 4), $4; line=substr(line, RSTART + RLENGTH) } }'
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | awk -v port=":$PORT" '$4 ~ port "$" && $7 ~ /^[0-9]+\\// { split($7, a, "/"); print a[1], $4 }'
  fi
}
pids="$(collect_candidates | while read -r pid addr; do
  if [ -n "$pid" ] && matches_bind_address "$addr"; then
    printf '%s\\n' "$pid"
  fi
done | sort -n | uniq)"
for pid in $pids; do
  comm="$(ps -p "$pid" -o comm= 2>/dev/null | awk '{$1=$1};1')"
  args="$(ps -p "$pid" -o args= 2>/dev/null | tr '\\n' ' ' | awk '{$1=$1};1')"
  case "$comm $args" in
    *sshd*|*dropbear*)
      printf 'stale\\t%s\\t%s\\t%s\\n' "$pid" "$comm" "$args"
      if [ "$KILL" = "1" ]; then
        if kill -TERM "$pid" 2>/dev/null; then
          printf 'killed\\t%s\\t%s\\t%s\\n' "$pid" "$comm" "$args"
        else
          printf 'kill_error\\t%s\\t%s\\t%s\\n' "$pid" "$comm" "$args"
        fi
      fi
      ;;
    *)
      printf 'owner\\t%s\\t%s\\t%s\\n' "$pid" "$comm" "$args"
      ;;
  esac
done
`.trim();
}

async function releaseRemoteForwardOwners(conn, { localPort, bindAddress, kill }) {
  const output = await execRemoteText(conn, buildRemoteReleaseScript({ localPort, bindAddress, kill }));
  return parseRemoteReleaseOutput(`${output.stdout}${output.stderr}`);
}

function forwardInAsync(conn, bindAddress, localPort) {
  return new Promise((resolve, reject) => {
    conn.forwardIn(bindAddress, localPort, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function openRemoteForwardWithOptionalCleanup(conn, { bindAddress, localPort, releaseStaleRemoteSshd }) {
  try {
    await forwardInAsync(conn, bindAddress, localPort);
    return null;
  } catch (err) {
    if (!releaseStaleRemoteSshd) throw err;
    if (!isLikelyRemoteBindConflictError(err)) throw err;
    const release = await releaseRemoteForwardOwners(conn, { localPort, bindAddress, kill: true });
    if (release.killed.length === 0) {
      err.remoteRelease = release;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await forwardInAsync(conn, bindAddress, localPort);
      return release;
    } catch (retryErr) {
      retryErr.remoteRelease = release;
      throw retryErr;
    }
  }
}

const { safeSend } = require("./ipcUtils.cjs");

/**
 * Start a port forwarding tunnel
 */
async function startPortForward(event, payload) {
  return enqueuePortForwardOperation(getStartOperationKeys(payload), async () => {
    await cancelExistingRuleTunnels(payload.ruleId, payload.tunnelId);
    return startPortForwardLocked(event, payload);
  });
}

async function startPortForwardLocked(event, payload) {
  const {
    ruleId,
    tunnelId,
    type, // 'local' | 'remote' | 'dynamic'
    localPort,
    bindAddress = '127.0.0.1',
    remoteHost,
    remotePort,
    hostname,
    port = 22,
    username,
    password,
    privateKey,
    certificate,
    keyId,
    passphrase,
    knownHosts,
    verifyHostKeys,
    proxy,
    jumpHosts = [],
    identityFilePaths,
    legacyAlgorithms,
    skipEcdsaHostKey,
    algorithmOverrides,
    keepaliveInterval: resolvedKeepaliveInterval,
    keepaliveCountMax: resolvedKeepaliveCountMax,
    releaseStaleRemoteSshd = false,
  } = payload;

  const conn = new SSHClient();
  const sender = event.sender;
  const hasJumpHosts = jumpHosts.length > 0;
  const hasProxy = !!proxy;
  let chainConnections = [];
  let connectionSocket = null;
  const passphraseAbortController = new AbortController();
  const tunnelState = {
    type,
    conn,
    localPort,
    bindAddress,
    pendingConn: null,
    server: null,
    // Track every socket accepted by the local listener so cancelTunnel can
    // force-destroy them. net.Server.close() only stops new connections —
    // existing ones stay open and hold the listening port, so on Cmd+Q the
    // port was not released and the next launch hit EADDRINUSE.
    acceptedSockets: new Set(),
    chainConnections,
    passphraseAbortController,
    ruleId,
    status: 'connecting',
    webContentsId: sender.id,
    cancelled: false,
  };

  const sendStatus = (status, error = null) => {
    if (!sender.isDestroyed()) {
      sender.send("netcatty:portforward:status", { tunnelId, status, error });
    }
  };

  // Keepalive policy:
  //   - positive value: honor it
  //   - explicit 0: truly disabled (host opted out via per-host override —
  //     a router/switch that doesn't reply to keepalive@openssh.com would
  //     otherwise be killed by ssh2 after countMax unanswered probes)
  //   - undefined: legacy caller path, fall back to 10s/3 so an idle
  //     forwarded TCP tunnel doesn't get dropped by NAT state tables.
  const tunnelKeepaliveMs = resolvedKeepaliveInterval == null
    ? 10000
    : (resolvedKeepaliveInterval > 0 ? resolvedKeepaliveInterval * 1000 : 0);
  const tunnelKeepaliveCountMax = resolvedKeepaliveInterval == null
    ? 3
    : (resolvedKeepaliveInterval > 0 ? (resolvedKeepaliveCountMax ?? 3) : 0);
  const connectOpts = {
    host: hostname,
    port: port,
    username: username || 'root',
    readyTimeout: 120000, // 2 minutes for 2FA input
    keepaliveInterval: tunnelKeepaliveMs,
    keepaliveCountMax: tunnelKeepaliveCountMax,
    // Enable keyboard-interactive authentication (required for 2FA/MFA)
    tryKeyboard: true,
    algorithms: buildAlgorithms(legacyAlgorithms, { skipEcdsaHostKey, algorithmOverrides }),
  };
  connectOpts.hostVerifier = hostKeyVerifier.createHostVerifier({
    sender,
    sessionId: tunnelId,
    hostname,
    port,
    knownHosts,
    verifyHostKeys,
  });

  const hasCertificate = typeof certificate === "string" && certificate.trim().length > 0;
  sendStatus('connecting');
  portForwardingTunnels.set(tunnelId, tunnelState);

  let defaultKeys = [];
  try {
    const identityFile = !privateKey
      ? await loadFirstIdentityFileForAuth({
        sender,
        identityFilePaths,
        hostname,
        initialPassphrase: passphrase,
        passphraseSignal: passphraseAbortController.signal,
        logPrefix: "[PortForward]",
        onError: (err, keyPath) => {
          console.warn(`[PortForward] Failed to read identity file ${keyPath}:`, err.message);
        },
      })
      : null;
    const inlineKey = privateKey
      ? await preparePrivateKeyForAuth({
        sender,
        privateKey,
        keyId,
        keyName: keyId || username,
        hostname,
        initialPassphrase: passphrase,
        passphraseSignal: passphraseAbortController.signal,
        logPrefix: "[PortForward]",
      })
      : null;
    const effectivePrivateKey = inlineKey?.privateKey || identityFile?.privateKey;
    const effectivePassphrase = inlineKey?.passphrase || identityFile?.passphrase;

    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      return { tunnelId, success: false, cancelled: true };
    }

    if (hasCertificate) {
      connectOpts.agent = new NetcattyAgent({
        mode: "certificate",
        webContents: sender,
        meta: {
          label: keyId || username || "",
          certificate,
          privateKey: effectivePrivateKey,
          passphrase: effectivePassphrase,
        },
      });
    } else if (effectivePrivateKey) {
      connectOpts.privateKey = effectivePrivateKey;
      if (effectivePassphrase) {
        connectOpts.passphrase = effectivePassphrase;
      }
    }
    if (password) {
      connectOpts.password = password;
    }

    // Get default keys
    defaultKeys = await findAllDefaultPrivateKeysFromHelper();
    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      return { tunnelId, success: false, cancelled: true };
    }

    // Build auth handler using shared helper
    const authConfig = buildAuthHandler({
      privateKey: connectOpts.privateKey,
      password,
      passphrase: connectOpts.passphrase,
      agent: connectOpts.agent,
      username: connectOpts.username,
      logPrefix: "[PortForward]",
      defaultKeys,
    });
    applyAuthToConnOpts(connectOpts, authConfig);
    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      return { tunnelId, success: false, cancelled: true };
    }

    if (hasJumpHosts) {
      const chainResult = await connectThroughChain(
        event,
        {
          hostname,
          port,
          username,
          password,
          privateKey,
          passphrase,
          proxy,
          knownHosts,
          verifyHostKeys,
          jumpHosts,
          legacyAlgorithms,
          skipEcdsaHostKey,
          algorithmOverrides,
          _defaultKeys: defaultKeys,
          _connectionsRef: chainConnections,
          _tunnelRef: tunnelState,
          _passphraseSignal: passphraseAbortController.signal,
          _keyboardInteractiveScope: "external",
        },
        jumpHosts,
        hostname,
        port,
        tunnelId,
      );
      connectionSocket = chainResult.socket;
      chainConnections = chainResult.connections;
      tunnelState.chainConnections = chainConnections;
      if (isTunnelCancelled(tunnelState)) {
        cleanupChainConnections(chainConnections);
        portForwardingTunnels.delete(tunnelId);
        return { tunnelId, success: false, cancelled: true };
      }
      connectOpts.sock = connectionSocket;
      delete connectOpts.host;
      delete connectOpts.port;
    } else if (hasProxy) {
      connectionSocket = await createProxySocket(proxy, hostname, port, {
        onSocket: (socket) => {
          tunnelState.pendingConn = socket;
        },
      });
      if (isTunnelCancelled(tunnelState)) {
        try { connectionSocket?.end?.(); } catch { /* ignore */ }
        try { connectionSocket?.destroy?.(); } catch { /* ignore */ }
        portForwardingTunnels.delete(tunnelId);
        return { tunnelId, success: false, cancelled: true };
      }
      tunnelState.pendingConn = null;
      connectOpts.sock = connectionSocket;
      delete connectOpts.host;
      delete connectOpts.port;
    }
  } catch (err) {
    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      return { tunnelId, success: false, cancelled: true };
    }
    if (isPassphraseCancelledError(err)) {
      await cancelTunnel(tunnelId, tunnelState, sendStatus, { deleteEntry: true });
      return { tunnelId, success: false, cancelled: true };
    }
    tunnelState.cancelled = true;
    if (connectionSocket) {
      try { connectionSocket.end?.(); } catch { /* ignore */ }
      try { connectionSocket.destroy?.(); } catch { /* ignore */ }
    }
    await cancelTunnel(tunnelId, tunnelState, null, { deleteEntry: true });
    sendStatus('error', err?.message || String(err));
    throw err;
  }

  // Handle keyboard-interactive authentication (2FA/MFA)
  conn.on("keyboard-interactive", createKeyboardInteractiveHandler({
    sender,
    sessionId: tunnelId,
    hostname,
    password,
    logPrefix: "[PortForward]",
    scope: "external",
  }));

  return new Promise((resolve, reject) => {
    // Track whether the Promise has been settled so conn.on('close')
    // can reject if the tunnel was killed during SSH handshake.
    let settled = false;

    conn.once('ready', async () => {
      console.log(`[PortForward] SSH connection ready for tunnel ${tunnelId}`);

      if (type === 'local') {
        try {
          await reserveLocalListener({
            type,
            conn,
            tunnelState,
            tunnelId,
            bindAddress,
            localPort,
            remoteHost,
            remotePort,
          });
          console.log(`[PortForward] Local forwarding active: ${bindAddress}:${localPort} -> ${remoteHost}:${remotePort}`);
          tunnelState.type = 'local';
          tunnelState.conn = conn;
          tunnelState.chainConnections = chainConnections;
          tunnelState.status = 'active';
          tunnelState.webContentsId = sender.id;
          tunnelState.pendingConn = null;
          portForwardingTunnels.set(tunnelId, tunnelState);
          sendStatus('active');
          settled = true;
          resolve({ tunnelId, success: true });
        } catch (err) {
          sendStatus('error', err?.message || String(err));
          conn.end();
          settled = true;
          reject(err);
        }

      } else if (type === 'remote') {
        try {
          // REMOTE FORWARDING: Listen on remote port, forward to local.
          // 如果上一次异常退出留下远端 sshd 监听，只在显式确认后尝试结束该 sshd 子进程并重试。
          const remoteRelease = await openRemoteForwardWithOptionalCleanup(conn, {
            bindAddress,
            localPort,
            releaseStaleRemoteSshd,
          });
          console.log(`[PortForward] Remote forwarding active: remote ${bindAddress}:${localPort} -> local ${remoteHost}:${remotePort}`);
          tunnelState.type = 'remote';
          tunnelState.conn = conn;
          tunnelState.server = null;
          tunnelState.chainConnections = chainConnections;
          tunnelState.status = 'active';
          tunnelState.webContentsId = sender.id;
          tunnelState.pendingConn = null;
          portForwardingTunnels.set(tunnelId, tunnelState);
          sendStatus('active');
          settled = true;
          resolve({ tunnelId, success: true, remoteRelease });
        } catch (err) {
          console.error(`[PortForward] Remote forward error:`, err.message);
          sendStatus('error', err.message);
          conn.end();
          settled = true;
          reject(err);
          return;
        }

        // Handle incoming connections from remote
        conn.on('tcp connection', (info, accept, rejectConn) => {
          const stream = accept();
          const socket = net.connect(remotePort, remoteHost || '127.0.0.1', () => {
            stream.pipe(socket).pipe(stream);
          });

          socket.on('error', (e) => {
            console.warn('[PortForward] Local socket error:', e.message);
            stream.end();
          });
          stream.on('error', (e) => {
            console.warn('[PortForward] Remote stream error:', e.message);
            socket.end();
          });
        });

      } else if (type === 'dynamic') {
        try {
          await reserveLocalListener({
            type,
            conn,
            tunnelState,
            tunnelId,
            bindAddress,
            localPort,
            remoteHost,
            remotePort,
          });
          console.log(`[PortForward] Dynamic SOCKS5 proxy active on ${bindAddress}:${localPort}`);
          tunnelState.type = 'dynamic';
          tunnelState.conn = conn;
          tunnelState.chainConnections = chainConnections;
          tunnelState.status = 'active';
          tunnelState.webContentsId = sender.id;
          tunnelState.pendingConn = null;
          portForwardingTunnels.set(tunnelId, tunnelState);
          sendStatus('active');
          settled = true;
          resolve({ tunnelId, success: true });
        } catch (err) {
          sendStatus('error', err?.message || String(err));
          conn.end();
          settled = true;
          reject(err);
        }
      } else {
        settled = true;
        reject(new Error(`Unknown forwarding type: ${type}`));
      }
    });

    conn.on('error', (err) => {
      console.error(`[PortForward] SSH error:`, err.message);
      if (settled) return;
      sendStatus('error', err.message);
      settled = true;
      cancelTunnel(tunnelId, tunnelState, null, { deleteEntry: true })
        .finally(() => reject(err));
    });

    conn.once('close', async () => {
      console.log(`[PortForward] SSH connection closed for tunnel ${tunnelId}`);
      const tunnel = portForwardingTunnels.get(tunnelId) || tunnelState;
      // Capture the cancelled flag BEFORE cleanup deletes the entry.
      const wasCancelled = !!tunnel?.cancelled;
      if (tunnel) {
        const serverClosed = closeTunnelServer(tunnel);
        destroyAcceptedSockets(tunnel);
        await serverClosed;
        if (Array.isArray(tunnel.chainConnections)) {
          cleanupChainConnections(tunnel.chainConnections);
        }
        if (tunnel.pendingConn) {
          try { tunnel.pendingConn.end(); } catch { /* ignore */ }
        }
        sendStatus('inactive');
        portForwardingTunnels.delete(tunnelId);
      }
      // If the Promise was never settled (tunnel killed during
      // handshake by stopPortForwardByRuleId), settle it.
      if (!settled) {
        settled = true;
        if (wasCancelled) {
          resolve({ tunnelId, success: false, cancelled: true });
        } else {
          reject(new Error(`Tunnel ${tunnelId} closed before connection established`));
        }
      }
    });

    conn.connect(connectOpts);
  });
}

/**
 * Stop a port forwarding tunnel
 */
async function stopPortForward(event, payload) {
  const { tunnelId } = payload;
  const tunnel = portForwardingTunnels.get(tunnelId);

  if (!tunnel) {
    return { tunnelId, success: false, error: 'Tunnel not found' };
  }

  try {
    await cancelTunnel(tunnelId, tunnel, null, { deleteEntry: true });
    if (!event.sender.isDestroyed()) {
      event.sender.send("netcatty:portforward:status", { tunnelId, status: 'inactive', error: null });
    }
    return { tunnelId, success: true };
  } catch (err) {
    return { tunnelId, success: false, error: err.message };
  }
}

/**
 * Get status of a tunnel
 */
async function getPortForwardStatus(event, payload) {
  const { tunnelId } = payload;
  const tunnel = portForwardingTunnels.get(tunnelId);

  if (!tunnel) {
    return { tunnelId, status: 'inactive' };
  }

  return { tunnelId, status: tunnel.status || 'active', type: tunnel.type };
}

/**
 * List all active port forwards
 */
async function listPortForwards() {
  const list = [];
  for (const [tunnelId, tunnel] of portForwardingTunnels) {
    list.push({
      tunnelId,
      type: tunnel.type,
      status: tunnel.status || 'active',
    });
  }
  return list;
}

/**
 * Stop all active port forwards (cleanup on app quit)
 */
async function stopAllPortForwards() {
  console.log(`[PortForward] Stopping all ${portForwardingTunnels.size} active tunnels...`);
  const stops = [];
  for (const [tunnelId, tunnel] of portForwardingTunnels) {
      try {
        stops.push(cancelTunnel(tunnelId, tunnel, null, { deleteEntry: true }));
        console.log(`[PortForward] Stopped tunnel ${tunnelId}`);
    } catch (err) {
      console.warn(`[PortForward] Failed to stop tunnel ${tunnelId}:`, err.message);
    }
  }
  await Promise.all(stops);
  console.log('[PortForward] All tunnels stopped');
}

/**
 * Stop all active port forwards for a given rule ID.
 * This catches tunnels in ANY state (connecting, active) because it
 * operates on the main-process portForwardingTunnels map directly.
 */
async function stopPortForwardByRuleId(_event, { ruleId }) {
  let stopped = 0;
  const stops = [];
  for (const [tunnelId, tunnel] of portForwardingTunnels) {
    if (tunnel.ruleId === ruleId) {
      try {
        stops.push(cancelTunnel(tunnelId, tunnel, null, { deleteEntry: true }));
        console.log(`[PortForward] Stopped tunnel ${tunnelId} for rule ${ruleId}`);
        stopped++;
      } catch (err) {
        console.warn(`[PortForward] Failed to stop tunnel ${tunnelId}:`, err.message);
      }
    }
  }
  await Promise.all(stops);
  return { stopped };
}

/**
 * Register IPC handlers for port forwarding operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:portforward:start", startPortForward);
  ipcMain.handle("netcatty:portforward:stop", stopPortForward);
  ipcMain.handle("netcatty:portforward:status", getPortForwardStatus);
  ipcMain.handle("netcatty:portforward:list", listPortForwards);
  ipcMain.handle("netcatty:portforward:stopAll", () => stopAllPortForwards());
  ipcMain.handle("netcatty:portforward:stopByRuleId", stopPortForwardByRuleId);
}

module.exports = {
  registerHandlers,
  startPortForward,
  stopPortForward,
  getPortForwardStatus,
  listPortForwards,
  stopAllPortForwards,
  stopPortForwardByRuleId,
};
