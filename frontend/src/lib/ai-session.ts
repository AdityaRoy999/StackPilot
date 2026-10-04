export class AiSessionChangedError extends Error {
  constructor() { super("The active chat changed while it was being created."); }
}

/** Keep the viewer and message stream on the same persisted chat. */
export class AiSession {
  id = "";
  private generation = 0;
  private pending: Promise<string> | null = null;

  select(id: string) {
    this.generation++;
    this.id = id;
    this.pending = null;
  }

  ensure(create: () => Promise<string>): Promise<string> {
    if (this.id) return Promise.resolve(this.id);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = create().then(id => {
      if (generation !== this.generation) throw new AiSessionChangedError();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error("The server did not return a valid chat ID.");
      }
      this.id = id;
      return id;
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
}
