export function installShutdown(close: () => Promise<void>): void {
  let closing = false;
  const run = (): void => {
    if (closing) return;
    closing = true;
    close()
      .catch(() => undefined)
      .finally(() => {
        process.exit(0);
      });
  };
  process.once('SIGINT', run);
  process.once('SIGTERM', run);
}
