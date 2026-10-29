export function resolveGatewayPort(argv = process.argv, env = process.env): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    if (arg.startsWith('--port=')) {
      const parsed = parseInt(arg.slice('--port='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  if ((env.NODE_ENV === 'production' || Boolean(env.K_SERVICE)) && env.PORT) {
    const parsed = parseInt(env.PORT, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (env.PORT && env.PORT !== '8080') {
    const parsed = parseInt(env.PORT, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 3000;
}
