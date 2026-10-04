import { afterEach, expect, it } from "vitest";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import api from "./api";

afterEach(() => localStorage.clear());

it("does not let a delayed unauthorized response erase a newly paired device", async () => {
  localStorage.setItem("stackpilot_remote_device", "sp_remote_revoked");
  let fail!: () => void;
  let signal!: () => void;
  const dispatched = new Promise<void>(resolve => { signal = resolve; });
  const pending = api.get("/projects", { adapter: config => new Promise((_resolve, reject) => {
    expect(config.baseURL).toBe("/api/v1");
    expect(config.headers.Authorization).toBe("Bearer sp_remote_revoked");
    fail = () => reject(new AxiosError("Device revoked", "ERR_BAD_REQUEST", config, undefined, {
      status: 401, statusText: "Unauthorized", data: {}, headers: {}, config: config as InternalAxiosRequestConfig,
    }));
    signal();
  }) });
  const failed = expect(pending).rejects.toMatchObject({ response: { status: 401 } });
  await dispatched;
  localStorage.setItem("stackpilot_remote_device", "sp_remote_newly_approved");
  fail();
  await failed;
  expect(localStorage.getItem("stackpilot_remote_device")).toBe("sp_remote_newly_approved");
});
