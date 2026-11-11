// Identificadores e relógio.

/** Equivale a `uuid.uuid4().hex`. */
export function hexId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** Segundos desde 1970, como `time.time()`. */
export function nowSeconds(): number {
  return Date.now() / 1000;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function utcDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
