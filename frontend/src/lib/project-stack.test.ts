import { describe, expect, it } from "vitest";
import { environmentBranchLabel, stackComponentLabel, stackIconComponents, type ProjectStack, type StackComponent } from "./project-stack";

const component = (id: string, role: StackComponent["role"], kind: StackComponent["kind"] = "framework"): StackComponent => ({ id, role, kind, name: id, evidence: ["package.json"] });
const stack = (components: StackComponent[]): ProjectStack => ({ components, status: "detected", manifests: [], files_scanned: 0, truncated: false, message: "", method: "manifests" });
describe("project stack labels", () => {
  it("distinguishes database clients from declared database services", () => {
    expect(stackComponentLabel(component("PostgreSQL", "database", "client"))).toBe("PostgreSQL · Database client");
    expect(stackComponentLabel(component("PostgreSQL", "database", "service"))).toBe("PostgreSQL · Database");
  });
  it("shows one icon per technology, favors the actual declared service, and orders by role", () => {
    const icons = stackIconComponents(stack([component("node", "runtime", "runtime"), component("pg", "database", "client"), component("express", "backend"), component("next", "frontend"), component("pg", "database", "service")]));
    expect(icons.map(item => item.id)).toEqual(["next", "express", "pg", "node"]);
    expect(icons[2].kind).toBe("service");
  });
  it("preserves real branches and makes default/image branches readable", () => {
    expect(environmentBranchLabel("HEAD")).toBe("Repository default");
    expect(environmentBranchLabel("application")).toBe("Application image");
    expect(environmentBranchLabel("trunk")).toBe("trunk");
    expect(stackIconComponents()).toEqual([]);
  });
});
