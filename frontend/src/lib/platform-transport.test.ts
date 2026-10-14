import { describe, expect, it } from "vitest";
import { apiTransportBase, socketTransportBase } from "./platform-transport";

describe("installation transports", () => {
  it("works from a LAN phone without addressing the phone's own loopback", () => {
    expect(apiTransportBase("http://localhost:8090/api/v1", "http://192.168.1.50:3000")).toBe("/api/v1");
    expect(socketTransportBase("ws://localhost:8090", "https://pilot.example")).toBe("wss://pilot.example");
    expect(socketTransportBase(undefined, "http://192.168.1.50:3000")).toBe("ws://192.168.1.50:3000");
  });
  it("preserves intentional service hosts and local development overrides", () => {
    expect(apiTransportBase("https://api.pilot.example/api/v1/", "https://pilot.example")).toBe("https://api.pilot.example/api/v1");
    expect(apiTransportBase("http://localhost:8090/api/v1", "http://localhost:3000")).toBe("http://localhost:8090/api/v1");
    expect(socketTransportBase("wss://api.pilot.example", "https://pilot.example")).toBe("wss://api.pilot.example");
  });
});
