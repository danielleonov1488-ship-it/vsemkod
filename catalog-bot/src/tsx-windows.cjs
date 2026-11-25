// tsx использует имя пользователя для временных файлов. В ограниченных
// Windows-процессах libuv может вернуть ENOMEM при чтении учётной записи.
if (process.platform === "win32") {
  const os = require("node:os");
  const { createHash } = require("node:crypto");
  const { syncBuiltinESMExports } = require("node:module");
  try {
    os.userInfo();
  } catch (error) {
    if (error.info?.syscall !== "uv_os_get_passwd" || error.info?.code !== "ENOMEM") throw error;
    const home = os.homedir();
    const identity = createHash("sha256").update(home + "\n" + process.cwd()).digest("hex").slice(0, 16);
    os.userInfo = ({ encoding } = {}) => {
      const username = "vsemkod-" + identity;
      return {
        username: encoding === "buffer" ? Buffer.from(username) : username,
        homedir: encoding === "buffer" ? Buffer.from(home) : home,
        uid: -1, gid: -1, shell: null,
      };
    };
    syncBuiltinESMExports();
  }
}
