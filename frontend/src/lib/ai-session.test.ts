import { describe, expect, it, vi } from "vitest";
import { AiSession, AiSessionChangedError } from "./ai-session";

const first = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const second = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

describe("persisted chat for Live App", () => {
  it("shares one creation between the viewer, StrictMode replay, and a simultaneous message", async () => {
    let complete!: (id: string) => void;
    const create = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
    const session = new AiSession();
    const viewer = session.ensure(create), replay = session.ensure(create), message = session.ensure(create);
    expect(create).toHaveBeenCalledTimes(1);
    complete(first);
    expect(await Promise.all([viewer, replay, message])).toEqual([first, first, first]);
    expect(await session.ensure(create)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not replace a newly selected chat with a late creation response", async () => {
    let complete!: (id: string) => void;
    const session = new AiSession();
    const old = session.ensure(() => new Promise<string>(resolve => { complete = resolve; }));
    session.select(second);
    complete(first);
    await expect(old).rejects.toBeInstanceOf(AiSessionChangedError);
    expect(session.id).toBe(second);
    expect(await session.ensure(() => Promise.resolve(first))).toBe(second);
  });

  it("can retry creation failures instead of caching a rejected promise", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(first);
    const session = new AiSession();
    await expect(session.ensure(create)).rejects.toThrow("offline");
    expect(await session.ensure(create)).toBe(first);
  });

  it("restarts an in-flight empty chat when New Chat is clicked", async () => {
    let complete!: (id: string) => void;
    const session = new AiSession();
    const old = session.ensure(() => new Promise<string>(resolve => { complete = resolve; }));
    session.select("");
    const fresh = session.ensure(() => Promise.resolve(second));
    complete(first);
    await expect(old).rejects.toBeInstanceOf(AiSessionChangedError);
    expect(await fresh).toBe(second);
    expect(session.id).toBe(second);
  });

  it("rejects placeholder IDs and creates a separate browser chat after New Chat", async () => {
    const session = new AiSession();
    await expect(session.ensure(() => Promise.resolve("default"))).rejects.toThrow("valid chat ID");
    expect(await session.ensure(() => Promise.resolve(first))).toBe(first);
    session.select("");
    expect(await session.ensure(() => Promise.resolve(second))).toBe(second);
  });
});
