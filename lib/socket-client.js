const net = require("net");

function createSocketClient(sockPath, timeoutMs) {
  return function socketRequest(request) {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(sockPath);
      let buffer = "";
      const timer = setTimeout(() => {
        conn.destroy();
        reject(new Error("TIMEOUT"));
      }, timeoutMs);

      conn.on("connect", () => {
        conn.write(JSON.stringify(request) + "\n");
      });

      conn.on("data", (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          clearTimeout(timer);
          const line = buffer.slice(0, newlineIndex);
          try {
            const response = JSON.parse(line);
            if (response.ok) {
              resolve(response.data);
            } else {
              reject(new Error(response.error || "unknown error"));
            }
          } catch (e) {
            reject(new Error(`response parse error: ${e.message}`));
          }
          conn.end();
        }
      });

      conn.on("error", (e) => {
        clearTimeout(timer);
        conn.destroy();
        reject(e);
      });
    });
  };
}

module.exports = { createSocketClient };
