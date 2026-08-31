console.log("node version:", process.version);
try {
  const m = await import("undici");
  console.log("undici bare import OK, ProxyAgent:", typeof m.ProxyAgent, "setGlobalDispatcher:", typeof m.setGlobalDispatcher);
} catch (e) {
  console.log("undici bare import failed:", e.message);
}
console.log("NODE_USE_ENV_PROXY support check: fetch is", typeof fetch);
