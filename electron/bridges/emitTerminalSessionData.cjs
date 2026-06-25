"use strict";

function emitTerminalSessionData(contents, sessionId, data) {
  contents?.send("netcatty:data", { sessionId, data });
}

module.exports = {
  emitTerminalSessionData,
};
