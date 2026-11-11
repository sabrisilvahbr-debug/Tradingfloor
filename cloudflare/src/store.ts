// Memória persistente sobre o banco SQLite do Durable Object.
// Mesma ideia do `Store` do backend em Python: append / put / get / list.
//
// Cada coleção guarda um número máximo de registros (os mais antigos são apagados
// periodicamente) para respeitar o limite de armazenamento do plano gratuito.
// `tag` separa registros de um mesmo grupo (ex.: ordens de uma carteira virtual).

type Doc = Record<string, unknown>;
type Row = Record<string, SqlStorageValue>;

/** Quantos registros recentes ficam em memória por coleção (as listas da tela leem daqui). */
const CACHE_SIZE = 100;

export const RETENTION: Record<string, number> = {
  events: 5000,
  meetings: 2000,
  signals: 3000,
  orders: 5000,
  trades: 20000,
  reports: 200,
  strategy_proposals: 100,
};

export class SqlStore {
  readonly persistent = true;
  private readonly cache = new Map<string, Doc[]>();
  /** Coleções cujo cache já foi carregado do banco. */
  private readonly loaded = new Set<string>();

  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      key TEXT,
      tag TEXT,
      doc TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS records_by_collection ON records (collection, id)");
    sql.exec("CREATE INDEX IF NOT EXISTS records_by_tag ON records (collection, tag, id)");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS records_by_key ON records (collection, key) WHERE key IS NOT NULL");
  }

  append(collection: string, doc: Doc, tag: string | null = null): void {
    const text = JSON.stringify(doc);
    this.sql.exec(
      "INSERT INTO records (collection, tag, doc, created_at) VALUES (?, ?, ?, ?)",
      collection,
      tag,
      text,
      Date.now() / 1000,
    );
    if (this.loaded.has(collection)) {
      const rows = this.cache.get(collection) ?? [];
      rows.unshift(JSON.parse(text) as Doc);
      if (rows.length > CACHE_SIZE) rows.length = CACHE_SIZE;
      this.cache.set(collection, rows);
    }
  }

  put(collection: string, key: string, doc: Doc): void {
    const now = Date.now() / 1000;
    this.sql.exec(
      `INSERT INTO records (collection, key, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (collection, key) WHERE key IS NOT NULL DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
      collection,
      key,
      JSON.stringify(doc),
      now,
      now,
    );
  }

  get<T = Doc>(collection: string, key: string): T | null {
    const rows = this.sql.exec<{ doc: string }>("SELECT doc FROM records WHERE collection = ? AND key = ?", collection, key).toArray();
    return rows.length ? (JSON.parse(rows[0].doc) as T) : null;
  }

  /** Registros mais recentes primeiro. */
  list(collection: string, limit = 100): Doc[] {
    if (limit <= CACHE_SIZE) {
      if (!this.loaded.has(collection)) {
        this.cache.set(collection, this.query(collection, null, CACHE_SIZE));
        this.loaded.add(collection);
      }
      return (this.cache.get(collection) ?? []).slice(0, limit);
    }
    return this.query(collection, null, limit);
  }

  /** Registros de um grupo (`tag`), mais recentes primeiro. */
  listTagged(collection: string, tag: string, limit: number): Doc[] {
    return this.query(collection, tag, limit);
  }

  /** Alguns campos de cada registro (mais recentes primeiro), sem carregar o documento inteiro. */
  pluck<T extends Row>(collection: string, fields: Record<string, string>, options: { tag?: string; limit?: number } = {}): T[] {
    const columns = Object.entries(fields)
      .map(([name, path]) => `json_extract(doc, '${path.replaceAll("'", "''")}') AS "${name}"`)
      .join(", ");
    const limit = options.limit ?? 1_000_000;
    if (options.tag !== undefined) {
      return this.sql
        .exec<T>(
          `SELECT ${columns} FROM records WHERE collection = ? AND tag = ? AND key IS NULL ORDER BY id DESC LIMIT ?`,
          collection,
          options.tag,
          limit,
        )
        .toArray();
    }
    return this.sql
      .exec<T>(`SELECT ${columns} FROM records WHERE collection = ? AND key IS NULL ORDER BY id DESC LIMIT ?`, collection, limit)
      .toArray();
  }

  /** Apaga os registros mais antigos de cada coleção além do limite de retenção. */
  prune(): number {
    let removed = 0;
    for (const [collection, keep] of Object.entries(RETENTION)) {
      const cutoff = this.sql
        .exec<{ id: number }>(
          "SELECT id FROM records WHERE collection = ? AND key IS NULL ORDER BY id DESC LIMIT 1 OFFSET ?",
          collection,
          keep,
        )
        .toArray();
      if (!cutoff.length) continue;
      const cursor = this.sql.exec("DELETE FROM records WHERE collection = ? AND key IS NULL AND id <= ?", collection, cutoff[0].id);
      removed += cursor.rowsWritten;
    }
    return removed;
  }

  private query(collection: string, tag: string | null, limit: number): Doc[] {
    const cursor =
      tag === null
        ? this.sql.exec<{ doc: string }>(
            "SELECT doc FROM records WHERE collection = ? AND key IS NULL ORDER BY id DESC LIMIT ?",
            collection,
            limit,
          )
        : this.sql.exec<{ doc: string }>(
            "SELECT doc FROM records WHERE collection = ? AND tag = ? AND key IS NULL ORDER BY id DESC LIMIT ?",
            collection,
            tag,
            limit,
          );
    return cursor.toArray().map((r) => JSON.parse(r.doc) as Doc);
  }
}
